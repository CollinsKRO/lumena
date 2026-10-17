import {
  Address,
  nativeToScVal,
  scValToNative,
  Operation,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarClient } from "./client.js";

export class Sep41Token {
  readonly contractId: string;
  readonly client?: StellarClient;

  constructor(contractId: string, client?: StellarClient);
  constructor(client: StellarClient, contractId: string);
  constructor(arg1: string | StellarClient, arg2?: string | StellarClient) {
    if (typeof arg1 === "string") {
      this.contractId = arg1;
      this.client = arg2 as StellarClient | undefined;
    } else {
      this.client = arg1;
      this.contractId = arg2 as string;
    }
  }

  /**
   * Builds an invocation operation for checking an account's token balance.
   */
  buildBalanceOperation(address: string): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "balance",
      args: [new Address(address).toScVal()],
    });
  }

  /**
   * Builds an invocation operation for checking an account's spendable balance.
   */
  buildSpendableBalanceOperation(address: string): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "spendable_balance",
      args: [new Address(address).toScVal()],
    });
  }

  /**
   * Builds an invocation operation for checking whether an account is authorized.
   */
  buildAuthorizedOperation(address: string): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "authorized",
      args: [new Address(address).toScVal()],
    });
  }

  /**
   * Builds an invocation operation for reading the token decimals.
   */
  buildDecimalsOperation(): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "decimals",
      args: [],
    });
  }

  /**
   * Builds an invocation operation for reading the token name.
   */
  buildNameOperation(): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "name",
      args: [],
    });
  }

  /**
   * Builds an invocation operation for reading the token symbol.
   */
  buildSymbolOperation(): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "symbol",
      args: [],
    });
  }

  /**
   * Queries balance of an address by calling/simulating the balance method on Soroban RPC.
   */
  async balance(address: string): Promise<bigint> {
    if (!this.client) {
      throw new Error("StellarClient instance required for balance RPC call");
    }

    const op = this.buildBalanceOperation(address);
    const simResult = await this.client.rpc.simulateTransaction({
      operations: [op],
    } as any);

    return Sep41Token.parseBalanceResponse(simResult);
  }

  /**
   * Parses the return value from a balance contract call simulation or execution into a bigint.
   */
  static parseBalanceResponse(response: any): bigint {
    if (!response) return 0n;

    if (response instanceof xdr.ScVal) {
      const native = scValToNative(response);
      return typeof native === "bigint" ? native : BigInt(native ?? 0);
    }

    if (response.result && response.result.retval) {
      const retval = response.result.retval;
      const native = scValToNative(retval);
      return typeof native === "bigint" ? native : BigInt(native ?? 0);
    }

    if (typeof response === "bigint") return response;
    if (typeof response === "number" || typeof response === "string") return BigInt(response);

    return 0n;
  }

  /**
   * Encodes a SEP-41 `transfer` Soroban operation (from, to, amount).
   */
  transfer(from: string, to: string, amount: string | bigint): xdr.Operation {
    const amountVal = BigInt(amount);
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "transfer",
      args: [
        new Address(from).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(amountVal, { type: "i128" }),
      ],
    });
  }

  /**
   * Encodes a SEP-41 `approve` Soroban operation (owner, spender, amount, expirationLedger).
   */
  approve(
    owner: string,
    spender: string,
    amount: string | bigint,
    expirationLedger: number
  ): xdr.Operation {
    const amountVal = BigInt(amount);
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "approve",
      args: [
        new Address(owner).toScVal(),
        new Address(spender).toScVal(),
        nativeToScVal(amountVal, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
      ],
    });
  }

  allowance(owner: string, spender: string): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "allowance",
      args: [new Address(owner).toScVal(), new Address(spender).toScVal()],
    });
  }

  transferFrom(spender: string, from: string, to: string, amount: string | bigint): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: this.contractId,
      function: "transfer_from",
      args: [
        new Address(spender).toScVal(),
        new Address(from).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
      ],
    });
  }

  /**
   * Encodes a SEP-41 `transfer` operation that moves `amount` from `from`
   * into the escrow contract identified by `escrowContractId`.
   *
   * This is the funding step for an escrow deposit: the depositor transfers
   * tokens (or XLM via the native asset contract) to the escrow contract.
   */
  buildDeposit(
    from: string,
    escrowContractId: string,
    amount: string | bigint
  ): xdr.Operation {
    return this.transfer(from, escrowContractId, amount);
  }

  /**
   * Encodes a SEP-41 `approve` operation allowing the escrow contract to
   * spend `amount` of the owner's tokens until `expirationLedger`.
   *
   * Useful when the escrow pulls funds via `transfer_from` instead of
   * receiving a direct transfer.
   */
  buildApproveForEscrow(
    owner: string,
    escrowContractId: string,
    amount: string | bigint,
    expirationLedger: number
  ): xdr.Operation {
    return this.approve(owner, escrowContractId, amount, expirationLedger);
  }

  /**
   * Encodes a SEP-41 `transfer_from` operation pulling `amount` from `from`
   * into the escrow contract, using the allowance granted to the escrow.
   */
  buildDepositFrom(
    escrowContractId: string,
    from: string,
    amount: string | bigint
  ): xdr.Operation {
    return this.transferFrom(escrowContractId, from, escrowContractId, amount);
  }

  /**
   * Builds an invocation of the escrow contract's `deposit` method.
   *
   * @param escrowContractId The escrow contract to invoke.
   * @param depositor The account funding the escrow.
   * @param token The token contract (SEP-41 or native asset) being escrowed.
   * @param amount The amount to lock in escrow.
   * @param recipient The designated recipient of the funds.
   * @param releaseLedger Optional ledger at which the escrow expires/refunds.
   */
  static buildEscrowDeposit(
    escrowContractId: string,
    depositor: string,
    token: string,
    amount: string | bigint,
    recipient: string,
    releaseLedger?: number
  ): xdr.Operation {
    const args: xdr.ScVal[] = [
      new Address(depositor).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(BigInt(amount), { type: "i128" }),
      new Address(recipient).toScVal(),
    ];
    if (releaseLedger !== undefined) {
      args.push(nativeToScVal(releaseLedger, { type: "u32" }));
    }
    return Operation.invokeContractFunction({
      contract: escrowContractId,
      function: "deposit",
      args,
    });
  }

  /**
   * Builds an invocation of the escrow contract's `release` method.
   */
  static buildEscrowRelease(
    escrowContractId: string,
    escrowId: string | bigint,
    caller: string
  ): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: escrowContractId,
      function: "release",
      args: [
        nativeToScVal(BigInt(escrowId), { type: "u64" }),
        new Address(caller).toScVal(),
      ],
    });
  }

  /**
   * Builds an invocation of the escrow contract's `refund` method.
   */
  static buildEscrowRefund(
    escrowContractId: string,
    escrowId: string | bigint,
    caller: string
  ): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: escrowContractId,
      function: "refund",
      args: [
        nativeToScVal(BigInt(escrowId), { type: "u64" }),
        new Address(caller).toScVal(),
      ],
    });
  }

  /**
   * Builds an invocation of the escrow contract's `raise_dispute` method.
   */
  static buildEscrowRaiseDispute(
    escrowContractId: string,
    escrowId: string | bigint,
    caller: string
  ): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: escrowContractId,
      function: "raise_dispute",
      args: [
        nativeToScVal(BigInt(escrowId), { type: "u64" }),
        new Address(caller).toScVal(),
      ],
    });
  }

  /**
   * Builds an invocation of the escrow contract's `arbitrate` method.
   *
   * @param releaseToRecipient When true the arbiter releases funds to the
   *   recipient; when false the funds are refunded to the depositor.
   */
  static buildEscrowArbitrate(
    escrowContractId: string,
    escrowId: string | bigint,
    arbiter: string,
    releaseToRecipient: boolean
  ): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: escrowContractId,
      function: "arbitrate",
      args: [
        nativeToScVal(BigInt(escrowId), { type: "u64" }),
        new Address(arbiter).toScVal(),
        nativeToScVal(releaseToRecipient, { type: "bool" }),
      ],
    });
  }
}
