import { useCallback, useState } from "react";
import type { ContractSimulationResult, ScValInput, ScValType } from "@lumen/types";
import { useLumen } from "./context.js";

/** Type-level description of a single contract function. */
export interface SorobanContractMethod<
  TArgs extends ScValInput[] = ScValInput[],
  TReturn = unknown,
> {
  args: TArgs;
  returns: TReturn;
}

/**
 * Type-level contract ABI: maps each function name to its argument tuple and
 * decoded return type. Typically generated from the contract's WASM spec.
 *
 * @example
 * ```ts
 * type TokenSpec = {
 *   balance: { args: [id: string]; returns: bigint };
 *   transfer: { args: [from: string, to: string, amount: bigint]; returns: void };
 * };
 * ```
 */
export type SorobanContractSpec = Record<string, SorobanContractMethod>;

/** Runtime contract ABI: the ScVal type of each argument, used for parameter encoding. */
export type SorobanContractSpecDefinition<TSpec extends SorobanContractSpec> = {
  [K in keyof TSpec]: { args: readonly ScValType[] };
};

export interface SorobanSimulation<TReturn> extends Omit<ContractSimulationResult, "returnValue"> {
  returnValue?: TReturn;
}

export interface UseSorobanContractOptions {
  /** Wallet used as the source account for simulations and invocations. */
  walletId: string;
  /** Optional fee (in stroops) used when submitting invocations. */
  fee?: string;
}

type MethodName<TSpec extends SorobanContractSpec> = keyof TSpec & string;

export interface UseSorobanContractResult<TSpec extends SorobanContractSpec> {
  /** Simulates a contract call and returns the decoded, typed return value. */
  simulate: <M extends MethodName<TSpec>>(
    method: M,
    ...args: TSpec[M]["args"]
  ) => Promise<SorobanSimulation<TSpec[M]["returns"]>>;
  /** Estimates the minimum resource fee (in stroops) for a contract call. */
  estimateFee: <M extends MethodName<TSpec>>(
    method: M,
    ...args: TSpec[M]["args"]
  ) => Promise<string>;
  /** Simulates the call, then submits it if the simulation succeeds. */
  invoke: <M extends MethodName<TSpec>>(
    method: M,
    ...args: TSpec[M]["args"]
  ) => Promise<{ hash: string }>;
  loading: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Type-safe Soroban contract hook. Arguments are encoded using the runtime
 * spec, and return values are decoded and typed from `TContractSpec`.
 *
 * @param contractId - The contract address (C...).
 * @param spec       - Runtime ABI describing each method's argument types.
 * @param options    - Source wallet and optional submission fee.
 */
export function useSorobanContract<TContractSpec extends SorobanContractSpec>(
  contractId: string,
  spec: SorobanContractSpecDefinition<TContractSpec>,
  options: UseSorobanContractOptions,
): UseSorobanContractResult<TContractSpec> {
  const { client } = useLumen();
  const { walletId, fee } = options;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const encodeArgs = useCallback(
    (method: string, args: ScValInput[]): ScValInput[] => {
      const methods = spec as Record<string, { args: readonly ScValType[] } | undefined>;
      const methodSpec = methods[method];
      if (!methodSpec) {
        throw new Error(`Unknown method "${method}" for contract ${contractId}`);
      }
      if (args.length !== methodSpec.args.length) {
        throw new Error(
          `${method} expects ${methodSpec.args.length} argument(s), received ${args.length}`,
        );
      }
      return args.map((arg, index) =>
        typeof arg === "object" ? arg : { value: arg, type: methodSpec.args[index] },
      );
    },
    [contractId, spec],
  );

  const run = useCallback(
    async <T>(method: string, task: () => Promise<T>): Promise<T> => {
      setLoading(true);
      setError(null);
      try {
        return await task();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const normalized = new Error(`${contractId}.${method}: ${message}`);
        setError(normalized);
        throw normalized;
      } finally {
        setLoading(false);
      }
    },
    [contractId],
  );

  const simulateRaw = useCallback(
    async (method: string, args: ScValInput[]): Promise<ContractSimulationResult> => {
      const result = await client.simulateContract(
        walletId,
        contractId,
        method,
        encodeArgs(method, args),
      );
      if (!result.successful) {
        throw new Error(`Simulation failed: ${result.error ?? "unknown error"}`);
      }
      return result;
    },
    [client, walletId, contractId, encodeArgs],
  );

  const simulate = useCallback(
    <M extends MethodName<TContractSpec>>(method: M, ...args: TContractSpec[M]["args"]) =>
      run(method, () => simulateRaw(method, args)) as Promise<
        SorobanSimulation<TContractSpec[M]["returns"]>
      >,
    [run, simulateRaw],
  );

  const estimateFee = useCallback(
    <M extends MethodName<TContractSpec>>(method: M, ...args: TContractSpec[M]["args"]) =>
      run(method, async () => (await simulateRaw(method, args)).minResourceFee ?? "0"),
    [run, simulateRaw],
  );

  const invoke = useCallback(
    <M extends MethodName<TContractSpec>>(method: M, ...args: TContractSpec[M]["args"]) =>
      run(method, async () => {
        await simulateRaw(method, args);
        return client.invokeContract(walletId, contractId, method, encodeArgs(method, args), fee);
      }),
    [run, simulateRaw, client, walletId, contractId, encodeArgs, fee],
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
  }, []);

  return { simulate, estimateFee, invoke, loading, error, reset };
}
