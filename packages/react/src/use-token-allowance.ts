import { useCallback, useEffect, useState } from "react";
import { useLumen } from "./context.js";

export interface TokenAllowance {
  /** Current allowance in the token's smallest unit. */
  amount: bigint;
  /** Ledger sequence after which the allowance expires, or `null` if none is stored. */
  expirationLedger: number | null;
}

export interface UseTokenAllowanceResult {
  allowance: TokenAllowance | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export interface ApproveTokenResult {
  hash: string;
  expirationLedger: number;
}

export interface UseApproveTokenResult {
  approve: (
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
    ttlLedgers: number,
  ) => Promise<ApproveTokenResult>;
  loading: boolean;
  error: Error | null;
  data: ApproveTokenResult | undefined;
  reset: () => void;
}

/**
 * Reads the SEP-41 `allowance(from, spender)` of a Soroban token for the
 * given owner wallet, together with the allowance's expiration ledger.
 *
 * @param tokenAddress   - The token contract address (C...).
 * @param spenderAddress - The address allowed to spend on the owner's behalf.
 * @param walletId       - The owner wallet id (account address).
 */
export function useTokenAllowance(
  tokenAddress: string,
  spenderAddress: string,
  walletId: string,
): UseTokenAllowanceResult {
  const { client } = useLumen();

  const [allowance, setAllowance] = useState<TokenAllowance>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [simulation, expirationLedger] = await Promise.all([
        client.simulateContract(walletId, tokenAddress, "allowance", [
          { value: walletId, type: "address" },
          { value: spenderAddress, type: "address" },
        ]),
        client.getAllowanceExpirationLedger(tokenAddress, walletId, spenderAddress),
      ]);

      if (!simulation.successful) {
        throw new Error(simulation.error ?? "Allowance simulation failed");
      }

      setAllowance({
        amount: BigInt(simulation.returnValue ?? 0),
        expirationLedger,
      });
    } catch (error) {
      setError(
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      setLoading(false);
    }
  }, [client, walletId, tokenAddress, spenderAddress]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    allowance,
    loading,
    error,
    refetch,
  };
}

/**
 * Grants a spender a SEP-41 allowance on a Soroban token by invoking the
 * token's `approve(from, spender, amount, expiration_ledger)` method.
 * The expiration ledger is computed as the latest ledger plus `ttlLedgers`.
 *
 * @param walletId - The owner wallet id (account address) signing the approval.
 */
export function useApproveToken(walletId: string): UseApproveTokenResult {
  const { client } = useLumen();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<ApproveTokenResult>();

  const approve = useCallback(
    async (
      tokenAddress: string,
      spenderAddress: string,
      amount: bigint,
      ttlLedgers: number,
    ): Promise<ApproveTokenResult> => {
      setLoading(true);
      setError(null);

      try {
        const latestLedger = await client.getLatestLedger();
        const expirationLedger = latestLedger + ttlLedgers;

        const { hash } = await client.invokeContract(walletId, tokenAddress, "approve", [
          { value: walletId, type: "address" },
          { value: spenderAddress, type: "address" },
          { value: amount, type: "i128" },
          { value: expirationLedger, type: "u32" },
        ]);

        const result = { hash, expirationLedger };
        setData(result);

        return result;
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));

        setError(normalizedError);
        throw normalizedError;
      } finally {
        setLoading(false);
      }
    },
    [client, walletId]
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setData(undefined);
  }, []);

  return {
    approve,
    loading,
    error,
    data,
    reset,
  };
}
