import {
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
} from '@stellar/stellar-sdk';

export interface SequenceNumberCacheOptions {
  /**
   * Time-to-live for cached sequence numbers in milliseconds.
   * Entries older than this are considered stale and will be refetched.
   * Defaults to 30_000 (30 seconds).
   */
  ttlMs?: number;
}

interface CachedSequence {
  sequence: string;
  updatedAt: number;
}

/**
 * Caches Stellar account sequence numbers per account and increments them
 * locally after each transaction submission to reduce Horizon API calls.
 */
export class SequenceNumberCache {
  private readonly ttlMs: number;
  private readonly cache: Map<string, CachedSequence> = new Map();

  constructor(options: SequenceNumberCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  /**
   * Returns the cached sequence number for an account if present and fresh,
   * otherwise fetches it from Horizon and stores it.
   */
  async get(accountId: string, horizon: Horizon.Server): Promise<string> {
    const cached = this.cache.get(accountId);
    if (cached && !this.isStale(cached)) {
      return cached.sequence;
    }

    const account = await horizon.loadAccount(accountId);
    const sequence = account.sequenceNumber();
    this.cache.set(accountId, { sequence, updatedAt: Date.now() });
    return sequence;
  }

  /**
   * Increments the cached sequence number for an account locally after a
   * successful transaction submission.
   */
  increment(accountId: string): void {
    const cached = this.cache.get(accountId);
    if (!cached) {
      return;
    }

    const next = (BigInt(cached.sequence) + 1n).toString();
    this.cache.set(accountId, { sequence: next, updatedAt: Date.now() });
  }

  /**
   * Removes a cached sequence number, forcing a refetch on next access.
   */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  /**
   * Clears all cached sequence numbers.
   */
  clear(): void {
    this.cache.clear();
  }

  private isStale(entry: CachedSequence): boolean {
    return Date.now() - entry.updatedAt > this.ttlMs;
  }
}

export interface StellarClientOptions {
  /**
   * Optional sequence number cache. When provided, the client will use it to
   * avoid redundant Horizon `loadAccount` calls.
   */
  sequenceCache?: SequenceNumberCache;
}

export class StellarClient {
  public readonly horizon: Horizon.Server;
  private readonly sequenceCache?: SequenceNumberCache;

  constructor(
    horizonUrl: string = 'https://horizon-testnet.stellar.org',
    options: StellarClientOptions = {},
  ) {
    this.horizon = new Horizon.Server(horizonUrl);
    this.sequenceCache = options.sequenceCache;
  }

  /**
   * Loads the current sequence number for an account, using the cache when
   * configured.
   */
  async getSequenceNumber(accountId: string): Promise<string> {
    if (this.sequenceCache) {
      return this.sequenceCache.get(accountId, this.horizon);
    }

    const account = await this.horizon.loadAccount(accountId);
    return account.sequenceNumber();
  }

  /**
   * Builds a transaction for the given source account, using the cached
   * sequence number when available.
   */
  async buildTransaction(
    sourceAccountId: string,
    operations: Operation[],
    options: { memo?: Memo; fee?: string; networkPassphrase?: string } = {},
  ): Promise<TransactionBuilder> {
    const sequence = await this.getSequenceNumber(sourceAccountId);
    const account = new Account(sourceAccountId, sequence);

    const builder = new TransactionBuilder(account, {
      fee: options.fee ?? BASE_FEE,
      memo: options.memo,
      networkPassphrase: options.networkPassphrase ?? Networks.TESTNET,
    });

    for (const operation of operations) {
      builder.addOperation(operation);
    }

    return builder;
  }

  /**
   * Submits a signed transaction and, when a cache is configured, increments
   * the cached sequence number locally.
   */
  async submitTransaction(
    transaction: ReturnType<TransactionBuilder['build']>,
    sourceAccountId: string,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    const response = await this.horizon.submitTransaction(transaction);
    this.sequenceCache?.increment(sourceAccountId);
    return response;
  }
}

export {
  StreamClient,
  type StreamClientOptions,
  type StreamEvent,
  type StreamEventType,
  type StreamStatus,
  type StreamStatusEvent,
  type StreamSubscription,
  type StreamTopic,
} from './stream.js';

export interface SponsoredAccountResult {
  publicKey: string;
  secretKey: string;
}

/**
 * Creates a sponsored Stellar account using the provided sponsor keypair.
 */
export async function createSponsoredAccount(
  client: StellarClient,
  sponsor: Keypair,
  startingBalance: string = '1',
): Promise<SponsoredAccountResult> {
  const newAccount = Keypair.random();

  const builder = await client.buildTransaction(sponsor.publicKey(), [
    Operation.createAccount({
      destination: newAccount.publicKey(),
      startingBalance,
    }),
  ]);

  const transaction = builder.setTimeout(180).build();
  transaction.sign(sponsor);

  await client.submitTransaction(transaction, sponsor.publicKey());

  return {
    publicKey: newAccount.publicKey(),
    secretKey: newAccount.secret(),
  };
}

/**
 * Sets up multisig on an account by adding signers and thresholds.
 */
export async function setupMultisig(
  client: StellarClient,
  source: Keypair,
  signers: { publicKey: string; weight: number }[],
  thresholds: { low: number; medium: number; high: number },
): Promise<void> {
  const operations: Operation[] = signers.map((signer) =>
    Operation.setOptions({
      signer: {
        ed25519PublicKey: signer.publicKey,
        weight: signer.weight,
      },
    }),
  );

  operations.push(
    Operation.setOptions({
      lowThreshold: thresholds.low,
      medThreshold: thresholds.medium,
      highThreshold: thresholds.high,
    }),
  );

  const builder = await client.buildTransaction(source.publicKey(), operations);
  const transaction = builder.setTimeout(180).build();
  transaction.sign(source);

  await client.submitTransaction(transaction, source.publicKey());
}

export interface WalletSendOptions {
  memo?: Memo;
  asset?: Asset;
}

/**
 * Sends a payment from a wallet using the provided StellarClient.
 */
export async function send(
  client: StellarClient,
  source: Keypair,
  destination: string,
  amount: string,
  options: WalletSendOptions = {},
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  const builder = await client.buildTransaction(
    source.publicKey(),
    [
      Operation.payment({
        destination,
        asset: options.asset ?? Asset.native(),
        amount,
      }),
    ],
    { memo: options.memo },
  );

  const transaction = builder.setTimeout(180).build();
  transaction.sign(source);

  return client.submitTransaction(transaction, source.publicKey());
}
