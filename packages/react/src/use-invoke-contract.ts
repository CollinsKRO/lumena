import { useCallback, useState } from "react";
import type { ScValInput } from "@lumen/types";
import { useLumen } from "./context.js";

export interface InvokeContractParams {
  walletId: string;
  contractId: string;
  method: string;
  args?: ScValInput[];
  fee?: string;
}

export interface InvokeContractResult {
  hash: string;
}

export interface UseInvokeContractOptions {
  /**
   * When set, the target contract is validated against the policy-guard
   * registry before the invocation is dispatched (#222). Unregistered
   * contracts are rejected without submitting a transaction.
   */
  policyGuardId?: string;
  /**
   * Optional explicit list of authorized call targets. When provided, the
   * target contract must be present in this list in addition to being
   * registered in the policy-guard registry.
   */
  authorizedTargets?: string[];
}

export interface UseInvokeContractResult {
  invoke: (params: InvokeContractParams) => Promise<InvokeContractResult>;
  loading: boolean;
  error: Error | null;
  data: InvokeContractResult | undefined;
  reset: () => void;
}

export function useInvokeContract(
  options: UseInvokeContractOptions = {},
): UseInvokeContractResult {
  const { client } = useLumen();
  const { policyGuardId, authorizedTargets } = options;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<InvokeContractResult>();

  const invoke = useCallback(
    async ({ walletId, contractId, method, args, fee }: InvokeContractParams) => {
      setLoading(true);
      setError(null);
      try {
        if (policyGuardId) {
          if (authorizedTargets && !authorizedTargets.includes(contractId)) {
            throw new Error(
              `Contract ${contractId} is not an authorized call target`,
            );
          }
          const registered = await client.isContractRegistered(
            policyGuardId,
            contractId,
          );
          if (!registered) {
            throw new Error(
              `Contract ${contractId} is not registered in policy-guard ${policyGuardId}`,
            );
          }
        }
        const result = await client.invokeContract(walletId, contractId, method, args, fee);
        setData(result);
        return result;
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        throw normalized;
      } finally {
        setLoading(false);
      }
    },
    [client, policyGuardId, authorizedTargets],
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setData(undefined);
  }, []);

  return { invoke, loading, error, data, reset };
}
