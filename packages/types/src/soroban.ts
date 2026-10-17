export type ScValType =
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "u256"
  | "i256"
  | "symbol"
  | "string"
  | "address"
  | "bytes";

/**
 * Valid scalar input types for Soroban contract arguments.
 * Use this instead of `any[]` when passing arguments to contract invocations.
 */
export type ScValInput = string | number | bigint | boolean | ContractArg;

export interface ContractArg {
  value: string | number | bigint | boolean | Uint8Array;
  type?: ScValType;
}

export interface ContractInvocation {
  contractId: string;
  method: string;
  args?: ScValInput[];
}

export interface ContractSimulationResult {
  successful: boolean;
  returnValue?: any;
  minResourceFee?: string;
  cpuInstructions?: number;
  memoryBytes?: number;
  error?: string;
}

/**
 * Lifecycle states of a multi-token escrow (see `contracts/escrow/`).
 */
export type EscrowState =
  | "created"
  | "funded"
  | "released"
  | "refunded"
  | "disputed"
  | "resolved";

/**
 * Snapshot of an escrow record as stored by the escrow contract.
 */
export interface EscrowInfo {
  /** Unique escrow identifier. */
  id: string;
  /** Address of the account that deposited the funds. */
  depositor: string;
  /** Address of the intended recipient. */
  recipient: string;
  /** Optional arbiter address authorized to resolve disputes. */
  arbiter?: string;
  /** Asset identifier: "native" for XLM or a SEP-41 token contract address. */
  asset: string;
  /** Escrowed amount in the asset's smallest unit (stroops for XLM). */
  amount: bigint;
  /** Current lifecycle state. */
  state: EscrowState;
  /** Ledger sequence at which the escrow was created. */
  createdAtLedger: number;
  /** Ledger sequence after which an unfulfilled escrow may be refunded. */
  expiresAtLedger: number;
  /** Whether the recipient must explicitly approve release. */
  requiresApproval: boolean;
}

/**
 * A rolling spend window used by spend-policy enforcement.
 */
export interface SpendWindow {
  /** Length of the window in ledgers. */
  windowLedgers: number;
  /** Maximum amount spendable within the window (smallest unit). */
  limit: bigint;
  /** Amount already spent within the current window. */
  spent: bigint;
  /** Ledger sequence at which the current window started. */
  windowStartLedger: number;
}

/**
 * A pending (timelocked) change to a spend limit awaiting activation.
 */
export interface PendingLimitChange {
  /** Proposed new spend limit (smallest unit). */
  newLimit: bigint;
  /** Ledger sequence at which the change was queued. */
  queuedAtLedger: number;
  /** Ledger sequence at which the change becomes effective. */
  effectiveAtLedger: number;
}

/**
 * TTL status of a tracked Soroban ledger entry (see `contracts/ttl-manager/`).
 */
export interface TtlStatus {
  /** Ledger key (or human-readable identifier) of the tracked entry. */
  entryKey: string;
  /** Whether the entry is instance storage (vs. persistent storage). */
  isInstance: boolean;
  /** Current live-until ledger sequence of the entry. */
  liveUntilLedger: number;
  /** Current ledger sequence at the time of the query. */
  currentLedger: number;
  /** Remaining ledgers before the entry is archived. */
  remainingLedgers: number;
  /** Whether the entry is below the configured extension threshold. */
  needsExtension: boolean;
}

/**
 * Estimated rent (resource fee) required to extend an entry's TTL.
 */
export interface RentEstimate {
  /** Ledger key (or human-readable identifier) of the tracked entry. */
  entryKey: string;
  /** Number of ledgers the TTL would be extended by. */
  extendByLedgers: number;
  /** Estimated fee in stroops to perform the extension. */
  estimatedFeeStroops: bigint;
  /** Amount to be reimbursed to the payer, if applicable (stroops). */
  reimbursementStroops: bigint;
  /** Address expected to pay for the extension. */
  payer?: string;
}