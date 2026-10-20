import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { KeyManager } from "@lumen/core";
import type { LumenClient } from "@lumen/web-sdk";
import type { ExpoSecureStoreKeyStorage } from "./secure-store.js";

export interface LumenNativeContextValue {
  client: LumenClient;
  keyManager: KeyManager;
  storage: ExpoSecureStoreKeyStorage;
}

const LumenNativeContext = createContext<LumenNativeContextValue | null>(null);

export interface LumenNativeProviderProps {
  client: LumenClient;
  storage: ExpoSecureStoreKeyStorage;
  children: ReactNode;
}

export function LumenNativeProvider({
  client,
  storage,
  children,
}: LumenNativeProviderProps) {
  const value = useMemo(
    () => ({
      client,
      storage,
      keyManager: new KeyManager(storage),
    }),
    [client, storage],
  );

  return (
    <LumenNativeContext.Provider value={value}>
      {children}
    </LumenNativeContext.Provider>
  );
}

export function useLumenNative(): LumenNativeContextValue {
  const context = useContext(LumenNativeContext);
  if (!context) {
    throw new Error("LumenNativeProvider is required to use this hook");
  }
  return context;
}
