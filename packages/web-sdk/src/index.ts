export { LumenClient, createSessionKey } from "./client.js";
export type { LumenClientOpts, SessionKeyInfo } from "./client.js";

/**
 * Heavy passkey / crypto helpers are intentionally NOT re-exported from the
 * base entry point. Importing them eagerly would pull the WebAuthn + crypto
 * stack into the core bundle and blow past the 45KB gzipped budget.
 *
 * Consumers that need passkey support should load them lazily:
 *
 *   const { createWalletWithPasskey, signWithPasskey } = await import("@lumen/web-sdk/passkey");
 *
 * or use the helpers below, which wrap the dynamic import so the heavy
 * dependencies are only fetched on demand.
 */

export interface PasskeyWalletResult {
  credentialId: string;
  publicKey: string;
  address: string;
}

export interface PasskeyRegistrationOpts {
  userName: string;
  displayName?: string;
}

export interface PasskeyAssertionOpts {
  credentialId?: string;
  challenge?: Uint8Array;
}

export interface PasskeyCredential {
  id: string;
  rawId: ArrayBuffer;
  type: string;
}

/**
 * Lazily load the passkey module. The returned promise resolves to the
 * passkey helpers without adding them to the base bundle graph.
 */
export async function loadPasskeyModule(): Promise<{
  createWalletWithPasskey: (opts: PasskeyRegistrationOpts) => Promise<PasskeyWalletResult>;
  signWithPasskey: (opts: PasskeyAssertionOpts) => Promise<Uint8Array>;
  PasskeyManager: new () => {
    register(opts: PasskeyRegistrationOpts): Promise<PasskeyCredential>;
    assert(opts: PasskeyAssertionOpts): Promise<PasskeyCredential>;
  };
}> {
  return import("./passkey.js");
}

/**
 * Convenience wrapper: creates a wallet backed by a passkey, loading the
 * heavy crypto dependencies only when this function is actually called.
 */
export async function createWalletWithPasskey(
  opts: PasskeyRegistrationOpts,
): Promise<PasskeyWalletResult> {
  const { createWalletWithPasskey: create } = await loadPasskeyModule();
  return create(opts);
}

/**
 * Convenience wrapper: signs a payload with a passkey, loading the heavy
 * crypto dependencies only when this function is actually called.
 */
export async function signWithPasskey(opts: PasskeyAssertionOpts): Promise<Uint8Array> {
  const { signWithPasskey: sign } = await loadPasskeyModule();
  return sign(opts);
}