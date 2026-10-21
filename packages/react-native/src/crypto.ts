import { install } from "react-native-quick-crypto";
import { Buffer } from "buffer";

/**
 * Installs react-native-quick-crypto's WebCrypto-compatible API globally.
 * Call this once from the app entry point before using Lumen key management.
 */
export function installNativeCrypto(): void {
  install();
  const nativeGlobal = globalThis as typeof globalThis & {
    Buffer?: typeof Buffer;
  };
  nativeGlobal.Buffer ??= Buffer;

  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.getRandomValues !== "function" ||
    typeof globalThis.crypto.subtle === "undefined"
  ) {
    throw new Error(
      "@lumen/react-native: react-native-quick-crypto did not install WebCrypto.",
    );
  }
}
