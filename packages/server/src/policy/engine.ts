import type { Transaction, Operation, Asset } from "@stellar/stellar-sdk";
import type {
  Policy,
  PolicyRule,
  SpendLimit,
  VelocityRule,
  AllowlistRule,
  BlocklistRule,
  AssetAllowlistRule,
  SessionKeyPolicyRule,
  TimeBoundsRule,
  MaxOperationsRule,
  FeeLimitRule,
  ContractAllowlistRule,
} from "@lumen/types";
import { validateTimeBounds } from "@lumen/core";

export interface EvaluateOpts {
  walletAddress: string;
  transaction: Transaction;
}

export interface EvaluateResult {
  approved: boolean;
  reason?: string;
}

export interface PolicyEngineOptions {
  defaultPolicy?: "allow" | "deny";
}

export class PolicyEngine {
  private policies: Map<string, Policy> = new Map();
  private readonly defaultPolicy: "allow" | "deny";

  // In-memory tracking for spend limit and velocity
  private readonly spendTracking: Map<
    string,
    Map<string, { dailyTotal: number; txCount: number }>
  > = new Map();
  private readonly velocityTracking: Map<string, number[]> = new Map();
  private readonly sessionSpendTracking: Map<string, number> = new Map();

  constructor(options: PolicyEngineOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? "allow";
  }

  addPolicy(policy: Policy): void {
    this.policies.set(policy.walletId, policy);
  }

  removePolicy(walletId: string): void {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
  }

  getPolicy(walletId: string): Policy | null {
    return this.policies.get(walletId) ?? null;
  }

  listPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  evaluate(opts: EvaluateOpts): EvaluateResult {
    try {
      if (!opts || typeof opts !== "object") {
        return { approved: false, reason: "Malformed evaluation options" };
      }

      const policy = this.policies.get(opts.walletAddress);

      if (!policy) {
        return this.defaultPolicy === "allow"
          ? { approved: true }
          : { approved: false, reason: `No policy found for wallet ${opts.walletAddress}` };
      }

      if (!Array.isArray(policy.rules)) {
        return { approved: false, reason: "Policy has malformed rules" };
      }

      for (const rule of policy.rules) {
        const result = this.evaluateRule(rule, opts);
        if (!result.approved) {
          return result;
        }
      }

      return { approved: true };
    } catch (err) {
      return {
        approved: false,
        reason: `Policy evaluation failed closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private evaluateRule(rule: PolicyRule, opts: EvaluateOpts): EvaluateResult {
    try {
      if (!rule || typeof rule !== "object" || typeof rule.type !== "string") {
        return { approved: false, reason: "Malformed policy rule" };
      }

      switch (rule.type) {
        case "spend_limit":
          return this.evaluateSpendLimit(rule as SpendLimit, opts);
        case "velocity":
          return this.evaluateVelocity(rule as VelocityRule, opts);
        case "allowlist":
          return this.evaluateAllowlist(rule as AllowlistRule, opts);
        case "blocklist":
          return this.evaluateBlocklist(rule as BlocklistRule, opts);
        case "asset_allowlist":
          return this.evaluateAssetAllowlist(rule as AssetAllowlistRule, opts);
        case "session_key":
          return this.evaluateSessionKey(rule as SessionKeyPolicyRule, opts);
        case "timebounds":
          return this.evaluateTimeBounds(rule as TimeBoundsRule, opts);
        case "max_operations":
          return this.evaluateMaxOperations(rule as MaxOperationsRule, opts);
        case "fee_limit":
          return this.evaluateFeeLimit(rule as FeeLimitRule, opts);
        case "contract_allowlist":
          return this.evaluateContractAllowlist(rule as ContractAllowlistRule, opts);
        default:
          return { approved: false, reason: `Unknown policy rule type: ${rule.type}` };
      }
    } catch (err) {
      return {
        approved: false,
        reason: `Rule evaluation failed closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private getOperations(opts: EvaluateOpts): Operation[] {
    const tx = opts?.transaction as unknown as { operations?: unknown } | undefined;
    if (!tx || !Array.isArray(tx.operations)) {
      return [];
    }
    return tx.operations as Operation[];
  }

  private parseAmount(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }
    const parsed = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  private evaluateSpendLimit(rule: SpendLimit, opts: EvaluateOpts): EvaluateResult {
    const { walletAddress } = opts;
    const targetAsset = this.getAssetIdentifier(rule.asset);

    const maxPerTx = this.parseAmount(rule.maxPerTx);
    const maxDaily = this.parseAmount(rule.maxDaily);
    if (maxPerTx === null || maxDaily === null) {
      return { approved: false, reason: "Spend limit rule has malformed limits" };
    }

    let txAmount = 0;
    let matchedOps = 0;

    for (const op of this.getOperations(opts)) {
      // Type guard: only operations that carry an `amount` field (Payment, PathPayment, etc.)
      if (!("amount" in op) || typeof (op as { amount: unknown }).amount !== "string") {
        continue;
      }

      const typedOp = op as
        Operation.Payment | Operation.PathPaymentStrictSend | Operation.PathPaymentStrictReceive;
      const opAsset: Asset | undefined =
        "asset" in typedOp
          ? (typedOp as Operation.Payment).asset
          : "sendAsset" in typedOp
            ? (typedOp as Operation.PathPaymentStrictSend).sendAsset
            : "destAsset" in typedOp
              ? (typedOp as Operation.PathPaymentStrictReceive).destAsset
              : undefined;
      const opAssetId = this.getAssetIdentifier(opAsset);

      if (opAssetId === targetAsset) {
        const amount = this.parseAmount((typedOp as { amount: string }).amount);
        if (amount === null) {
          return { approved: false, reason: "Transaction contains a malformed amount" };
        }
        txAmount += amount;
        matchedOps++;
      }
    }

    if (matchedOps === 0) {
      return { approved: true };
    }

    if (txAmount > maxPerTx) {
      return {
        approved: false,
        reason: `Transaction spending ${txAmount} exceeds per-tx limit ${rule.maxPerTx}`,
      };
    }

    if (!this.spendTracking.has(walletAddress)) {
      this.spendTracking.set(walletAddress, new Map());
    }
    const walletTrack = this.spendTracking.get(walletAddress)!;
    const today = new Date().toISOString().split("T")[0];
    const trackKey = `${today}:${targetAsset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;

    if (txAmount > maxPerTx) {
      return {
        approved: false,
        reason: `Transaction spending ${txAmount} exceeds per-tx limit ${rule.maxPerTx}`,
      };
    }

    if (track.dailyTotal + txAmount > maxDaily) {
      return {
        approved: false,
        reason: `Daily spending ${track.dailyTotal + txAmount} exceeds limit ${rule.maxDaily}`,
      };
    }

    track.dailyTotal += txAmount;
    track.txCount++;

    return { approved: true };
  }

  private getAssetIdentifier(asset: Asset | string | undefined | null): string {
    try {
      if (!asset) return "native";
      if (typeof asset === "string") {
        if (asset.toLowerCase() === "native" || asset.toUpperCase() === "XLM") {
          return "native";
        }
        return asset;
      }
      if (typeof asset.isNative === "function" && asset.isNative()) {
        return "native";
      }
      if (asset.code && asset.issuer) {
        return `${asset.code}:${asset.issuer}`;
      }
      if (asset.code) {
        return asset.code;
      }
      return "native";
    } catch {
      // Malformed asset objects must not throw; treat as an opaque identifier
      // so that allowlist checks fail closed rather than bypassing.
      return "__malformed_asset__";
    }
  }

  private evaluateVelocity(rule: VelocityRule, opts: EvaluateOpts): EvaluateResult {
    const { walletAddress } = opts;

    if (
      !Number.isFinite(rule.windowMinutes) ||
      !Number.isFinite(rule.maxTransactions) ||
      rule.windowMinutes < 0
    ) {
      return { approved: false, reason: "Velocity rule has malformed parameters" };
    }

    // Initialize tracking for this wallet if needed
    if (!this.velocityTracking.has(walletAddress)) {
      this.velocityTracking.set(walletAddress, []);
    }
    const txTimes = this.velocityTracking.get(walletAddress)!;

    // Remove timestamps outside the window
    const windowMs = rule.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);

    // Add current transaction timestamp
    recentTxs.push(Date.now());

    // Update tracking
    this.velocityTracking.set(walletAddress, recentTxs);

    // Check if exceeding limit
    if (recentTxs.length > rule.maxTransactions) {
      return {
        approved: false,
        reason: `Too many transactions (${recentTxs.length}) in ${rule.windowMinutes}-minute window (max: ${rule.maxTransactions})`,
      };
    }

    return { approved: true };
  }

  private evaluateAllowlist(rule: AllowlistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.destinations)) {
      return { approved: false, reason: "Allowlist rule has malformed destinations" };
    }

    for (const op of this.getOperations(opts)) {
      if ("destination" in op && op.destination) {
        const destination = op.destination.toString();
        if (!rule.destinations.includes(destination)) {
          return {
            approved: false,
            reason: `Destination ${destination} is not on the allowlist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateBlocklist(rule: BlocklistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.destinations)) {
      return { approved: false, reason: "Blocklist rule has malformed destinations" };
    }

    for (const op of this.getOperations(opts)) {
      if ("destination" in op && op.destination) {
        const destination = op.destination.toString();
        if (rule.destinations.includes(destination)) {
          return {
            approved: false,
            reason: `Destination ${destination} is on the blocklist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateAssetAllowlist(rule: AssetAllowlistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.assets)) {
      return { approved: false, reason: "Asset allowlist rule has malformed assets" };
    }

    for (const op of this.getOperations(opts)) {
      let assets: Array<Asset | undefined> = [];
      if (op.type === "payment") {
        assets = [(op as Operation.Payment).asset];
      } else if (op.type === "pathPaymentStrictSend") {
        const pathPayment = op as Operation.PathPaymentStrictSend;
        assets = [pathPayment.sendAsset, pathPayment.destAsset];
      } else if (op.type === "pathPaymentStrictReceive") {
        const pathPayment = op as Operation.PathPaymentStrictReceive;
        assets = [pathPayment.sendAsset, pathPayment.destAsset];
      }

      for (const asset of assets) {
        const identifier = this.getAssetIdentifier(asset);
        if (!rule.assets.some((allowed) => this.getAssetIdentifier(allowed) === identifier)) {
          return {
            approved: false,
            reason: `Asset ${identifier} is not on the allowlist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateSessionKey(rule: SessionKeyPolicyRule, opts: EvaluateOpts): EvaluateResult {
    const now = Date.now();

    if (!Number.isFinite(rule.expiresAt)) {
      return { approved: false, reason: "Session key rule has malformed expiry" };
    }

    const expiryMs = rule.expiresAt < 1e11 ? rule.expiresAt * 1000 : rule.expiresAt;

    if (now > expiryMs) {
      return { approved: false, reason: `Session key ${rule.sessionPublicKey} has expired` };
    }

    const paymentOp = this.getOperations(opts).find(
      (op): op is Operation.Payment => "amount" in op && "destination" in op,
    ) as Operation.Payment | undefined;

    let txAmount = 0;
    if (paymentOp) {
      const parsed = this.parseAmount(paymentOp.amount);
      if (parsed === null) {
        return { approved: false, reason: "Session key transaction has a malformed amount" };
      }
      txAmount = parsed;
    }

    const currentSpend = this.sessionSpendTracking.get(rule.sessionPublicKey) ?? 0;
    const maxSpend = this.parseAmount(rule.maxSpend);
    if (maxSpend === null) {
      return { approved: false, reason: "Session key rule has malformed spend cap" };
    }

    if (currentSpend + txAmount > maxSpend) {
      return {
        approved: false,
        reason: `Session key spend cap exceeded (${currentSpend + txAmount} > ${maxSpend})`,
      };
    }

    this.sessionSpendTracking.set(rule.sessionPublicKey, currentSpend + txAmount);
    return { approved: true };
  }

  private evaluateTimeBounds(rule: TimeBoundsRule, opts: EvaluateOpts): EvaluateResult {
    if (!opts?.transaction) {
      return { approved: false, reason: "Time bounds rule received a malformed transaction" };
    }

    const result = validateTimeBounds(opts.transaction, {
      maxWindowSeconds: rule.maxWindowSeconds,
      allowUnbounded: rule.allowUnbounded ?? false,
    });

    if (!result.valid) {
      return { approved: false, reason: result.reason };
    }

    return { approved: true };
  }

  evaluateMaxOperations(
    rule: MaxOperationsRule,
    optsOrTx: EvaluateOpts | Transaction | { operations: unknown[] },
  ): EvaluateResult {
    if (!Number.isFinite(rule.maxOperations) || rule.maxOperations < 0) {
      return { approved: false, reason: "Max operations rule has malformed limit" };
    }

    const tx =
      "transaction" in optsOrTx
        ? (optsOrTx as EvaluateOpts).transaction
        : (optsOrTx as { operations: unknown[] });
    const opCount = Array.isArray(tx?.operations) ? tx.operations.length : 0;
    if (opCount > rule.maxOperations) {
      return {
        approved: false,
        reason: `Transaction operation count ${opCount} exceeds limit of ${rule.maxOperations}`,
      };
    }

    return { approved: true };
  }

  private evaluateFeeLimit(rule: FeeLimitRule, opts: EvaluateOpts): EvaluateResult {
    if (!Number.isFinite(rule.maxFeeStroops)) {
      return { approved: false, reason: "Fee limit rule has malformed limit" };
    }

    const rawFee = (opts?.transaction as unknown as { fee?: unknown } | undefined)?.fee;
    const fee = typeof rawFee === "number" ? rawFee : parseInt(String(rawFee), 10);
    if (!Number.isFinite(fee)) {
      return { approved: false, reason: "Transaction has a malformed fee" };
    }

    if (fee > rule.maxFeeStroops) {
      return {
        approved: false,
        reason: `Transaction fee exceeds maximum allowed fee limit`,
      };
    }

    return { approved: true };
  }

  private evaluateContractAllowlist(rule: ContractAllowlistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.allowedContracts)) {
      return { approved: false, reason: "Contract allowlist rule has malformed contracts" };
    }

    for (const op of this.getOperations(opts)) {
      // Soroban contract invocations have type 'invokeHostFunction'
      if (op.type !== "invokeHostFunction") {
        continue;
      }

      const invokeOp = op as unknown as {
        type: string;
        func?: {
          contractAddress?: { contractId?: () => string; toString?: () => string };
          functionName?: string;
        };
      };

      // Extract the contract ID from the host function
      const contractId =
        invokeOp.func?.contractAddress?.contractId?.() ??
        invokeOp.func?.contractAddress?.toString?.() ??
        null;

      if (!contractId) {
        return {
          approved: false,
          reason: "Contract invocation is missing a contract address",
        };
      }

      const allowedEntry = rule.allowedContracts.find(
        (c: { contractId: string; methods?: string[] }) => c.contractId === contractId,
      );

      if (!allowedEntry) {
        return {
          approved: false,
          reason: `Contract ${contractId} is not in the allowlist`,
        };
      }

      // If methods are specified, verify the invoked function matches
      if (allowedEntry.methods && allowedEntry.methods.length > 0) {
        const invokedMethod = invokeOp.func?.functionName;
        if (!invokedMethod || !allowedEntry.methods.includes(invokedMethod)) {
          return {
            approved: false,
            reason: `Method ${invokedMethod ?? "(unknown)"} is not allowed for contract ${contractId}`,
          };
        }
      }
    }

    return { approved: true };
  }
}
