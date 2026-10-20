import { useCallback, useState } from "react";
import { useLumenNative } from "./context.js";

export interface NativeWalletResult {
  address: string;
  id: string;
  publicKey: string;
  mnemonic: string;
}

export interface NativeWalletRecovery {
  publicKey: string;
  mnemonic: string;
}

export interface UseCreateWalletResult {
  createWallet: (passphrase: string) => Promise<NativeWalletResult>;
  loading: boolean;
  error: Error | null;
  data: NativeWalletResult | undefined;
  recovery: NativeWalletRecovery | undefined;
  reset: () => void;
}

export function useCreateWallet(): UseCreateWalletResult {
  const { client, keyManager, storage } = useLumenNative();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<NativeWalletResult>();
  const [recovery, setRecovery] = useState<NativeWalletRecovery>();

  const createWallet = useCallback(
    async (passphrase: string): Promise<NativeWalletResult> => {
      setLoading(true);
      setError(null);
      let generated: { mnemonic: string; publicKey: string } | undefined;
      try {
        if (passphrase.length === 0) {
          throw new Error("A non-empty wallet encryption passphrase is required");
        }
        const { mnemonic, keypair } = keyManager.createFromMnemonic();
        generated = { mnemonic, publicKey: keypair.publicKey() };
        await keyManager.store(keypair, passphrase, { kdf: "pbkdf2" });
        await storage.flush();

        const wallet = await client.createWalletWithKeypair(keypair);
        const result = {
          address: wallet.address,
          id: wallet.id,
          publicKey: wallet.keypair.publicKey(),
          mnemonic,
        };
        setData(result);
        setRecovery(undefined);
        return result;
      } catch (cause) {
        const normalized = cause instanceof Error ? cause : new Error(String(cause));
        if (generated) setRecovery(generated);
        setError(normalized);
        throw normalized;
      } finally {
        setLoading(false);
      }
    },
    [client, keyManager, storage],
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setData(undefined);
    setRecovery(undefined);
  }, []);

  return { createWallet, loading, error, data, recovery, reset };
}
