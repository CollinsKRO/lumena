"use client";

import { useCallback, useState } from "react";
import { useLumen } from "./context.js";
import { useBalance } from "./use-balance.js";
import { useToast, type ToastContextValue } from "./components/LumenToast.js";

export interface GaslessTransactionParams {
  destination: string;
  amount: string;
}

export interface GaslessTransactionResult {
  hash: string;
}

export interface UseGaslessTransactionResult {
  execute: (params: GaslessTransactionParams) => Promise<GaslessTransactionResult>;
  /** Balance including any optimistic, not yet confirmed, updates. */
  balance: string | undefined;
  loading: boolean;
  error: Error | null;
  data: GaslessTransactionResult | undefined;
  reset: () => void;
}

const DECIMALS = 7;

function toStroops(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(DECIMALS, "0").slice(0, DECIMALS));
}

function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const digits = (negative ? -stroops : stroops).toString().padStart(DECIMALS + 1, "0");
  const whole = digits.slice(0, -DECIMALS);
  const fraction = digits.slice(-DECIMALS);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Returns the toast dispatcher when rendered inside a LumenToastProvider. */
function useOptionalToast(): ToastContextValue | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

/**
 * Executes a payment while immediately applying an optimistic update to the
 * local balance. If the transaction fails or is rejected by policy, the
 * balance rolls back to the pre-transaction snapshot and an error toast is
 * emitted (when a LumenToastProvider is present).
 */
export function useGaslessTransaction(
  walletId: string,
  assetCode = "XLM"
): UseGaslessTransactionResult {
  const { client } = useLumen();
  const toast = useOptionalToast();
  const { balance: confirmedBalance, refetch } = useBalance(walletId, assetCode);

  const [optimisticBalance, setOptimisticBalance] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<GaslessTransactionResult>();

  const balance = optimisticBalance ?? confirmedBalance;

  const execute = useCallback(
    async ({ destination, amount }: GaslessTransactionParams): Promise<GaslessTransactionResult> => {
      const snapshot = optimisticBalance;
      const current = optimisticBalance ?? confirmedBalance;

      setLoading(true);
      setError(null);

      if (current !== undefined) {
        setOptimisticBalance(fromStroops(toStroops(current) - toStroops(amount)));
      }

      try {
        const result = await client.sendPayment(walletId, destination, assetCode, amount);

        setData(result);
        await refetch();
        setOptimisticBalance(undefined);

        return result;
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));

        setOptimisticBalance(snapshot);
        setError(normalizedError);
        toast?.dispatchTransactionEvent("failed", normalizedError.message);
        throw normalizedError;
      } finally {
        setLoading(false);
      }
    },
    [client, walletId, assetCode, optimisticBalance, confirmedBalance, refetch, toast]
  );

  const reset = useCallback(() => {
    setOptimisticBalance(undefined);
    setLoading(false);
    setError(null);
    setData(undefined);
  }, []);

  return {
    execute,
    balance,
    loading,
    error,
    data,
    reset,
  };
}
