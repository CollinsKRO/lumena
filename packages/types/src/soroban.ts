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

/* -------------------------------------------------------------------------- */
/* policy-guard (#222)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A verified contract entry maintained by the policy-guard registry.
 */
export interface ContractRegistryEntry {
  /** Contract address (StrKey `C...`). */
  contractId: string;
  /** Hex-encoded hash of the verified contract WASM. */
  wasmHash: string;
  /** Optional human-readable label / protocol name. */
  label?: string;
  /** Whether the entry is currently active in the registry. */
  verified: boolean;
  /** Ledger timestamp (seconds) when the entry was registered. */
  registeredAt?: number;
  /** Ledger timestamp (seconds) when the entry was last updated. */
  updatedAt?: number;
}

/**
 * Result of validating a single cross-contract invocation target.
 */
export interface InvocationValidationResult {
  /** The contract address that was checked. */
  contractId: string;
  /** Whether the target is registered and verified. */
  allowed: boolean;
  /** Reason for rejection, if `allowed` is false. */
  reason?: string;
  /** The registry entry matched, if any. */
  entry?: ContractRegistryEntry;
}

/**
 * Aggregate result of validating a batch of cross-contract invocations.
 */
export interface BatchInvocationValidationResult {
  /** True only if every invocation target is allowed. */
  allowed: boolean;
  /** Per-invocation validation results, in input order. */
  results: InvocationValidationResult[];
  /** Contract addresses that failed validation. */
  rejected: string[];
}

/* -------------------------------------------------------------------------- */
/* oracle-spend-limit (#223)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A price feed entry returned by the oracle consumer.
 */
export interface OraclePrice {
  /** Asset identifier (e.g. `XLM`, `USDC`, or a contract address). */
  asset: string;
  /** Price expressed in the oracle's base quote asset (typically USD). */
  price: bigint;
  /** Number of decimal places the `price` value is scaled by. */
  decimals: number;
  /** Ledger timestamp (seconds) when the price was published. */
  timestamp: number;
}

/**
 * Result of a USD spend-limit check.
 */
export interface UsdSpendCheckResult {
  /** Whether the spend is within the configured USD limit. */
  allowed: boolean;
  /** USD value of the requested spend, scaled to 7 decimals (stroops). */
  usdValue: bigint;
  /** Configured USD limit, scaled to 7 decimals (stroops). */
  usdLimit: bigint;
  /** Price used for the conversion, if available. */
  price?: OraclePrice;
  /** Reason for rejection, if `allowed` is false (e.g. stale/missing price). */
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* proxy (#224)                                                               */
/* -------------------------------------------------------------------------- */

export type UpgradeProposalStatus =
  | "pending"
  | "approved"
  | "executed"
  | "cancelled"
  | "expired";

/**
 * A pending contract WASM upgrade proposal.
 */
export interface UpgradeProposal {
  /** Unique proposal identifier. */
  id: string;
  /** Hex-encoded hash of the proposed WASM. */
  wasmHash: string;
  /** Address that created the proposal. */
  proposer: string;
  /** Ledger timestamp (seconds) when the proposal was created. */
  createdAt: number;
  /** Ledger timestamp (seconds) after which the proposal may be executed. */
  executableAt: number;
  /** Ledger timestamp (seconds) after which the proposal expires. */
  expiresAt: number;
  /** Current status of the proposal. */
  status: UpgradeProposalStatus;
  /** Addresses that have approved the proposal. */
  approvals: string[];
  /** Number of approvals required to execute. */
  threshold: number;
}

/**
 * Result of an approval action on an upgrade proposal.
 */
export interface UpgradeApprovalResult {
  proposalId: string;
  /** Whether the approval was recorded. */
  approved: boolean;
  /** Total approvals recorded after this action. */
  approvalCount: number;
  /** Approvals still required before execution is possible. */
  remainingApprovals: number;
  /** Whether the proposal now meets its approval threshold. */
  thresholdReached: boolean;
}

/**
 * Timelock configuration for the upgrade proxy.
 */
export interface UpgradeTimelock {
  /** Minimum delay (seconds) between approval and execution. */
  delaySeconds: number;
  /** Maximum age (seconds) before a proposal expires. */
  expirySeconds: number;
}

/* -------------------------------------------------------------------------- */
/* inheritance (#225)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A designated beneficiary of an inheritance vault.
 */
export interface InheritanceBeneficiary {
  /** Beneficiary address (StrKey `G...` or `C...`). */
  address: string;
  /** Optional share of the vault allocated to this beneficiary (basis points). */
  shareBps?: number;
  /** Ledger timestamp (seconds) when the beneficiary was added. */
  addedAt?: number;
}

/**
 * Dormancy configuration for an inheritance vault.
 */
export interface DormancyConfig {
  /** Dormancy period in seconds after which a claim becomes possible. */
  dormancyPeriod: number;
  /** Ledger timestamp (seconds) of the last recorded heartbeat. */
  lastHeartbeat: number;
}

/**
 * Result of a beneficiary claim attempt.
 */
export interface InheritanceClaimResult {
  /** Whether the claim succeeded. */
  claimed: boolean;
  /** Beneficiary that attempted the claim. */
  beneficiary: string;
  /** Ledger timestamp (seconds) at which the claim was evaluated. */
  evaluatedAt: number;
  /** Seconds elapsed since the last heartbeat. */
  elapsedSeconds: number;
  /** Reason for rejection, if `claimed` is false (e.g. heartbeat still active). */
  reason?: string;
}