import { Keypair, Asset, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  StellarClient,
  Wallet,
  KNOWN_ASSETS,
  PasskeyManager,
  type PasskeyRegistrationOpts,
} from "@lumen/core";
import type { StellarNetwork, ContractSimulationResult, ScValInput } from "@lumen/types";

export interface LumenClientOpts {
  network?: StellarNetwork;
  horizonUrl?: string;
  rpcUrl?: string;
  serverUrl: string;
  /**
   * @deprecated Storing the sponsor secret key in browser environments is a
   * severe security vulnerability. This field is ignored and will be removed
   * in a future release. Account sponsorship is now handled exclusively by
   * calling the backend REST endpoints (POST /wallet/create, POST /fee-bump/submit).
   */
  sponsorSecret?: string;
  serverPublicKey: string;
  /** Optional API key sent as `Authorization: Bearer <apiKey>` on every request. */
  apiKey?: string;
  /** Optional extra headers merged into every outgoing request. */
  headers?: Record<string, string>;
}

export interface SessionKeyInfo {
  keypair: Keypair;
  publicKey: string;
  secretKey: string;
  expiresAt: number;
}

export interface PasskeyWalletResult {
  address: string;
  id: string;
  credentialId: string;
  keypair: Keypair;
}

export function createSessionKey(durationSeconds: number = 3600): SessionKeyInfo {
  const keypair = Keypair.random();
  const expiresAt = Date.now() + durationSeconds * 1000;
  return {
    keypair,
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
    expiresAt,
  };
}

export class LumenClient {
  private client: StellarClient;
  private serverPublicKey: string;
  private serverUrl: string;
  private defaultHeaders: Record<string, string>;
  private wallets: Map<string, Wallet> = new Map();

  constructor(opts: LumenClientOpts) {
    if (opts.sponsorSecret !== undefined) {
      console.warn(
        "[LumenClient] The `sponsorSecret` option is deprecated and has no effect. " +
          "Storing sponsor secret keys in browser environments is a severe security vulnerability. " +
          "Account creation and fee sponsorship are now handled exclusively by backend REST endpoints. " +
          "Please remove `sponsorSecret` from your LumenClientOpts.",
      );
    }

    this.client = new StellarClient({
      network: opts.network,
      horizonUrl: opts.horizonUrl,
      rpcUrl: opts.rpcUrl,
    });
    this.serverPublicKey = opts.serverPublicKey;
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");

    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      ...opts.headers,
    };
  }

  /**
   * Makes an authenticated HTTP request to the configured serverUrl.
   * All headers (including Authorization) are merged from defaultHeaders.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: this.defaultHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  createSessionKey(durationSeconds: number = 3600): SessionKeyInfo {
    return createSessionKey(durationSeconds);
  }

  /**
   * Creates a new sponsored wallet by calling POST /wallet/create on the
   * backend server. No sponsor secret key is required in the browser.
   */
  async createWallet(): Promise<{ address: string; id: string }> {
    const result = await this.request<{ address: string; id?: string }>(
      "POST",
      "/wallet/create",
    );

    // Build a client-side Wallet instance (for balance/send operations) backed
    // by the address returned from the server. The wallet does not need a
    // sponsorKeypair — it calls the server for co-signing and fee-bumping.
    const wallet = new Wallet({
      client: this.client,
      serverPublicKey: this.serverPublicKey,
      serverUrl: this.serverUrl,
    });
    // Restore the address from the server response so balance/send work.
    (wallet as any)._address = result.address;

    const id = result.id ?? result.address;
    this.wallets.set(id, wallet);

    return { address: result.address, id };
  }

  async createWalletWithPasskey(opts?: PasskeyRegistrationOpts): Promise<PasskeyWalletResult> {
    const passkeyManager = new PasskeyManager();
    const username = opts?.username ?? `user-${Date.now()}`;
    const { credentialId, keypair } = await passkeyManager.registerPasskey({
      username,
      rpName: opts?.rpName,
      challenge: opts?.challenge,
    });

    // Register the passkey-derived public key with the server so it can set up
    // multisig and sponsor the account without the client holding the sponsor key.
    const result = await this.request<{ address: string; id?: string }>(
      "POST",
      "/wallet/create",
      { ownerPublicKey: keypair.publicKey() },
    );

    const wallet = new Wallet({
      client: this.client,
      serverPublicKey: this.serverPublicKey,
      serverUrl: this.serverUrl,
      ownerKeypair: keypair,
    });
    (wallet as any)._address = result.address;

    const id = result.id ?? result.address;
    this.wallets.set(id, wallet);

    return { address: result.address, id, credentialId, keypair };
  }

  async signWithPasskey(opts: {
    credentialId?: string;
    transactionXdr: string;
    username?: string;
  }): Promise<{ signedXdr: string; publicKey: string }> {
    const passkeyManager = new PasskeyManager();
    const { keypair } = await passkeyManager.authenticatePasskey({
      credentialId: opts.credentialId,
      username: opts.username,
    });

    const tx = TransactionBuilder.fromXDR(opts.transactionXdr, this.client.networkPassphrase);
    tx.sign(keypair);

    return {
      signedXdr: tx.toXDR(),
      publicKey: keypair.publicKey(),
    };
  }

  getWallet(id: string): Wallet | undefined {
    return this.wallets.get(id);
  }

  /**
   * Imports an existing wallet from a Stellar secret key.
   *
   * @param secretKey - the Stellar secret key (starts with `S`)
   * @returns the wallet address and id
   */
  async importWallet(secretKey: string): Promise<{ address: string; id: string }> {
    if (typeof secretKey !== "string" || !secretKey.startsWith("S")) {
      throw new Error(
        "Invalid secret key: expected a Stellar secret key starting with 'S'.",
      );
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secretKey);
    } catch (err) {
      throw new Error(
        `Invalid secret key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const address = keypair.publicKey();
    const wallet = new Wallet({
      client: this.client,
      serverPublicKey: this.serverPublicKey,
      serverUrl: this.serverUrl,
      ownerKeypair: keypair,
    });
    (wallet as any)._address = address;

    const id = address;
    this.wallets.set(id, wallet);

    return { address, id };
  }

  /**
   * Exports the Stellar secret key for the given wallet so the user can back
   * it up. The returned value starts with `S`.
   *
   * @param id - wallet id
   */
  async exportWallet(id: string): Promise<string> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    const keypair = (wallet as any).ownerKeypair as Keypair | undefined;
    if (!keypair) {
      throw new Error(
        `Wallet ${id} has no exportable secret key (it may be server-sponsored or passkey-backed).`,
      );
    }

    return keypair.secret();
  }

  /**
   * Returns the transaction history for the given wallet.
   *
   * When `serverUrl` is configured, queries
   * `GET /wallet/:address/transactions` on the backend; otherwise falls back
   * to Horizon via `client.horizon.transactions().forAccount(address)`.
   */
  async getTransactions(
    walletId: string,
    opts?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<any[]> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error(`Wallet not found: ${walletId}`);

    const address = (wallet as any)._address as string | undefined;
    if (!address) {
      throw new Error(`Unable to resolve address for wallet: ${walletId}`);
    }

    if (this.serverUrl) {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
      if (opts?.order !== undefined) params.set("order", opts.order);
      const query = params.toString();
      const path = `/wallet/${encodeURIComponent(address)}/transactions${query ? `?${query}` : ""}`;

      const result = await this.request<any>("GET", path);
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.records)) return result.records;
      return [];
    }

    let builder = this.client.horizon.transactions().forAccount(address);
    if (opts?.limit !== undefined) builder = builder.limit(opts.limit);
    if (opts?.cursor !== undefined) builder = builder.cursor(opts.cursor);
    if (opts?.order !== undefined) builder = builder.order(opts.order);

    const page = await builder.call();
    return page.records;
  }

  async getBalance(id: string, assetCode?: string): Promise<string> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    if (!assetCode || assetCode === "XLM") {
      return wallet.getBalance();
    }

    const network = this.client.config.network;
    const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
    if (!knownAsset) {
      throw new Error(
        `Unknown asset: ${assetCode}. Known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
      );
    }

    return wallet.getBalance(knownAsset);
  }

  async sendPayment(
    id: string,
    destination: string,
    assetCode: string,
    amount: string,
  ): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    let asset: Asset;
    if (assetCode === "XLM") {
      asset = Asset.native();
    } else {
      const network = this.client.config.network;
      const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
      if (!knownAsset) {
        throw new Error(
          `Unknown asset: ${assetCode}. Known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
        );
      }
      asset = knownAsset;
    }

    return wallet.send(destination, asset, amount);
  }

  async simulateContract(
    id: string,
    contractId: string,
    method: string,
    args?: ScValInput[],
  ): Promise<ContractSimulationResult> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);
    return wallet.simulateContract(contractId, method, args);
  }

  async invokeContract(
    id: string,
    contractId: string,
    method: string,
    args?: ScValInput[],
    fee?: string,
  ): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);
    return wallet.invokeContract(contractId, method, args, fee);
  }

  /**
   * Establish or modify a trustline for the given wallet.
   *
   * The asset is resolved in this order:
   *   1. If `assetCode` contains a colon (e.g. `"USDC:G..."`), it is parsed
   *      as `<code>:<issuer>` directly.
   *   2. Otherwise, `KNOWN_ASSETS[network][assetCode]` is looked up.
   *
   * Pass `limit = '0'` to remove the trustline.
   *
   * @param id        - wallet id (account address)
   * @param assetCode - the asset code (e.g. `'USDC'`) or a `'CODE:ISSUER'` string
   * @param limit     - maximum balance limit (omit for default; `'0'` to remove)
   */
  async changeTrust(id: string, assetCode: string, limit?: string): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    let asset: Asset;

    if (assetCode.includes(":")) {
      // Custom asset passed as "CODE:ISSUER"
      const [code, issuer] = assetCode.split(":", 2) as [string, string];
      asset = new Asset(code, issuer);
    } else {
      const network = this.client.config.network;
      const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
      if (!knownAsset) {
        throw new Error(
          `Unknown asset: ${assetCode}. Pass as 'CODE:ISSUER' or use one of the known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
        );
      }
      asset = knownAsset;
    }

    return wallet.changeTrust(asset, limit);
  }

  /**
   * Generic HTTP GET against the configured serverUrl.
   * Used by hooks that need to query server-side endpoints directly.
   */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
}

export async function createWalletWithPasskey(
  client: LumenClient,
  opts?: PasskeyRegistrationOpts,
): Promise<PasskeyWalletResult> {
  return client.createWalletWithPasskey(opts);
}

export async function signWithPasskey(
  client: LumenClient,
  opts: { credentialId?: string; transactionXdr: string; username?: string },
): Promise<{ signedXdr: string; publicKey: string }> {
  return client.signWithPasskey(opts);
}
