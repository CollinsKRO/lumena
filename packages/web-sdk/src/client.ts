import { Keypair, Asset, TransactionBuilder, Address, xdr, scValToNative } from "@stellar/stellar-sdk";
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

  /** Returns the sequence number of the latest ledger known to Soroban RPC. */
  async getLatestLedger(): Promise<number> {
    const { sequence } = await this.client.rpc.getLatestLedger();
    return sequence;
  }

  /**
   * Reads the expiration ledger of a SEP-41 token allowance from the token
   * contract's temporary storage. Returns `null` when no allowance entry exists.
   */
  async getAllowanceExpirationLedger(
    tokenAddress: string,
    from: string,
    spender: string,
  ): Promise<number | null> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(tokenAddress).toScAddress(),
        key: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Allowance"),
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("from"), val: new Address(from).toScVal() }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("spender"), val: new Address(spender).toScVal() }),
          ]),
        ]),
        durability: xdr.ContractDataDurability.temporary(),
      }),
    );

    const { entries } = await this.client.rpc.getLedgerEntries(key);
    const entry = entries[0];
    if (!entry) return null;

    const value = scValToNative(entry.val.contractData().val()) as { expiration_ledger?: number };
    return value.expiration_ledger ?? null;
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
