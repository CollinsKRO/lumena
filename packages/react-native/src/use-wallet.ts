import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "@lumen/core";
import { useLumenNative } from "./context.js";

export interface UseWalletResult {
  wallet: Wallet | undefined;
  error: Error | null;
  refetch: () => void;
}

export function useWallet(walletId: string): UseWalletResult {
  const { client } = useLumenNative();
  const [wallet, setWallet] = useState<Wallet | undefined>();
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(() => {
    try {
      setError(null);
      setWallet(client.getWallet(walletId));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [client, walletId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { wallet, error, refetch };
}
