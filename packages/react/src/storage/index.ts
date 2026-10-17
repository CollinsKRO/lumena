/**
 * Encrypted Client-Side Wallet State Persistence Driver
 *
 * Provides an IndexedDB-backed storage driver that encrypts sensitive wallet
 * state (address, session data, etc.) at rest using AES-256-GCM via WebCrypto.
 * The encryption key is derived from device credentials using PBKDF2.
 *
 * Features:
 * - AES-256-GCM authenticated encryption of sensitive fields
 * - PBKDF2 key derivation from device credentials
 * - Transparent decryption on unlock
 * - TTL / automatic expiration of stale session keys
 * - Purge of expired records on init
 *
 * @packageDocumentation
 */

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** A record persisted in the encrypted store. */
export interface EncryptedRecord {
  /** The logical key used to look up the record. */
  key: string;
  /** Base64-encoded AES-GCM ciphertext (includes auth tag). */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector. */
  iv: string;
  /** Base64-encoded PBKDF2 salt used for this record's key derivation. */
  salt: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Optional absolute expiration timestamp (ms since epoch). */
  expiresAt?: number;
}

/** Options for the encrypted storage driver. */
export interface EncryptedStorageOptions {
  /** IndexedDB database name. Defaults to `"lumen-wallet-state"`. */
  dbName?: string;
  /** IndexedDB object store name. Defaults to `"records"`. */
  storeName?: string;
  /** IndexedDB database version. Defaults to `1`. */
  dbVersion?: number;
  /** Device credentials used to derive the encryption key. */
  deviceCredentials: string;
  /** Default TTL in milliseconds applied to records without an explicit TTL. */
  defaultTtlMs?: number;
  /** PBKDF2 iteration count. Defaults to `210_000`. */
  iterations?: number;
}

/** Per-write options. */
export interface SetOptions {
  /** Absolute TTL in milliseconds from now. Overrides `defaultTtlMs`. */
  ttlMs?: number;
}

/** Public driver API. */
export interface EncryptedStorageDriver {
  /** Persist (encrypt) a value under `key`. */
  set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void>;
  /** Retrieve and decrypt a value. Returns `undefined` if missing/expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Remove a single record. */
  remove(key: string): Promise<void>;
  /** Remove all records. */
  clear(): Promise<void>;
  /** Purge all expired records. Returns the number of purged records. */
  purgeExpired(): Promise<number>;
  /** List all non-expired record keys. */
  keys(): Promise<string[]>;
  /** Close the underlying database connection. */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                              WebCrypto helpers                             */
/* -------------------------------------------------------------------------- */

const subtle: SubtleCrypto = (() => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error(
      "WebCrypto is not available in this environment. " +
        "An encrypted storage driver requires `crypto.subtle`.",
    );
  }
  return c.subtle;
})();

const getRandomValues = (bytes: Uint8Array): Uint8Array => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new Error("WebCrypto getRandomValues is not available.");
  }
  return c.getRandomValues(bytes);
};

const DEFAULT_ITERATIONS = 210_000;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

/** Encode bytes to base64 (browser + node compatible). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  // Node fallback
  return Buffer.from(bytes).toString("base64");
}

/** Decode base64 to bytes (browser + node compatible). */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  // Node fallback
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Derive an AES-256-GCM key from device credentials using PBKDF2.
 *
 * @param credentials - Device credentials (e.g. derived device secret).
 * @param salt - Per-record salt bytes.
 * @param iterations - PBKDF2 iteration count.
 */
export async function deriveKey(
  credentials: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    "raw",
    enc.encode(credentials),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a plaintext string with AES-256-GCM. */
export async function encryptString(
  plaintext: string,
  credentials: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const salt = getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(credentials, salt, iterations);
  const enc = new TextEncoder();
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    enc.encode(plaintext) as unknown as BufferSource,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
  };
}

/** Decrypt an AES-256-GCM ciphertext back to a plaintext string. */
export async function decryptString(
  ciphertext: string,
  iv: string,
  salt: string,
  credentials: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const key = await deriveKey(credentials, base64ToBytes(salt), iterations);
  const decrypted = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(iv) as unknown as BufferSource,
    },
    key,
    base64ToBytes(ciphertext) as unknown as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

/* -------------------------------------------------------------------------- */
/*                              IndexedDB wrapper                             */
/* -------------------------------------------------------------------------- */

const openDatabase = (
  dbName: string,
  storeName: string,
  version: number,
): Promise<IDBDatabase> => {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(
      new Error("IndexedDB is not available in this environment."),
    );
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(dbName, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: "key" });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("IndexedDB open request was blocked."));
  });
};

const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/* -------------------------------------------------------------------------- */
/*                              Driver factory                                */
/* -------------------------------------------------------------------------- */

/**
 * Create an encrypted IndexedDB storage driver.
 *
 * On initialization, expired records are automatically purged.
 *
 * @example
 * ```ts
 * const driver = await createEncryptedStorage({
 *   deviceCredentials: deviceSecret,
 *   defaultTtlMs: 1000 * 60 * 60 * 24,
 * });
 * await driver.set("wallet", { address: "G..." });
 * const wallet = await driver.get("wallet");
 * ```
 */
export async function createEncryptedStorage(
  options: EncryptedStorageOptions,
): Promise<EncryptedStorageDriver> {
  const {
    dbName = "lumen-wallet-state",
    storeName = "records",
    dbVersion = 1,
    deviceCredentials,
    defaultTtlMs,
    iterations = DEFAULT_ITERATIONS,
  } = options;

  if (!deviceCredentials) {
    throw new Error("deviceCredentials is required to derive an encryption key.");
  }

  const db = await openDatabase(dbName, storeName, dbVersion);

  const withStore = <T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result: T;
      try {
        const request = fn(store);
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  const isExpired = (record: EncryptedRecord, now = Date.now()): boolean =>
    typeof record.expiresAt === "number" && record.expiresAt <= now;

  const purgeExpired = async (): Promise<number> => {
    const now = Date.now();
    const all = await withStore<EncryptedRecord[]>("readonly", (store) =>
      store.getAll() as IDBRequest<EncryptedRecord[]>,
    );
    const expired = all.filter((r) => isExpired(r, now));
    if (expired.length === 0) return 0;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const record of expired) {
        store.delete(record.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    return expired.length;
  };

  // Purge stale session keys on init.
  await purgeExpired();

  const set = async <T>(
    key: string,
    value: T,
    setOptions: SetOptions = {},
  ): Promise<void> => {
    if (!key) throw new Error("A non-empty key is required.");
    const plaintext = JSON.stringify(value);
    const { ciphertext, iv, salt } = await encryptString(
      plaintext,
      deviceCredentials,
      iterations,
    );
    const now = Date.now();
    const ttl = setOptions.ttlMs ?? defaultTtlMs;
    const record: EncryptedRecord = {
      key,
      ciphertext,
      iv,
      salt,
      createdAt: now,
      ...(typeof ttl === "number" && ttl > 0
        ? { expiresAt: now + ttl }
        : {}),
    };
    await withStore<IDBValidKey>("readwrite", (store) => store.put(record));
  };

  const get = async <T>(key: string): Promise<T | undefined> => {
    const record = await withStore<EncryptedRecord | undefined>(
      "readonly",
      (store) => store.get(key) as IDBRequest<EncryptedRecord | undefined>,
    );
    if (!record) return undefined;

    if (isExpired(record)) {
      await remove(key);
      return undefined;
    }

    const plaintext = await decryptString(
      record.ciphertext,
      record.iv,
      record.salt,
      deviceCredentials,
      iterations,
    );
    return JSON.parse(plaintext) as T;
  };

  const remove = async (key: string): Promise<void> => {
    await withStore<undefined>("readwrite", (store) => store.delete(key));
  };

  const clear = async (): Promise<void> => {
    await withStore<undefined>("readwrite", (store) => store.clear());
  };

  const keys = async (): Promise<string[]> => {
    const now = Date.now();
    const all = await withStore<EncryptedRecord[]>("readonly", (store) =>
      store.getAll() as IDBRequest<EncryptedRecord[]>,
    );
    return all.filter((r) => !isExpired(r, now)).map((r) => r.key);
  };

  const close = async (): Promise<void> => {
    db.close();
  };

  return { set, get, remove, clear, purgeExpired, keys, close };
}

/* -------------------------------------------------------------------------- */
/*                          Convenience re-exports                            */
/* -------------------------------------------------------------------------- */

export { promisifyRequest };
```

---

### Unit tests — `packages/react/src/storage/index.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createEncryptedStorage,
  deriveKey,
  encryptString,
  decryptString,
  bytesToBase64,
  base64ToBytes,
  type EncryptedStorageDriver,
} from "./index";

/* -------------------------------------------------------------------------- */
/*                          In-memory IndexedDB mock                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal in-memory IndexedDB shim sufficient for the driver's usage
 * (open, createObjectStore, transaction, get/put/delete/getAll/clear).
 */
function installFakeIndexedDB() {
  type Row = Record<string, unknown>;
  const databases = new Map<string, Map<string, Map<string, Row>>>();

  class FakeRequest<T> {
    result!: T;
    error: unknown = null;
    onsuccess: (() => void) | null = null;
    onerror: (() => void) | null = null;
  }

  class FakeObjectStore {
    constructor(private data: Map<string, Row>) {}
    put(row: Row) {
      const req = new FakeRequest<IDBValidKey>();
      this.data.set(String(row.key), { ...row });
      req.result = row.key as IDBValidKey;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    get(key: string) {
      const req = new FakeRequest<Row | undefined>();
      const row = this.data.get(key);
      req.result = row ? { ...row } : undefined;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    delete(key: string) {
      const req = new FakeRequest<undefined>();
      this.data.delete(key);
      req.result = undefined;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    clear() {
      const req = new FakeRequest<undefined>();
      this.data.clear();
      req.result = undefined;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    getAll() {
      const req = new FakeRequest<Row[]>();
      req.result = Array.from(this.data.values()).map((r) => ({ ...r }));
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    createIndex() {
      return {} as IDBIndex;
    }
  }

  class FakeTransaction {
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error: unknown = null;
    constructor(private store: FakeObjectStore) {
      queueMicrotask(() => this.oncomplete?.());
    }
    objectStore() {
      return this.store;
    }
  }

  class FakeDatabase {
    objectStoreNames = {
      contains: (name: string) => databases.get(this.name)?.has(name) ?? false,
    };
    constructor(public name: string) {}
    createObjectStore(name: string) {
      const db = databases.get(this.name)!;
      if (!db.has(name)) db.set(name, new Map());
      return new FakeObjectStore(db.get(name)!);
    }
    transaction(storeName: string) {
      const db = databases.get(this.name)!;
      const store = db.get(storeName)!;
      return new FakeTransaction(new FakeObjectStore(store));
    }
    close() {}
  }

  const factory = {
    open(name: string) {
      const req = new FakeRequest<FakeDatabase>();
      if (!databases.has(name)) databases.set(name, new Map());
      const db = new FakeDatabase(name);
      req.result = db;
      queueMicrotask(() => {
        // Simulate upgrade path if store missing.
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      // Attach onupgradeneeded dynamically.
      (req as unknown as { onupgradeneeded: (() => void) | null }).onupgradeneeded =
        null;
      return req;
    },
  };

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = factory;
  return () => {
    delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

const CREDS = "device-secret-abc-123";

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});

describe("WebCrypto encrypt/decrypt", () => {
  it("derives a usable AES-256-GCM key", async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = await deriveKey(CREDS, salt, 1000);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  it("encrypts and decrypts a string", async () => {
    const { ciphertext, iv, salt } = await encryptString(
      "hello world",
      CREDS,
      1000,
    );
    expect(ciphertext).not.toContain("hello");
    const out = await decryptString(ciphertext, iv, salt, CREDS, 1000);
    expect(out).toBe("hello world");
  });

  it("fails to decrypt with wrong credentials", async () => {
    const { ciphertext, iv, salt } = await encryptString("secret", CREDS, 1000);
    await expect(
      decryptString(ciphertext, iv, salt, "wrong-creds", 1000),
    ).rejects.toBeTruthy();
  });
});

describe("EncryptedStorageDriver", () => {
  let cleanup: () => void;
  let driver: EncryptedStorageDriver;

  beforeEach(async () => {
    cleanup = installFakeIndexedDB();
    driver = await createEncryptedStorage({
      deviceCredentials: CREDS,
      iterations: 1000,
      dbName: `test-db-${Math.random()}`,
    });
  });

  afterEach(async () => {
    await driver.close();
    cleanup();
    vi.useRealTimers();
  });

  it("stores encrypted records at rest", async () => {
    await driver.set("wallet", { address: "GABC123" });
    // Read raw record directly from the fake DB via a fresh driver-less path.
    const raw = await new Promise<unknown>((resolve) => {
      const idb = (globalThis as unknown as { indexedDB: any }).indexedDB;
      const req = idb.open((driver as any).__dbName ?? "lumen-wallet-state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("records");
        const get = tx.objectStore("records").get("wallet");
        get.onsuccess = () => resolve(get.result);
      };
    });
    // The raw record must not contain the plaintext address.
    expect(JSON.stringify(raw)).not.toContain("GABC123");
  });

  it("transparently decrypts on get", async () => {
    await driver.set("wallet", { address: "GABC123", network: "testnet" });
    const value = await driver.get<{ address: string; network: string }>(
      "wallet",
    );
    expect(value).toEqual({ address: "GABC123", network: "testnet" });
  });

  it("returns undefined for missing keys", async () => {
    expect(await driver.get("nope")).toBeUndefined();
  });

  it("removes a single record", async () => {
    await driver.set("a", 1);
    await driver.remove("a");
    expect(await driver.get("a")).toBeUndefined();
  });

  it("clears all records", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    await driver.clear();
    expect(await driver.keys()).toEqual([]);
  });

  it("lists non-expired keys", async () => {
    await driver.set("a", 1);
    await driver.set("b", 2);
    expect((await driver.keys()).sort()).toEqual(["a", "b"]);
  });

  it("expires records after TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await driver.set("session", { token: "x" }, { ttlMs: 1000 });
    expect(await driver.get("session")).toEqual({ token: "x" });

    vi.setSystemTime(new Date("2024-01-01T00:00:02Z"));
    expect(await driver.get("session")).toBeUndefined();
  });

  it("purges expired records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    await driver.set("old", 1, { ttlMs: 1000 });
    await driver.set("fresh", 2, { ttlMs: 60_000 });

    vi.setSystemTime(new Date("2024-01-01T00:00:05Z"));
    const purged = await driver.purgeExpired();
    expect(purged).toBe(1);
    expect((await driver.keys()).sort()).toEqual(["fresh"]);
  });

  it("purges stale keys on init", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const dbName = `init-purge-${Math.random()}`;
    const first = await createEncryptedStorage({
      deviceCredentials: CREDS,
      iterations: 1000,
      dbName,
    });
    await first.set("stale", 1, { ttlMs: 1000 });
    await first.close();

    vi.setSystemTime(new Date("2024-01-01T00:00:10Z"));
    const second = await createEncryptedStorage({
      deviceCredentials: CREDS,
      iterations: 1000,
      dbName,
    });
    expect(await second.keys()).toEqual([]);
    await second.close();
  });

  it("applies default TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const dbName = `default-ttl-${Math.random()}`;
    const d = await createEncryptedStorage({
      deviceCredentials: CREDS,
      iterations: 1000,
      dbName,
      defaultTtlMs: 1000,
    });
    await d.set("k", "v");
    vi.setSystemTime(new Date("2024-01-01T00:00:02Z"));
    expect(await d.get("k")).toBeUndefined();
    await d.close();
  });

  it("rejects when deviceCredentials missing", async () => {
    await expect(
      createEncryptedStorage({ deviceCredentials: "" }),
    ).rejects.toThrow(/deviceCredentials/);
  });
});