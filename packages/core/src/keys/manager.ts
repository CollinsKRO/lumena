import { Keypair } from "@stellar/stellar-sdk";
import { argon2id } from "hash-wasm";

export interface StoredKey {
  publicKey: string;
  encryptedSecret: string;
  createdAt: Date;
}

/**
 * Versioned encrypted keystore envelope shared by the CLI export command and
 * the core key manager. The envelope is JSON-serializable so it can be written
 * to disk and imported on another machine.
 */
export interface KeystoreEnvelope {
  version: 1;
  kdf: "argon2id";
  cipher: "aes-256-gcm";
  publicKey: string;
  createdAt: string;
  salt: string;
  iv: string;
  ciphertext: string;
  /** Argon2id parameters used to derive the encryption key. */
  kdfParams: {
    iterations: number;
    memorySize: number;
    parallelism: number;
    hashLength: number;
  };
}

export const KEYSTORE_VERSION = 1 as const;

export const DEFAULT_ARGON2ID_PARAMS = {
  iterations: 3,
  memorySize: 65536,
  parallelism: 1,
  hashLength: 32,
} as const;

export type Argon2idParams = typeof DEFAULT_ARGON2ID_PARAMS;

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Keystore field "${field}" is invalid`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Keystore field "${field}" is invalid`);
  }
  return value;
}

/**
 * Parses and validates a versioned encrypted keystore envelope. Throws when the
 * payload is malformed or uses an unsupported version/algorithm.
 */
export function parseKeystoreEnvelope(input: string | unknown): KeystoreEnvelope {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error("Keystore file is not valid JSON");
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Keystore data is invalid");
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== KEYSTORE_VERSION) {
    throw new Error(`Unsupported keystore version: ${String(candidate.version)}`);
  }
  if (candidate.kdf !== "argon2id") {
    throw new Error(`Unsupported keystore KDF: ${String(candidate.kdf)}`);
  }
  if (candidate.cipher !== "aes-256-gcm") {
    throw new Error(`Unsupported keystore cipher: ${String(candidate.cipher)}`);
  }

  const kdfParamsRaw = candidate.kdfParams;
  if (typeof kdfParamsRaw !== "object" || kdfParamsRaw === null || Array.isArray(kdfParamsRaw)) {
    throw new Error('Keystore field "kdfParams" is invalid');
  }
  const kdfParams = kdfParamsRaw as Record<string, unknown>;

  const createdAt = assertNonEmptyString(candidate.createdAt, "createdAt");
  if (Number.isNaN(new Date(createdAt).getTime())) {
    throw new Error('Keystore field "createdAt" is invalid');
  }

  return {
    version: KEYSTORE_VERSION,
    kdf: "argon2id",
    cipher: "aes-256-gcm",
    publicKey: assertNonEmptyString(candidate.publicKey, "publicKey"),
    createdAt,
    salt: assertNonEmptyString(candidate.salt, "salt"),
    iv: assertNonEmptyString(candidate.iv, "iv"),
    ciphertext: assertNonEmptyString(candidate.ciphertext, "ciphertext"),
    kdfParams: {
      iterations: assertPositiveInteger(kdfParams.iterations, "kdfParams.iterations"),
      memorySize: assertPositiveInteger(kdfParams.memorySize, "kdfParams.memorySize"),
      parallelism: assertPositiveInteger(kdfParams.parallelism, "kdfParams.parallelism"),
      hashLength: assertPositiveInteger(kdfParams.hashLength, "kdfParams.hashLength"),
    },
  };
}

async function deriveArgon2idKey(
  password: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    iterations: params.iterations,
    memorySize: params.memorySize,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: "binary",
  });
}

/**
 * Encrypts a Stellar secret key into a versioned AES-256-GCM keystore envelope
 * using an Argon2id-derived key. Shared by the CLI export command and the core
 * key manager so both produce an identical on-disk format.
 */
export async function encryptKeystore(
  secret: string,
  password: string,
  options: { publicKey?: string; params?: Argon2idParams; createdAt?: Date } = {},
): Promise<KeystoreEnvelope> {
  const params: Argon2idParams = { ...DEFAULT_ARGON2ID_PARAMS, ...options.params };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const rawKey = await deriveArgon2idKey(password, salt, params);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    new TextEncoder().encode(secret),
  );

  const publicKey = options.publicKey ?? Keypair.fromSecret(secret).publicKey();

  return {
    version: KEYSTORE_VERSION,
    kdf: "argon2id",
    cipher: "aes-256-gcm",
    publicKey,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    salt: Buffer.from(salt).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(encrypted).toString("base64"),
    kdfParams: { ...params },
  };
}

/**
 * Decrypts a versioned keystore envelope, verifying the AES-GCM auth tag, and
 * reconstructs the StoredKey/Keypair. Throws on wrong password or tampering.
 */
export async function decryptKeystore(
  envelope: KeystoreEnvelope | string,
  password: string,
): Promise<{ keypair: Keypair; storedKey: StoredKey }> {
  const parsed = parseKeystoreEnvelope(envelope);
  const salt = Buffer.from(parsed.salt, "base64");
  const iv = Buffer.from(parsed.iv, "base64");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64");

  const rawKey = await deriveArgon2idKey(password, salt, parsed.kdfParams);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aesKey,
      ciphertext as BufferSource,
    );
  } catch {
    throw new Error("Failed to decrypt keystore: invalid password or corrupted data");
  }

  const secret = new TextDecoder().decode(decrypted);
  const keypair = Keypair.fromSecret(secret);

  if (keypair.publicKey() !== parsed.publicKey) {
    throw new Error("Keystore public key does not match decrypted secret");
  }

  const storedKey: StoredKey = {
    publicKey: parsed.publicKey,
    encryptedSecret: `${parsed.salt}.${parsed.iv}.${parsed.ciphertext}`,
    createdAt: new Date(parsed.createdAt),
  };

  return { keypair, storedKey };
}

export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const STORAGE_PREFIX = "lumen:key-manager:";

function createMemoryStorage(): KeyStorage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => Array.from(values.keys())[index] ?? null,
  };
}

function getDefaultStorage(): KeyStorage {
  return typeof globalThis.localStorage === "undefined"
    ? createMemoryStorage()
    : globalThis.localStorage;
}

function parseStoredKey(value: string): StoredKey {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored key data is invalid");
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.publicKey !== "string" ||
    typeof candidate.encryptedSecret !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    throw new Error("Stored key data is invalid");
  }

  const createdAt = new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("Stored key creation date is invalid");
  }

  return {
    publicKey: candidate.publicKey,
    encryptedSecret: candidate.encryptedSecret,
    createdAt,
  };
}

export class KeyManager {
  private readonly storage: KeyStorage;

  constructor(storage: KeyStorage = getDefaultStorage()) {
    this.storage = storage;
  }

  generateKeypair(): Keypair {
    return Keypair.random();
  }

  async deriveFromOAuth(provider: string, token: string, salt?: string): Promise<Keypair> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const data = encoder.encode(`${provider}:${salt ?? "lumen-derivation"}`);
    const signature = await crypto.subtle.sign("HMAC", keyMaterial, data);
    const seed = Buffer.from(new Uint8Array(signature).slice(0, 32));

    return Keypair.fromRawEd25519Seed(seed);
  }

  async store(key: Keypair, passphrase: string): Promise<StoredKey> {
    const envelope = await encryptKeystore(key.secret(), passphrase, {
      publicKey: key.publicKey(),
    });

    const stored: StoredKey = {
      publicKey: envelope.publicKey,
      encryptedSecret: `${envelope.salt}.${envelope.iv}.${envelope.ciphertext}`,
      createdAt: new Date(envelope.createdAt),
    };
    this.storage.setItem(`${STORAGE_PREFIX}${stored.publicKey}`, JSON.stringify(stored));
    return stored;
  }

  /**
   * Exports a stored key as a versioned AES-256-GCM keystore envelope that can
   * be written to disk and imported on another machine.
   */
  async export(publicKey: string, passphrase: string): Promise<KeystoreEnvelope> {
    const storedValue = this.storage.getItem(`${STORAGE_PREFIX}${publicKey}`);
    if (storedValue === null) throw new Error(`Key not found: ${publicKey}`);
    const stored = parseStoredKey(storedValue);

    const [saltB64, ivB64, cipherB64] = stored.encryptedSecret.split(".");
    if (!saltB64 || !ivB64 || !cipherB64) {
      throw new Error("Stored key data is invalid");
    }

    const salt = Buffer.from(saltB64, "base64");
    const iv = Buffer.from(ivB64, "base64");
    const ciphertext = Buffer.from(cipherB64, "base64");

    const rawKey = await deriveArgon2idKey(passphrase, salt, DEFAULT_ARGON2ID_PARAMS);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawKey as BufferSource,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        aesKey,
        ciphertext as BufferSource,
      );
    } catch {
      throw new Error("Failed to decrypt keystore: invalid password or corrupted data");
    }

    const secret = new TextDecoder().decode(decrypted);
    return encryptKeystore(secret, passphrase, {
      publicKey: stored.publicKey,
      createdAt: stored.createdAt,
    });
  }

  /**
   * Imports a versioned keystore envelope, decrypting it and persisting the
   * resulting key in local storage.
   */
  async import(envelope: KeystoreEnvelope | string, passphrase: string): Promise<StoredKey> {
    const { storedKey } = await decryptKeystore(envelope, passphrase);
    this.storage.setItem(
      `${STORAGE_PREFIX}${storedKey.publicKey}`,
      JSON.stringify(storedKey),
    );
    return storedKey;
  }

  async load(publicKey: string, passphrase: string): Promise<Keypair> {
    const storedValue = this.storage.getItem(`${STORAGE_PREFIX}${publicKey}`);
    if (storedValue === null) throw new Error(`Key not found: ${publicKey}`);
    const stored = parseStoredKey(storedValue);

    const [saltB64, ivB64, cipherB64] = stored.encryptedSecret.split(".");
    if (!saltB64 || !ivB64 || !cipherB64) {
      throw new Error("Stored key data is invalid");
    }

    const salt = Buffer.from(saltB64, "base64");
    const iv = Buffer.from(ivB64, "base64");
    const ciphertext = Buffer.from(cipherB64, "base64");

    const rawKey = await deriveArgon2idKey(passphrase, salt, DEFAULT_ARGON2ID_PARAMS);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawKey as BufferSource,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        aesKey,
        ciphertext as BufferSource,
      );
    } catch {
      throw new Error("Failed to decrypt keystore: invalid password or corrupted data");
    }

    const secret = new TextDecoder().decode(decrypted);
    return Keypair.fromSecret(secret);
  }

  list(): StoredKey[] {
    const storedKeys: StoredKey[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const storageKey = this.storage.key(index);
      if (storageKey?.startsWith(STORAGE_PREFIX)) {
        const value = this.storage.getItem(storageKey);
        if (value !== null) {
          storedKeys.push(parseStoredKey(value));
        }
      }
    }
    return storedKeys;
  }

  delete(publicKey: string): boolean {
    const storageKey = `${STORAGE_PREFIX}${publicKey}`;
    if (this.storage.getItem(storageKey) === null) {
      return false;
    }
    this.storage.removeItem(storageKey);
    return true;
  }
}
