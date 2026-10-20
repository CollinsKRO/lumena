# @lumen/react-native

Native React hooks and Expo SecureStore integration for Lumen wallets on iOS
and Android.

## Setup

Install the package with `expo-secure-store` and `react-native-quick-crypto`.
Call `installNativeCrypto()` once from the app entry point before using Lumen
key management. Initialize `ExpoSecureStoreKeyStorage` before constructing the
provider:

```tsx
import { useEffect, useState } from "react";
import { LumenClient } from "@lumen/web-sdk";
import {
  ExpoSecureStoreKeyStorage,
  LumenNativeProvider,
  installNativeCrypto,
} from "@lumen/react-native";

installNativeCrypto();

export function Root() {
  const [runtime, setRuntime] = useState<{
    client: LumenClient;
    storage: ExpoSecureStoreKeyStorage;
  }>();

  useEffect(() => {
    const storage = new ExpoSecureStoreKeyStorage();
    void storage.initialize().then(() => {
      setRuntime({
        storage,
        client: new LumenClient({
          network: "testnet",
          serverUrl: "https://your-lumen-server.example",
          serverPublicKey: "G...",
        }),
      });
    });
  }, []);

  if (!runtime) return null;
  return (
    <LumenNativeProvider client={runtime.client} storage={runtime.storage}>
      {/* Native screens */}
    </LumenNativeProvider>
  );
}
```

`ExpoSecureStoreKeyStorage` implements Lumen's synchronous `KeyStorage`
interface with an initialized in-memory cache. After using `KeyManager.store`,
await `storage.flush()` to persist queued SecureStore writes and surface native
storage errors. The `useCreateWallet` hook does this automatically and uses
WebCrypto PBKDF2 to avoid a WASM dependency in React Native before registering
the resulting signer with the configured Lumen server.

```tsx
const { createWallet, loading, error, data } = useCreateWallet();
const { wallet } = useWallet(data?.id ?? "");

const created = await createWallet("user-chosen passphrase");
// Save created.mnemonic offline; it is not stored in SecureStore.
```

If remote wallet creation or multisig setup fails after key generation, the
hook exposes the mnemonic in `recovery` so the locally stored signer is not
orphaned without a recovery phrase.

See [`examples/expo`](../../examples/expo) for wallet setup and submission of a
co-signed testnet transaction.
