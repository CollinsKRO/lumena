import {
  Operation,
  TransactionBuilder,
  Transaction,
  Account,
  BASE_FEE,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import type {
  ContractInvocation,
  ContractSimulationResult,
} from "@lumen/types";
import type { StellarClient } from "../stellar/client.js";
import { toScVal, fromScVal } from "./scval.js";

/**
 * Arguments for the spend-policy contract's `spend` method.
 */
export interface SpendPolicySpendArgs {
  asset: string;
  amount: bigint | number | string;
  recipient?: string;
}

/**
 * Arguments for the spend-policy contract's `schedule_limit_change` method.
 */
export interface SpendPolicyScheduleLimitChangeArgs {
  asset: string;
  newLimit: bigint | number | string;
}

/**
 * Arguments for the spend-policy contract's `apply_pending_limit` method.
 */
export interface SpendPolicyApplyPendingLimitArgs {
  asset: string;
}

/**
 * Arguments for the ttl-manager contract's `extend_ttl_if_needed` method.
 */
export interface TtlManagerExtendArgs {
  thresholdLedgers: number;
  extendBy: number;
}

export class ContractClient {
  readonly client: StellarClient;

  constructor(client: StellarClient) {
    this.client = client;
  }

  /**
   * Converts a ContractInvocation into an xdr.Operation.
   */
  buildInvocationOperation(invocation: ContractInvocation): xdr.Operation {
    const scValArgs: xdr.ScVal[] = (invocation.args ?? []).map((arg) =>
      toScVal(arg)
    );

    return Operation.invokeContractFunction({
      contract: invocation.contractId,
      function: invocation.method,
      args: scValArgs,
    });
  }

  /**
   * Simulates a Soroban contract invocation without submitting it to the network.
   */
  async simulate(
    invocation: ContractInvocation,
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    const source = sourceAddress ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const dummyAccount = new Account(source, "0");
    const op = this.buildInvocationOperation(invocation);

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(180)
      .build();

    const simResponse = await this.client.rpc.simulateTransaction(tx);
    const sim = simResponse as any;
    const isSuccess =
      rpc.Api.isSimulationSuccess(simResponse) || (sim && sim.result?.retval !== undefined);

    if (isSuccess) {
      const retval = sim.result?.retval;
      return {
        successful: true,
        returnValue: retval ? fromScVal(retval) : undefined,
        minResourceFee: sim.minResourceFee?.toString(),
        cpuInstructions: sim.cost?.cpuInsns ? Number(sim.cost.cpuInsns) : undefined,
        memoryBytes: sim.cost?.memBytes ? Number(sim.cost.memBytes) : undefined,
      };
    }

    return {
      successful: false,
      error: sim?.error ?? sim?.result?.error ?? "Simulation failed",
    };
  }

  /**
   * Builds and simulates a prepared Soroban contract transaction ready for signing.
   */
  async buildTransaction(opts: {
    sourceAddress: string;
    invocation: ContractInvocation;
    fee?: string;
    timeoutSeconds?: number;
  }): Promise<Transaction> {
    const account = await this.client.horizon.loadAccount(opts.sourceAddress);
    const op = this.buildInvocationOperation(opts.invocation);

    const tx = new TransactionBuilder(account, {
      fee: opts.fee ?? BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(opts.timeoutSeconds ?? 180)
      .build();

    return (await this.client.rpc.prepareTransaction(tx)) as Transaction;
  }

  /**
   * Builds a typed invocation for the spend-policy contract's `spend` method.
   */
  buildSpendPolicySpendInvocation(
    contractId: string,
    args: SpendPolicySpendArgs
  ): ContractInvocation {
    const scArgs: unknown[] = [args.asset, args.amount];
    if (args.recipient !== undefined) {
      scArgs.push(args.recipient);
    }
    return {
      contractId,
      method: "spend",
      args: scArgs,
    };
  }

  /**
   * Builds a typed invocation for the spend-policy contract's
   * `schedule_limit_change` method (subject to the 24-hour delay).
   */
  buildSpendPolicyScheduleLimitChangeInvocation(
    contractId: string,
    args: SpendPolicyScheduleLimitChangeArgs
  ): ContractInvocation {
    return {
      contractId,
      method: "schedule_limit_change",
      args: [args.asset, args.newLimit],
    };
  }

  /**
   * Builds a typed invocation for the spend-policy contract's
   * `apply_pending_limit` method.
   */
  buildSpendPolicyApplyPendingLimitInvocation(
    contractId: string,
    args: SpendPolicyApplyPendingLimitArgs
  ): ContractInvocation {
    return {
      contractId,
      method: "apply_pending_limit",
      args: [args.asset],
    };
  }

  /**
   * Builds a typed invocation for the ttl-manager contract's
   * `extend_ttl_if_needed` method.
   */
  buildTtlManagerExtendInvocation(
    contractId: string,
    args: TtlManagerExtendArgs
  ): ContractInvocation {
    return {
      contractId,
      method: "extend_ttl_if_needed",
      args: [args.thresholdLedgers, args.extendBy],
    };
  }

  /**
   * Simulates the spend-policy contract's `spend` method.
   */
  async simulateSpendPolicySpend(
    contractId: string,
    args: SpendPolicySpendArgs,
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(
      this.buildSpendPolicySpendInvocation(contractId, args),
      sourceAddress
    );
  }

  /**
   * Simulates the spend-policy contract's `schedule_limit_change` method.
   */
  async simulateSpendPolicyScheduleLimitChange(
    contractId: string,
    args: SpendPolicyScheduleLimitChangeArgs,
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(
      this.buildSpendPolicyScheduleLimitChangeInvocation(contractId, args),
      sourceAddress
    );
  }

  /**
   * Simulates the spend-policy contract's `apply_pending_limit` method.
   */
  async simulateSpendPolicyApplyPendingLimit(
    contractId: string,
    args: SpendPolicyApplyPendingLimitArgs,
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(
      this.buildSpendPolicyApplyPendingLimitInvocation(contractId, args),
      sourceAddress
    );
  }

  /**
   * Simulates the ttl-manager contract's `extend_ttl_if_needed` method.
   */
  async simulateTtlManagerExtend(
    contractId: string,
    args: TtlManagerExtendArgs,
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(
      this.buildTtlManagerExtendInvocation(contractId, args),
      sourceAddress
    );
  }

  /**
   * Builds a prepared transaction for the spend-policy contract's `spend` method.
   */
  async buildSpendPolicySpendTransaction(opts: {
    sourceAddress: string;
    contractId: string;
    args: SpendPolicySpendArgs;
    fee?: string;
    timeoutSeconds?: number;
  }): Promise<Transaction> {
    return this.buildTransaction({
      sourceAddress: opts.sourceAddress,
      invocation: this.buildSpendPolicySpendInvocation(opts.contractId, opts.args),
      fee: opts.fee,
      timeoutSeconds: opts.timeoutSeconds,
    });
  }

  /**
   * Builds a prepared transaction for the spend-policy contract's
   * `schedule_limit_change` method.
   */
  async buildSpendPolicyScheduleLimitChangeTransaction(opts: {
    sourceAddress: string;
    contractId: string;
    args: SpendPolicyScheduleLimitChangeArgs;
    fee?: string;
    timeoutSeconds?: number;
  }): Promise<Transaction> {
    return this.buildTransaction({
      sourceAddress: opts.sourceAddress,
      invocation: this.buildSpendPolicyScheduleLimitChangeInvocation(
        opts.contractId,
        opts.args
      ),
      fee: opts.fee,
      timeoutSeconds: opts.timeoutSeconds,
    });
  }

  /**
   * Builds a prepared transaction for the spend-policy contract's
   * `apply_pending_limit` method.
   */
  async buildSpendPolicyApplyPendingLimitTransaction(opts: {
    sourceAddress: string;
    contractId: string;
    args: SpendPolicyApplyPendingLimitArgs;
    fee?: string;
    timeoutSeconds?: number;
  }): Promise<Transaction> {
    return this.buildTransaction({
      sourceAddress: opts.sourceAddress,
      invocation: this.buildSpendPolicyApplyPendingLimitInvocation(
        opts.contractId,
        opts.args
      ),
      fee: opts.fee,
      timeoutSeconds: opts.timeoutSeconds,
    });
  }

  /**
   * Builds a prepared transaction for the ttl-manager contract's
   * `extend_ttl_if_needed` method.
   */
  async buildTtlManagerExtendTransaction(opts: {
    sourceAddress: string;
    contractId: string;
    args: TtlManagerExtendArgs;
    fee?: string;
    timeoutSeconds?: number;
  }): Promise<Transaction> {
    return this.buildTransaction({
      sourceAddress: opts.sourceAddress,
      invocation: this.buildTtlManagerExtendInvocation(opts.contractId, opts.args),
      fee: opts.fee,
      timeoutSeconds: opts.timeoutSeconds,
    });
  }
}
