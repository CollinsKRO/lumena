import type { Account, Keypair, Transaction, FeeBumpTransaction, xdr } from "@stellar/stellar-sdk";
import { TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * Typed error thrown when transaction building input validation fails.
 *
 * The fuzz harness relies on these typed errors so that malformed input
 * results in a controlled failure (fail closed) rather than an unhandled
 * panic bubbling up from the Stellar SDK.
 */
export class TransactionBuildError extends Error {
  public readonly code: TransactionBuildErrorCode;
  public readonly cause?: unknown;

  constructor(code: TransactionBuildErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TransactionBuildError";
    this.code = code;
    this.cause = cause;
    // Restore prototype chain for environments that down-level `extends Error`.
    Object.setPrototypeOf(this, TransactionBuildError.prototype);
  }
}

export type TransactionBuildErrorCode =
  | "INVALID_OPERATIONS"
  | "INVALID_BASE_FEE"
  | "INVALID_NETWORK_PASSPHRASE"
  | "INVALID_TIMEOUT"
  | "INVALID_SOURCE_ACCOUNT"
  | "INVALID_FEE_PAYER"
  | "INVALID_INNER_TRANSACTION"
  | "BUILD_FAILED";

const MAX_BASE_FEE = "9223372036854775807"; // i64 max, upper bound for Stellar fees.

/**
 * Validates a base fee string. Must be a positive integer string within i64 range.
 */
function validateBaseFee(baseFee: unknown): string {
  if (typeof baseFee !== "string") {
    throw new TransactionBuildError(
      "INVALID_BASE_FEE",
      `baseFee must be a string, received ${typeof baseFee}`,
    );
  }

  const trimmed = baseFee.trim();
  if (trimmed.length === 0 || !/^[0-9]+$/.test(trimmed)) {
    throw new TransactionBuildError(
      "INVALID_BASE_FEE",
      `baseFee must be a positive integer string, received "${baseFee}"`,
    );
  }

  // Reject leading-zero padded values that could confuse downstream parsers.
  if (trimmed.length > 1 && trimmed.startsWith("0")) {
    throw new TransactionBuildError(
      "INVALID_BASE_FEE",
      `baseFee must not have leading zeros, received "${baseFee}"`,
    );
  }

  // Compare against i64 max without relying on Number precision.
  if (
    trimmed.length > MAX_BASE_FEE.length ||
    (trimmed.length === MAX_BASE_FEE.length && trimmed > MAX_BASE_FEE)
  ) {
    throw new TransactionBuildError(
      "INVALID_BASE_FEE",
      `baseFee exceeds maximum supported value, received "${baseFee}"`,
    );
  }

  if (trimmed === "0") {
    throw new TransactionBuildError(
      "INVALID_BASE_FEE",
      `baseFee must be greater than zero, received "${baseFee}"`,
    );
  }

  return trimmed;
}

/**
 * Validates a network passphrase. Must be a non-empty string.
 */
function validateNetworkPassphrase(networkPassphrase: unknown): string {
  if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
    throw new TransactionBuildError(
      "INVALID_NETWORK_PASSPHRASE",
      "networkPassphrase must be a non-empty string",
    );
  }
  return networkPassphrase;
}

/**
 * Validates a timeout. Must be a positive, finite integer.
 */
function validateTimeout(timeout: unknown): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    throw new TransactionBuildError(
      "INVALID_TIMEOUT",
      `timeout must be a finite number, received ${String(timeout)}`,
    );
  }
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new TransactionBuildError(
      "INVALID_TIMEOUT",
      `timeout must be a positive integer, received ${String(timeout)}`,
    );
  }
  return timeout;
}

/**
 * Validates the operations array. Must be an array of operation-like objects.
 */
function validateOperations(operations: unknown): xdr.Operation[] {
  if (!Array.isArray(operations)) {
    throw new TransactionBuildError(
      "INVALID_OPERATIONS",
      `operations must be an array, received ${typeof operations}`,
    );
  }
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op === null || typeof op !== "object") {
      throw new TransactionBuildError(
        "INVALID_OPERATIONS",
        `operations[${i}] must be an object, received ${op === null ? "null" : typeof op}`,
      );
    }
  }
  return operations as xdr.Operation[];
}

/**
 * Validates a source account. Must be a non-null object exposing an account id.
 */
function validateSourceAccount(sourceAccount: unknown): Account {
  if (sourceAccount === null || typeof sourceAccount !== "object") {
    throw new TransactionBuildError(
      "INVALID_SOURCE_ACCOUNT",
      `sourceAccount must be an object, received ${sourceAccount === null ? "null" : typeof sourceAccount}`,
    );
  }
  const accountId = (sourceAccount as { accountId?: unknown }).accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new TransactionBuildError(
      "INVALID_SOURCE_ACCOUNT",
      "sourceAccount must expose a non-empty accountId string",
    );
  }
  return sourceAccount as Account;
}

/**
 * Validates a fee payer keypair. Must be a non-null object exposing a public key.
 */
function validateFeePayerKeypair(feePayerKeypair: unknown): Keypair {
  if (feePayerKeypair === null || typeof feePayerKeypair !== "object") {
    throw new TransactionBuildError(
      "INVALID_FEE_PAYER",
      `feePayerKeypair must be an object, received ${feePayerKeypair === null ? "null" : typeof feePayerKeypair}`,
    );
  }
  const publicKey = (feePayerKeypair as { publicKey?: unknown }).publicKey;
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    throw new TransactionBuildError(
      "INVALID_FEE_PAYER",
      "feePayerKeypair must expose a non-empty publicKey string",
    );
  }
  return feePayerKeypair as Keypair;
}

/**
 * Validates the inner transaction. Must be a non-null object exposing `toXDR`.
 */
function validateInnerTransaction(innerTransaction: unknown): Transaction {
  if (innerTransaction === null || typeof innerTransaction !== "object") {
    throw new TransactionBuildError(
      "INVALID_INNER_TRANSACTION",
      `innerTransaction must be an object, received ${innerTransaction === null ? "null" : typeof innerTransaction}`,
    );
  }
  const toXDR = (innerTransaction as { toXDR?: unknown }).toXDR;
  if (typeof toXDR !== "function") {
    throw new TransactionBuildError(
      "INVALID_INNER_TRANSACTION",
      "innerTransaction must expose a toXDR() method",
    );
  }
  return innerTransaction as Transaction;
}

export interface BuildFeeBumpOpts {
  feePayerKeypair: Keypair;
  innerTransaction: Transaction;
  baseFee?: string;
  networkPassphrase: string;
}

export function buildFeeBump(opts: BuildFeeBumpOpts): FeeBumpTransaction {
  if (opts === null || typeof opts !== "object") {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `buildFeeBump options must be an object, received ${opts === null ? "null" : typeof opts}`,
    );
  }

  const {
    feePayerKeypair,
    innerTransaction,
    baseFee = "1000000",
    networkPassphrase,
  } = opts;

  const validatedKeypair = validateFeePayerKeypair(feePayerKeypair);
  const validatedInner = validateInnerTransaction(innerTransaction);
  const validatedBaseFee = validateBaseFee(baseFee);
  const validatedPassphrase = validateNetworkPassphrase(networkPassphrase);

  let feeBump: FeeBumpTransaction;
  try {
    feeBump = TransactionBuilder.buildFeeBumpTransaction(
      validatedKeypair,
      validatedBaseFee,
      validatedInner,
      validatedPassphrase,
    );
  } catch (err) {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `Failed to build fee bump transaction: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  try {
    feeBump.sign(validatedKeypair);
  } catch (err) {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `Failed to sign fee bump transaction: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return feeBump;
}

export interface BuildTransactionOpts {
  sourceAccount: Account;
  operations: xdr.Operation[];
  baseFee?: string;
  networkPassphrase: string;
  timeout?: number;
}

export function buildTransaction(opts: BuildTransactionOpts): Transaction {
  if (opts === null || typeof opts !== "object") {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `buildTransaction options must be an object, received ${opts === null ? "null" : typeof opts}`,
    );
  }

  const {
    sourceAccount,
    operations,
    baseFee = "100",
    networkPassphrase,
    timeout = 180,
  } = opts;

  const validatedAccount = validateSourceAccount(sourceAccount);
  const validatedOperations = validateOperations(operations);
  const validatedBaseFee = validateBaseFee(baseFee);
  const validatedPassphrase = validateNetworkPassphrase(networkPassphrase);
  const validatedTimeout = validateTimeout(timeout);

  let builder: TransactionBuilder;
  try {
    builder = new TransactionBuilder(validatedAccount, {
      fee: validatedBaseFee,
      networkPassphrase: validatedPassphrase,
    });
  } catch (err) {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `Failed to initialize transaction builder: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  for (let i = 0; i < validatedOperations.length; i++) {
    try {
      builder.addOperation(validatedOperations[i]);
    } catch (err) {
      throw new TransactionBuildError(
        "BUILD_FAILED",
        `Failed to add operation at index ${i}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  try {
    return builder.setTimeout(validatedTimeout).build();
  } catch (err) {
    throw new TransactionBuildError(
      "BUILD_FAILED",
      `Failed to build transaction: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}