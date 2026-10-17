"use client";

import { useCallback, useEffect, useState } from "react";
import { useLumen } from "./context.js";

export interface UseBalanceResult {
  balance: string | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const DEFAULT_REFRESH_INTERVAL = 10_000;

export function useBalance(
  walletId: string,
  assetCode?: string,
  refreshInterval = DEFAULT_REFRESH_INTERVAL
): UseBalanceResult {
  const { client } = useLumen();

  const [balance, setBalance] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const nextBalance = await client.getBalance(walletId, assetCode);
      setBalance(nextBalance);
    } catch (error) {
      setError(
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      setLoading(false);
    }
  }, [client, walletId, assetCode]);

  useEffect(() => {
    void refetch();

    if (refreshInterval <= 0) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refetch();
    }, refreshInterval);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refetch, refreshInterval]);

  return {
    balance,
    loading,
    error,
    refetch,
  };
}