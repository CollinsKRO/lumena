/**
 * Cross-platform encrypted keystore for Lumen device keys.
 *
 * Implements AES-256-GCM authenticated encryption with memory-hard key
 * derivation (Argon2id via hash-wasm, with a PBKDF2 fallback at 100,000+
 * iterations when Argon2id is unavailable). The on-disk / exported format is a
 * versioned JSON envelope compatible with Stellar ecosystem keystore
 * recommendations and the envelope shape used by `keys/manager.ts`.
 *
 * @module keys/keystore
 */

import { argon2id } from 'hash-wasm';

/** Current keystore envelope version. */
export const KEYSTORE_VERSION = 1 as const;

/** Supported key-derivation functions. */
export type KdfName = 'argon2id' | 'pbkdf2';

/** Supported cipher identifier. */
export type CipherName = 'aes-256-gcm';

/** Argon2id key-derivation parameters. */
export interface Argon2idParams {
  /** Memory cost in kibibytes. */
  memoryKiB: number;
  /** Number of iterations (time cost). */
  iterations: number;
  /** Degree of parallelism. */
  parallelism: number;
  /** Derived key length in bytes. */
  keyLength: number;
}

/** PBKDF2 key-derivation parameters. */
export interface Pbkdf2Params {
  /** Hash algorithm used by PBKDF2. */
  hash: 'SHA-256' | 'SHA-512';
  /** Number of iterations (must be >= 100,000). */
  iterations: number;
  /** Derived key length in bytes. */
  keyLength: number;
}

/** Union of supported KDF parameter shapes. */
export type KdfParams = Argon2idParams | Pbkdf2Params;

/** Versioned encrypted keystore envelope. */
export interface KeystoreEnvelope {
  /** Envelope format version. */
  version: typeof KEYSTORE_VERSION;
  /** Key-derivation function used to derive the AES key. */
  kdf: KdfName;
  /** Parameters for the selected KDF. */
  kdfParams: KdfParams;
  /** Authenticated cipher identifier. */
  cipher: CipherName;
  /** Base64-encoded public key (Stellar G... address or raw key). */
  publicKey: string;
  /** Base64-encoded random salt (16 bytes). */
  salt: string;
  /** Base64-encoded random IV / nonce (12 bytes). */
  iv: string;
  /** Base64-encoded AES-256-GCM ciphertext (includes auth tag). */
  ciphertext: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Options for {@link encryptKeypair}. */
export interface EncryptOptions {
  /** KDF to use. Defaults to `'argon2id'` when available, else `'pbkdf2'`. */
  kdf?: KdfName;
  /** Override Argon2id parameters. */
  argon2id?: Partial<Argon2idParams>;
  /** Override PBKDF2 parameters. */
  pbkdf2?: Partial<Pbkdf2Params>;
  /** Public key to embed in the envelope (optional). */
  publicKey?: string;
  /** Override the creation timestamp (mainly for tests). */
  createdAt?: string;
}

/** Default Argon2id parameters (OWASP-recommended baseline). */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 64 * 1024, // 64 MiB
  iterations: 3,
  parallelism: 1,
  keyLength: 32,
};

/** Default PBKDF2 parameters (>= 100,000 iterations). */
export const DEFAULT_PBKDF2_PARAMS: Pbkdf2Params = {
  hash: 'SHA-256',
  iterations: 210_000,
  keyLength: 32,
};

const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_PBKDF2_ITERATIONS = 100_000;

/** Error thrown for keystore-related failures. */
export class KeystoreError extends Error {
  constructor(message: string, public readonly code: KeystoreErrorCode) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/** Machine-readable keystore error codes. */
export type KeystoreErrorCode =
  | 'INVALID_PASSPHRASE'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_KDF'
  | 'UNSUPPORTED_CIPHER'
  | 'INVALID_KDF_PARAMS'
  | 'DECRYPTION_FAILED'
  | 'CRYPTO_UNAVAILABLE';

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

interface WebCryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function getWebCrypto(): WebCryptoLike {
  const g = globalThis as unknown as {
    crypto?: WebCryptoLike;
  };
  if (!g.crypto || !g.crypto.subtle || typeof g.crypto.getRandomValues !== 'function') {
    throw new KeystoreError(
      'WebCrypto API is not available in this environment',
      'CRYPTO_UNAVAILABLE',
    );
  }
  return g.crypto;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  // Node.js fallback.
  const buf = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  if (buf) {
    return buf.from(bytes).toString('base64');
  }
  throw new KeystoreError('No base64 encoder available', 'CRYPTO_UNAVAILABLE');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  const buf = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  if (buf) {
    return new Uint8Array(buf.from(b64, 'base64'));
  }
  throw new KeystoreError('No base64 decoder available', 'CRYPTO_UNAVAILABLE');
}

function utf8Encode(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const buf = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  if (buf) {
    return new Uint8Array(buf.from(str, 'utf8'));
  }
  throw new KeystoreError('No UTF-8 encoder available', 'CRYPTO_UNAVAILABLE');
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  const buf = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  if (buf) {
    return buf.from(bytes).toString('utf8');
  }
  throw new KeystoreError('No UTF-8 decoder available', 'CRYPTO_UNAVAILABLE');
}

function randomBytes(length: number): Uint8Array {
  const crypto = getWebCrypto();
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

let argon2Available: boolean | undefined;

async function isArgon2Available(): Promise<boolean> {
  if (argon2Available !== undefined) {
    return argon2Available;
  }
  try {
    // hash-wasm exports argon2id; verify it is callable.
    argon2Available = typeof argon2id === 'function';
  } catch {
    argon2Available = false;
  }
  return argon2Available;
}

async function deriveArgon2id(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  const result = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.keyLength,
    outputType: 'binary',
  });
  return result instanceof Uint8Array ? result : new Uint8Array(result);
}

async function derivePbkdf2(
  passphrase: string,
  salt: Uint8Array,
  params: Pbkdf2Params,
): Promise<Uint8Array> {
  const crypto = getWebCrypto();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    utf8Encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: params.iterations,
      hash: params.hash,
    },
    baseKey,
    params.keyLength * 8,
  );
  return new Uint8Array(bits);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfName,
  params: KdfParams,
): Promise<Uint8Array> {
  if (kdf === 'argon2id') {
    return deriveArgon2id(passphrase, salt, params as Argon2idParams);
  }
  return derivePbkdf2(passphrase, salt, params as Pbkdf2Params);
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  const crypto = getWebCrypto();
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a secret keypair with a passphrase.
 *
 * @param secret     The secret to encrypt (e.g. Stellar `S...` secret key).
 * @param passphrase User-supplied passphrase.
 * @param opts       Optional KDF / envelope overrides.
 * @returns A versioned {@link KeystoreEnvelope}.
 */
export async function encryptKeypair(
  secret: string,
  passphrase: string,
  opts: EncryptOptions = {},
): Promise<KeystoreEnvelope> {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new KeystoreError('Secret must be a non-empty string', 'INVALID_ENVELOPE');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new KeystoreError('Passphrase must be a non-empty string', 'INVALID_PASSPHRASE');
  }

  const crypto = getWebCrypto();

  let kdf: KdfName;
  if (opts.kdf) {
    kdf = opts.kdf;
  } else {
    kdf = (await isArgon2Available()) ? 'argon2id' : 'pbkdf2';
  }

  let kdfParams: KdfParams;
  if (kdf === 'argon2id') {
    if (!(await isArgon2Available())) {
      throw new KeystoreError(
        'Argon2id is not available in this environment',
        'UNSUPPORTED_KDF',
      );
    }
    kdfParams = { ...DEFAULT_ARGON2ID_PARAMS, ...(opts.argon2id ?? {}) };
  } else {
    const merged = { ...DEFAULT_PBKDF2_PARAMS, ...(opts.pbkdf2 ?? {}) };
    if (merged.iterations < MIN_PBKDF2_ITERATIONS) {
      throw new KeystoreError(
        `PBKDF2 iterations must be >= ${MIN_PBKDF2_ITERATIONS}`,
        'INVALID_KDF_PARAMS',
      );
    }
    kdfParams = merged;
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const rawKey = await deriveKey(passphrase, salt, kdf, kdfParams);
  const aesKey = await importAesKey(rawKey);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    utf8Encode(secret),
  );

  return {
    version: KEYSTORE_VERSION,
    kdf,
    kdfParams,
    cipher: 'aes-256-gcm',
    publicKey: opts.publicKey ?? '',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Decrypt a keystore envelope with a passphrase.
 *
 * @param envelope   The keystore envelope to decrypt.
 * @param passphrase User-supplied passphrase.
 * @returns The decrypted secret string.
 * @throws {KeystoreError} On malformed envelope, unsupported version, or
 *         incorrect passphrase (AES-GCM auth-tag failure).
 */
export async function decryptKeypair(
  envelope: KeystoreEnvelope,
  passphrase: string,
): Promise<string> {
  validateEnvelope(envelope);

  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new KeystoreError('Passphrase must be a non-empty string', 'INVALID_PASSPHRASE');
  }

  const crypto = getWebCrypto();

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  if (salt.length !== SALT_BYTES) {
    throw new KeystoreError('Invalid salt length', 'INVALID_ENVELOPE');
  }
  if (iv.length !== IV_BYTES) {
    throw new KeystoreError('Invalid IV length', 'INVALID_ENVELOPE');
  }

  const rawKey = await deriveKey(passphrase, salt, envelope.kdf, envelope.kdfParams);
  const aesKey = await importAesKey(rawKey);

  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      ciphertext,
    );
  } catch {
    throw new KeystoreError(
      'Decryption failed: incorrect passphrase or corrupted keystore',
      'INVALID_PASSPHRASE',
    );
  }

  return utf8Decode(new Uint8Array(plaintextBuf));
}

/**
 * Serialize a keystore envelope to a JSON string for export.
 *
 * @param envelope The envelope to export.
 * @returns Pretty-printed JSON string.
 */
export function exportKeystore(envelope: KeystoreEnvelope): string {
  validateEnvelope(envelope);
  return JSON.stringify(envelope, null, 2);
}

/**
 * Import a keystore from a JSON string and decrypt it.
 *
 * @param json       The JSON keystore string.
 * @param passphrase User-supplied passphrase.
 * @returns The decrypted secret string.
 * @throws {KeystoreError} On malformed JSON, unsupported version, or wrong
 *         passphrase.
 */
export async function importKeystore(json: string, passphrase: string): Promise<string> {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new KeystoreError('Keystore JSON must be a non-empty string', 'INVALID_ENVELOPE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KeystoreError('Keystore JSON is malformed', 'INVALID_ENVELOPE');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeystoreError('Keystore JSON must be an object', 'INVALID_ENVELOPE');
  }

  const envelope = parsed as KeystoreEnvelope;
  validateEnvelope(envelope);

  return decryptKeypair(envelope, passphrase);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateEnvelope(envelope: unknown): asserts envelope is KeystoreEnvelope {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new KeystoreError('Keystore envelope must be an object', 'INVALID_ENVELOPE');
  }

  const env = envelope as Record<string, unknown>;

  if (env.version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      `Unsupported keystore version: ${String(env.version)}`,
      'UNSUPPORTED_VERSION',
    );
  }

  if (env.kdf !== 'argon2id' && env.kdf !== 'pbkdf2') {
    throw new KeystoreError(
      `Unsupported KDF: ${String(env.kdf)}`,
      'UNSUPPORTED_KDF',
    );
  }

  if (env.cipher !== 'aes-256-gcm') {
    throw new KeystoreError(
      `Unsupported cipher: ${String(env.cipher)}`,
      'UNSUPPORTED_CIPHER',
    );
  }

  if (!isNonEmptyString(env.salt)) {
    throw new KeystoreError('Missing or invalid salt', 'INVALID_ENVELOPE');
  }
  if (!isNonEmptyString(env.iv)) {
    throw new KeystoreError('Missing or invalid iv', 'INVALID_ENVELOPE');
  }
  if (!isNonEmptyString(env.ciphertext)) {
    throw new KeystoreError('Missing or invalid ciphertext', 'INVALID_ENVELOPE');
  }
  if (typeof env.publicKey !== 'string') {
    throw new KeystoreError('Missing or invalid publicKey', 'INVALID_ENVELOPE');
  }
  if (!isNonEmptyString(env.createdAt)) {
    throw new KeystoreError('Missing or invalid createdAt', 'INVALID_ENVELOPE');
  }

  const params = env.kdfParams;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new KeystoreError('Missing or invalid kdfParams', 'INVALID_KDF_PARAMS');
  }

  const p = params as Record<string, unknown>;

  if (env.kdf === 'argon2id') {
    if (
      typeof p.memoryKiB !== 'number' ||
      p.memoryKiB <= 0 ||
      typeof p.iterations !== 'number' ||
      p.iterations <= 0 ||
      typeof p.parallelism !== 'number' ||
      p.parallelism <= 0 ||
      typeof p.keyLength !== 'number' ||
      p.keyLength !== 32
    ) {
      throw new KeystoreError('Invalid Argon2id parameters', 'INVALID_KDF_PARAMS');
    }
  } else {
    if (
      (p.hash !== 'SHA-256' && p.hash !== 'SHA-512') ||
      typeof p.iterations !== 'number' ||
      p.iterations < MIN_PBKDF2_ITERATIONS ||
      typeof p.keyLength !== 'number' ||
      p.keyLength !== 32
    ) {
      throw new KeystoreError('Invalid PBKDF2 parameters', 'INVALID_KDF_PARAMS');
    }
  }
}