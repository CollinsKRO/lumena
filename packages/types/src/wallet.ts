export type WalletState = "creating" | "ready" | "locked" | "error";

export interface WalletConfig {
  network: "testnet" | "mainnet" | "local";
  horizonUrl: string;
  rpcUrl: string;
}

export interface WalletInstance {
  id: string;
  address: string;
  state: WalletState;
  createdAt: Date;
}

/**
 * Status of a pending contract upgrade for the upgradeable proxy (#224).
 */
export type UpgradeState =
  | "none"
  | "pending"
  | "approved"
  | "executed"
  | "cancelled";

/**
 * Pending upgrade proposal tracked by the proxy contract (#224).
 *
 * The proxy uses `env.deployer().update_current_contract_wasm()` to swap the
 * contract logic while preserving instance and persistent storage. Upgrades
 * require multi-sig approval and a mandatory timelock before execution.
 */
export interface PendingUpgrade {
  /** Hex-encoded hash of the new WASM blob to be deployed. */
  wasmHash: string;
  /** Current status of the upgrade proposal. */
  state: UpgradeState;
  /** Addresses (signers) that have approved the upgrade so far. */
  approvals: string[];
  /** Number of approvals required before the upgrade can execute. */
  requiredApprovals: number;
  /** Unix timestamp (seconds) at which the timelock expires and execution is allowed. */
  unlockTimestamp: number;
  /** Unix timestamp (seconds) when the proposal was created. */
  proposedAt: number;
  /** Address that created the upgrade proposal. */
  proposer: string;
}

/**
 * Inheritance configuration for the dead-man's switch vault (#225).
 */
export interface InheritanceConfig {
  /** Address of the designated beneficiary allowed to claim custody. */
  beneficiary: string;
  /** Dormancy period in seconds; claim is allowed once inactivity exceeds this. */
  dormancyPeriod: number;
}

/**
 * Runtime inheritance state for the dead-man's switch vault (#225).
 */
export interface InheritanceState {
  /** Current inheritance configuration. */
  config: InheritanceConfig;
  /** Unix timestamp (seconds) of the last heartbeat (updated by wallet activity). */
  lastHeartbeat: number;
  /** Whether the beneficiary has already claimed custody. */
  claimed: boolean;
  /** Unix timestamp (seconds) when custody was claimed, if applicable. */
  claimedAt?: number;
}