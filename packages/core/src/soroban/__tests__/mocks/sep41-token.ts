import { Address, Contract, Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

/**
 * SEP-41 Fungible Token mock bindings.
 *
 * This module provides a typed interface mirroring the SEP-41 token contract
 * implemented in `contracts/token-sep41/`, along with helpers to build
 * `ContractInvocation` objects for use with `ContractClient` in unit tests.
 *
 * The interface mirrors the following contract methods:
 *   - initialize
 *   - balance
 *   - spendable_balance
 *   - authorized
 *   - transfer
 *   - transfer_from
 *   - burn
 *   - burn_from
 *   - decimals
 *   - name
 *   - symbol
 */

/**
 * Metadata describing a SEP-41 token instance.
 */
export interface Sep41TokenMetadata {
  /** Human readable token name. */
  name: string;
  /** Token symbol (e.g. "USDC"). */
  symbol: string;
  /** Number of decimal places used by the token. */
  decimals: number;
}

/**
 * Arguments for the `initialize` contract method.
 */
export interface InitializeArgs {
  /** Address of the admin / owner of the token. */
  admin: string;
  /** Number of decimal places used by the token. */
  decimal: number;
  /** Human readable token name. */
  name: string;
  /** Token symbol. */
  symbol: string;
}

/**
 * Arguments for the `transfer` contract method.
 */
export interface TransferArgs {
  /** Address sending the tokens. */
  from: string;
  /** Address receiving the tokens. */
  to: string;
  /** Amount to transfer (in stroops / smallest unit). */
  amount: bigint;
}

/**
 * Arguments for the `transfer_from` contract method.
 */
export interface TransferFromArgs {
  /** Address authorised to spend on behalf of `from`. */
  spender: string;
  /** Address the tokens are transferred from. */
  from: string;
  /** Address receiving the tokens. */
  to: string;
  /** Amount to transfer (in stroops / smallest unit). */
  amount: bigint;
}

/**
 * Arguments for the `burn` contract method.
 */
export interface BurnArgs {
  /** Address whose tokens are burned. */
  from: string;
  /** Amount to burn (in stroops / smallest unit). */
  amount: bigint;
}

/**
 * Arguments for the `burn_from` contract method.
 */
export interface BurnFromArgs {
  /** Address authorised to burn on behalf of `from`. */
  spender: string;
  /** Address the tokens are burned from. */
  from: string;
  /** Amount to burn (in stroops / smallest unit). */
  amount: bigint;
}

/**
 * A single contract invocation, suitable for passing to `ContractClient`.
 */
export interface ContractInvocation {
  /** The contract method being invoked. */
  method: string;
  /** The encoded arguments for the method. */
  args: xdr.ScVal[];
}

/**
 * Typed interface mirroring the SEP-41 token contract.
 *
 * Each method returns a `ContractInvocation` that can be submitted through
 * `ContractClient`. Read-only methods (balance, decimals, etc.) can also be
 * simulated directly.
 */
export interface Sep41TokenContract {
  /** Contract ID (StrKey encoded) of the deployed token. */
  readonly contractId: string;

  /** Build an invocation for `initialize`. */
  initialize(args: InitializeArgs): ContractInvocation;

  /** Build an invocation for `balance`. */
  balance(id: string): ContractInvocation;

  /** Build an invocation for `spendable_balance`. */
  spendableBalance(id: string): ContractInvocation;

  /** Build an invocation for `authorized`. */
  authorized(id: string): ContractInvocation;

  /** Build an invocation for `transfer`. */
  transfer(args: TransferArgs): ContractInvocation;

  /** Build an invocation for `transfer_from`. */
  transferFrom(args: TransferFromArgs): ContractInvocation;

  /** Build an invocation for `burn`. */
  burn(args: BurnArgs): ContractInvocation;

  /** Build an invocation for `burn_from`. */
  burnFrom(args: BurnFromArgs): ContractInvocation;

  /** Build an invocation for `decimals`. */
  decimals(): ContractInvocation;

  /** Build an invocation for `name`. */
  name(): ContractInvocation;

  /** Build an invocation for `symbol`. */
  symbol(): ContractInvocation;
}

/**
 * Encode an address string into an `ScVal` address argument.
 */
function addressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/**
 * Encode a bigint amount into an `ScVal` i128 argument.
 */
function amountToScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: 'i128' });
}

/**
 * Encode a number into an `ScVal` u32 argument.
 */
function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: 'u32' });
}

/**
 * Encode a string into an `ScVal` string argument.
 */
function stringToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'string' });
}

/**
 * Create a typed SEP-41 token mock bound to a given contract ID.
 *
 * @param contractId StrKey encoded contract ID of the deployed token.
 */
export function createSep41TokenMock(contractId: string): Sep41TokenContract {
  return {
    contractId,

    initialize(args: InitializeArgs): ContractInvocation {
      return {
        method: 'initialize',
        args: [
          addressToScVal(args.admin),
          u32ToScVal(args.decimal),
          stringToScVal(args.name),
          stringToScVal(args.symbol),
        ],
      };
    },

    balance(id: string): ContractInvocation {
      return {
        method: 'balance',
        args: [addressToScVal(id)],
      };
    },

    spendableBalance(id: string): ContractInvocation {
      return {
        method: 'spendable_balance',
        args: [addressToScVal(id)],
      };
    },

    authorized(id: string): ContractInvocation {
      return {
        method: 'authorized',
        args: [addressToScVal(id)],
      };
    },

    transfer(args: TransferArgs): ContractInvocation {
      return {
        method: 'transfer',
        args: [
          addressToScVal(args.from),
          addressToScVal(args.to),
          amountToScVal(args.amount),
        ],
      };
    },

    transferFrom(args: TransferFromArgs): ContractInvocation {
      return {
        method: 'transfer_from',
        args: [
          addressToScVal(args.spender),
          addressToScVal(args.from),
          addressToScVal(args.to),
          amountToScVal(args.amount),
        ],
      };
    },

    burn(args: BurnArgs): ContractInvocation {
      return {
        method: 'burn',
        args: [addressToScVal(args.from), amountToScVal(args.amount)],
      };
    },

    burnFrom(args: BurnFromArgs): ContractInvocation {
      return {
        method: 'burn_from',
        args: [
          addressToScVal(args.spender),
          addressToScVal(args.from),
          amountToScVal(args.amount),
        ],
      };
    },

    decimals(): ContractInvocation {
      return { method: 'decimals', args: [] };
    },

    name(): ContractInvocation {
      return { method: 'name', args: [] };
    },

    symbol(): ContractInvocation {
      return { method: 'symbol', args: [] };
    },
  };
}

/**
 * Decode a raw `ScVal` returned from a SEP-41 contract method into a
 * JavaScript value.
 *
 * @param scVal The raw return value from the contract.
 */
export function decodeSep41Result<T = unknown>(scVal: xdr.ScVal): T {
  return scValToNative(scVal) as T;
}

/**
 * Convenience helper to generate a random Stellar keypair for use in tests.
 */
export function randomKeypair(): Keypair {
  return Keypair.random();
}

/**
 * Convenience helper to generate a random contract ID for use in tests.
 */
export function randomContractId(): string {
  return Contract.random().contractId();
}

/**
 * Default token metadata used by tests when a specific value is not required.
 */
export const DEFAULT_SEP41_METADATA: Sep41TokenMetadata = {
  name: 'Lumen Test Token',
  symbol: 'LTT',
  decimals: 7,
};