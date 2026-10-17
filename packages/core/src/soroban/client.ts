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

  // ---------------------------------------------------------------------------
  // policy-guard (#222): cross-contract invocation policy validator
  // ---------------------------------------------------------------------------

  /**
   * Builds a `register` invocation for the policy-guard contract, registering a
   * verified contract hash in the trusted registry.
   */
  buildPolicyGuardRegisterInvocation(opts: {
    contractId: string;
    target: string;
    wasmHash: string | Uint8Array;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "register",
      args: [opts.target, opts.wasmHash],
    };
  }

  /**
   * Builds a `verify` invocation for the policy-guard contract, checking whether
   * a target contract is registered with the expected wasm hash.
   */
  buildPolicyGuardVerifyInvocation(opts: {
    contractId: string;
    target: string;
    wasmHash?: string | Uint8Array;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "verify",
      args: opts.wasmHash === undefined ? [opts.target] : [opts.target, opts.wasmHash],
    };
  }

  /**
   * Builds a `validate_invocation` invocation for the policy-guard contract,
   * enforcing the policy against the authorized call targets before dispatch.
   */
  buildPolicyGuardValidateInvocation(opts: {
    contractId: string;
    targets: string[];
    caller?: string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "validate_invocation",
      args: opts.caller === undefined ? [opts.targets] : [opts.targets, opts.caller],
    };
  }

  /** Simulates a policy-guard `register` invocation. */
  async simulatePolicyGuardRegister(
    opts: {
      contractId: string;
      target: string;
      wasmHash: string | Uint8Array;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildPolicyGuardRegisterInvocation(opts), sourceAddress);
  }

  /** Simulates a policy-guard `verify` invocation. */
  async simulatePolicyGuardVerify(
    opts: {
      contractId: string;
      target: string;
      wasmHash?: string | Uint8Array;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildPolicyGuardVerifyInvocation(opts), sourceAddress);
  }

  /** Simulates a policy-guard `validate_invocation` invocation. */
  async simulatePolicyGuardValidate(
    opts: {
      contractId: string;
      targets: string[];
      caller?: string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildPolicyGuardValidateInvocation(opts), sourceAddress);
  }

  // ---------------------------------------------------------------------------
  // oracle-spend-limit (#223): USD spend limit enforcement
  // ---------------------------------------------------------------------------

  /**
   * Builds a `check_spend` invocation for the oracle-spend-limit contract,
   * converting the asset amount to USD via the oracle before authorizing.
   */
  buildOracleCheckSpendInvocation(opts: {
    contractId: string;
    account: string;
    asset: string;
    amount: bigint | number | string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "check_spend",
      args: [opts.account, opts.asset, opts.amount],
    };
  }

  /** Simulates an oracle-spend-limit `check_spend` invocation. */
  async simulateOracleCheckSpend(
    opts: {
      contractId: string;
      account: string;
      asset: string;
      amount: bigint | number | string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildOracleCheckSpendInvocation(opts), sourceAddress);
  }

  // ---------------------------------------------------------------------------
  // proxy (#224): upgradeable proxy with multi-sig + timelock
  // ---------------------------------------------------------------------------

  /** Builds a proxy `propose` invocation to propose a new wasm hash upgrade. */
  buildProxyProposeInvocation(opts: {
    contractId: string;
    proposer: string;
    wasmHash: string | Uint8Array;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "propose",
      args: [opts.proposer, opts.wasmHash],
    };
  }

  /** Builds a proxy `approve` invocation to approve a pending upgrade proposal. */
  buildProxyApproveInvocation(opts: {
    contractId: string;
    approver: string;
    proposalId: bigint | number | string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "approve",
      args: [opts.approver, opts.proposalId],
    };
  }

  /** Builds a proxy `execute_upgrade` invocation to execute an approved upgrade. */
  buildProxyExecuteUpgradeInvocation(opts: {
    contractId: string;
    proposalId: bigint | number | string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "execute_upgrade",
      args: [opts.proposalId],
    };
  }

  /** Simulates a proxy `propose` invocation. */
  async simulateProxyPropose(
    opts: {
      contractId: string;
      proposer: string;
      wasmHash: string | Uint8Array;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildProxyProposeInvocation(opts), sourceAddress);
  }

  /** Simulates a proxy `approve` invocation. */
  async simulateProxyApprove(
    opts: {
      contractId: string;
      approver: string;
      proposalId: bigint | number | string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildProxyApproveInvocation(opts), sourceAddress);
  }

  /** Simulates a proxy `execute_upgrade` invocation. */
  async simulateProxyExecuteUpgrade(
    opts: {
      contractId: string;
      proposalId: bigint | number | string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildProxyExecuteUpgradeInvocation(opts), sourceAddress);
  }

  // ---------------------------------------------------------------------------
  // inheritance (#225): dead-man's switch / inheritance vault
  // ---------------------------------------------------------------------------

  /** Builds an inheritance `heartbeat` invocation to refresh the last activity. */
  buildInheritanceHeartbeatInvocation(opts: {
    contractId: string;
    owner: string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "heartbeat",
      args: [opts.owner],
    };
  }

  /** Builds an inheritance `claim` invocation for the beneficiary to claim custody. */
  buildInheritanceClaimInvocation(opts: {
    contractId: string;
    beneficiary: string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "claim",
      args: [opts.beneficiary],
    };
  }

  /** Builds an inheritance `set_beneficiary` invocation to designate a beneficiary. */
  buildInheritanceSetBeneficiaryInvocation(opts: {
    contractId: string;
    owner: string;
    beneficiary: string;
  }): ContractInvocation {
    return {
      contractId: opts.contractId,
      method: "set_beneficiary",
      args: [opts.owner, opts.beneficiary],
    };
  }

  /** Simulates an inheritance `heartbeat` invocation. */
  async simulateInheritanceHeartbeat(
    opts: {
      contractId: string;
      owner: string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildInheritanceHeartbeatInvocation(opts), sourceAddress);
  }

  /** Simulates an inheritance `claim` invocation. */
  async simulateInheritanceClaim(
    opts: {
      contractId: string;
      beneficiary: string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildInheritanceClaimInvocation(opts), sourceAddress);
  }

  /** Simulates an inheritance `set_beneficiary` invocation. */
  async simulateInheritanceSetBeneficiary(
    opts: {
      contractId: string;
      owner: string;
      beneficiary: string;
    },
    sourceAddress?: string
  ): Promise<ContractSimulationResult> {
    return this.simulate(this.buildInheritanceSetBeneficiaryInvocation(opts), sourceAddress);
  }
}
