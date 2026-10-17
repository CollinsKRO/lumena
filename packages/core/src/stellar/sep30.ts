/**
 * SEP-0030 Web3 Account Recovery Protocol Client
 *
 * Implements the Stellar Ecosystem Proposal 30 (SEP-0030) client interface for
 * multi-party account key recovery using identity verification providers.
 *
 * The protocol allows a user to register multiple authentication identities
 * with a recovery server so that, if the user loses their signing key, they
 * can recover ownership of their Stellar account by authenticating through
 * those registered identity providers.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md
 */

import { Keypair, Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types and interfaces
// ---------------------------------------------------------------------------

/** Supported identity provider types as defined in SEP-0030. */
export type Sep30IdentityType = "stellar_address" | "phone_number" | "email" | string;

/**
 * A single authentication method within an identity (e.g. OTP, TOTP, webauthn).
 */
export interface Sep30AuthMethod {
  type: string;
  value?: string;
}

/**
 * An identity registered with a SEP-0030 recovery server.
 */
export interface Sep30Identity {
  /** The type of identity provider (e.g. "stellar_address", "phone_number"). */
  role: string;
  /** Authentication methods this identity supports. */
  auth_methods: Sep30AuthMethod[];
}

/**
 * Request body for registering or updating identities on a SEP-0030 server.
 */
export interface Sep30RegisterRequest {
  identities: Sep30Identity[];
}

/**
 * Response from a SEP-0030 registration or account query.
 */
export interface Sep30AccountResponse {
  address: string;
  identities: Sep30RegisteredIdentity[];
  signers: Sep30Signer[];
}

/**
 * A registered identity as returned by the recovery server.
 */
export interface Sep30RegisteredIdentity {
  role: string;
  authenticated?: boolean;
}

/**
 * A co-signer entry in the SEP-0030 account response.
 */
export interface Sep30Signer {
  key: string;
}

/**
 * A transaction envelope returned by the SEP-0030 `/accounts/:address/sign` endpoint.
 */
export interface Sep30SignResponse {
  /** The XDR-encoded, partially-signed transaction returned by the recovery signer. */
  signature: string;
  network_passphrase?: string;
}

/**
 * Request body sent to the recovery server's sign endpoint.
 */
export interface Sep30SignRequest {
  /** Base64-encoded XDR transaction envelope that needs the recovery server's signature. */
  transaction: string;
}

/**
 * Options for initiating an account recovery request.
 */
export interface Sep30RecoveryOpts {
  /** The Stellar account address (G...) being recovered. */
  address: string;
  /** The new signing public key to replace the lost key. */
  newSignerPublicKey: string;
  /** A JWT obtained after authenticating through a registered identity provider. */
  authToken: string;
  /** Optional network passphrase (defaults to Stellar Testnet). */
  networkPassphrase?: string;
}

/**
 * Options for authenticating through a recovery server identity.
 */
export interface Sep30AuthOpts {
  /**
   * The account address being recovered.
   */
  address: string;
  /**
   * JWT or one-time-code from the identity provider used to authenticate.
   * This is attached as `Authorization: Bearer <authToken>` to the request.
   */
  authToken: string;
}

/**
 * Options for constructing a `Sep30Client`.
 */
export interface Sep30ClientOpts {
  /**
   * Base URL of the SEP-0030 recovery server
   * (e.g. `"https://recovery.example.com"`).
   */
  serverUrl: string;
  /**
   * Default network passphrase used when building transactions.
   * Defaults to Stellar Testnet.
   */
  networkPassphrase?: string;
  /**
   * Optional extra HTTP headers merged into every request
   * (e.g. API key, user-agent).
   */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sep30Client
// ---------------------------------------------------------------------------

/**
 * Client for the SEP-0030 Account Recovery protocol.
 *
 * Typical recovery flow:
 *  1. `register(address, { identities: [...] }, authToken)` — register the
 *     account and its recovery identities at onboarding time.
 *  2. User loses their key.
 *  3. User authenticates with the recovery server through their registered
 *     identity provider to obtain a JWT.
 *  4. `recover(opts)` — submit a transaction that rotates the signing key.
 *     The server signs it after verifying the auth token.
 *  5. Broadcast the returned signed transaction to complete recovery.
 *
 * @example
 * ```ts
 * const recovery = new Sep30Client({ serverUrl: "https://recovery.example.com" });
 *
 * // Register at wallet creation time
 * await recovery.register(
 *   "GABC...XYZ",
 *   { identities: [{ role: "owner", auth_methods: [{ type: "stellar_address", value: "GABC...XYZ" }] }] },
 *   jwtFromSep10,
 * );
 *
 * // Later — recover the account
 * const signed = await recovery.recover({
 *   address: "GABC...XYZ",
 *   newSignerPublicKey: newKeypair.publicKey(),
 *   authToken: jwtFromIdentityProvider,
 * });
 * await horizon.submitTransaction(TransactionBuilder.fromXDR(signed, Networks.TESTNET));
 * ```
 */
export class Sep30Client {
  private readonly serverUrl: string;
  private readonly networkPassphrase: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: Sep30ClientOpts) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...opts.headers,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private authHeaders(authToken: string): Record<string, string> {
    return { ...this.defaultHeaders, Authorization: `Bearer ${authToken}` };
  }

  private async request<T>(
    method: string,
    path: string,
    authToken: string,
    body?: unknown,
  ): Promise<T> {
    const headers = this.authHeaders(authToken);
    const res = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      let message: string;
      try {
        const err = (await res.json()) as Record<string, unknown>;
        message = String(err["error"] ?? err["message"] ?? res.statusText);
      } catch {
        message = await res.text().catch(() => res.statusText);
      }
      throw new Error(`SEP-0030 ${method} ${path} failed (${res.status}): ${message}`);
    }

    // 204 No Content
    if (res.status === 204) return undefined as unknown as T;

    return res.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Registers a Stellar account with the recovery server along with the
   * identities that can be used to authenticate future recovery requests.
   *
   * Corresponds to `PUT /accounts/:address` in the SEP-0030 spec.
   *
   * @param address   - The Stellar account address to register.
   * @param request   - Identity list for this account.
   * @param authToken - JWT issued by the recovery server's own auth flow (e.g. SEP-10).
   */
  async register(
    address: string,
    request: Sep30RegisterRequest,
    authToken: string,
  ): Promise<Sep30AccountResponse> {
    return this.request<Sep30AccountResponse>(
      "PUT",
      `/accounts/${encodeURIComponent(address)}`,
      authToken,
      request,
    );
  }

  /**
   * Retrieves the registration details for an account on the recovery server.
   *
   * Corresponds to `GET /accounts/:address` in the SEP-0030 spec.
   *
   * @param address   - The Stellar account address.
   * @param authToken - Auth token for the request.
   */
  async getAccount(address: string, authToken: string): Promise<Sep30AccountResponse> {
    return this.request<Sep30AccountResponse>(
      "GET",
      `/accounts/${encodeURIComponent(address)}`,
      authToken,
    );
  }

  /**
   * Removes the account registration from the recovery server.
   *
   * Corresponds to `DELETE /accounts/:address`.
   *
   * @param address   - The Stellar account address.
   * @param authToken - Auth token with sufficient permissions.
   */
  async deleteAccount(address: string, authToken: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/accounts/${encodeURIComponent(address)}`,
      authToken,
    );
  }

  /**
   * Lists all accounts registered by the authenticated caller.
   *
   * Corresponds to `GET /accounts` in the SEP-0030 spec.
   *
   * @param authToken - Auth token for the request.
   * @param after     - Optional cursor for pagination (account address).
   */
  async listAccounts(
    authToken: string,
    after?: string,
  ): Promise<{ accounts: Sep30AccountResponse[] }> {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    return this.request<{ accounts: Sep30AccountResponse[] }>(
      "GET",
      `/accounts${query}`,
      authToken,
    );
  }

  /**
   * Asks the recovery server to co-sign a transaction for key rotation.
   *
   * The caller should build a `setOptions` transaction that adds `newSignerKey`
   * and removes the old lost key, sign it with any available keys, then pass
   * the XDR here. The server verifies the caller's auth token, checks that the
   * signer key corresponds to a registered identity, and appends its signature.
   *
   * Corresponds to `POST /accounts/:address/sign/:signerKey`.
   *
   * @param address   - The account being recovered.
   * @param signerKey - The recovery server's signer public key (from `getAccount`).
   * @param xdr       - Base64-encoded XDR transaction envelope to be signed.
   * @param authToken - JWT from the identity provider proving identity.
   */
  async requestSignature(
    address: string,
    signerKey: string,
    xdr: string,
    authToken: string,
  ): Promise<Sep30SignResponse> {
    const body: Sep30SignRequest = { transaction: xdr };
    return this.request<Sep30SignResponse>(
      "POST",
      `/accounts/${encodeURIComponent(address)}/sign/${encodeURIComponent(signerKey)}`,
      authToken,
      body,
    );
  }

  /**
   * High-level convenience method: performs the full key-rotation recovery
   * flow using the recovery server as a co-signer.
   *
   * Steps:
   *  1. Fetch the account's registered signers from the recovery server.
   *  2. Build a `setOptions` transaction that adds `newSignerPublicKey` with
   *     weight 1 (the caller should subsequently run their own `setOptions` to
   *     remove the old lost key or adjust thresholds as needed).
   *  3. Submit the unsigned XDR to each of the server's registered signer keys
   *     via `requestSignature`.
   *  4. Return the co-signed transaction XDR ready for broadcast.
   *
   * @param opts - Recovery options.
   * @returns The XDR string of the co-signed transaction.
   */
  async recover(opts: Sep30RecoveryOpts): Promise<string> {
    const networkPassphrase = opts.networkPassphrase ?? this.networkPassphrase;

    // Step 1: resolve the recovery server's signer keys
    const accountInfo = await this.getAccount(opts.address, opts.authToken);

    if (!accountInfo.signers || accountInfo.signers.length === 0) {
      throw new Error(
        `SEP-0030 recover: no recovery signers registered for account ${opts.address}`,
      );
    }

    // Step 2: build the key-rotation transaction
    const { Operation, TransactionBuilder: TxBuilder, BASE_FEE, Account } =
      await import("@stellar/stellar-sdk");

    // We need the current sequence number — use a placeholder account since we
    // don't have Horizon access here. Callers that need an accurate sequence
    // number should build and pass their own XDR via requestSignature directly.
    const sourceAccount = new Account(opts.address, "0");

    const tx = new TxBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: opts.newSignerPublicKey,
            weight: 1,
          },
        }),
      )
      .setTimeout(300)
      .build();

    let xdr = tx.toXDR();

    // Step 3: collect co-signatures from each registered recovery signer
    let signedTx: Transaction | null = null;

    for (const signer of accountInfo.signers) {
      try {
        const response = await this.requestSignature(
          opts.address,
          signer.key,
          xdr,
          opts.authToken,
        );

        // Merge the server's signature into the transaction envelope
        const serverPassphrase = response.network_passphrase ?? networkPassphrase;
        const partialTx = TransactionBuilder.fromXDR(response.signature, serverPassphrase);
        if (signedTx === null) {
          signedTx = partialTx as Transaction;
        } else {
          // Copy signatures from server response into accumulated tx
          for (const sig of (partialTx as Transaction).signatures) {
            signedTx.signatures.push(sig);
          }
        }

        // Update xdr for the next signer iteration
        xdr = signedTx.toXDR();
      } catch (err) {
        // Non-fatal: one signer failing doesn't preclude others succeeding
        console.warn(
          `SEP-0030 recover: signer ${signer.key} failed to sign — ${(err as Error).message}`,
        );
      }
    }

    if (!signedTx) {
      throw new Error(
        "SEP-0030 recover: none of the registered recovery signers returned a valid signature",
      );
    }

    return signedTx.toXDR();
  }
}
