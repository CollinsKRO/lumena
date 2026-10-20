import * as SecureStore from "expo-secure-store";
import type { KeyStorage } from "@lumen/core";

const INDEX_KEY = "lumen_key_storage_index_v1";
const ITEM_PREFIX = "lumen_key_storage_item_";

export interface SecureStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * Synchronous KeyStorage facade for KeyManager backed by Expo SecureStore.
 * Call initialize() before passing this adapter to KeyManager and flush()
 * after writes to ensure asynchronous SecureStore failures are surfaced.
 */
export class ExpoSecureStoreKeyStorage implements KeyStorage {
  private readonly secureStore: SecureStoreAdapter;
  private readonly values = new Map<string, string>();
  private keys: string[] = [];
  private initialized = false;
  private initialization?: Promise<void>;
  private pendingWrites: Promise<void> = Promise.resolve();
  private persistenceError: Error | undefined;

  constructor(secureStore: SecureStoreAdapter = SecureStore) {
    this.secureStore = secureStore;
  }

  get length(): number {
    this.assertInitialized();
    return this.keys.length;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;

    this.initialization = this.load();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async load(): Promise<void> {
    this.values.clear();
    this.keys = [];
    const serializedKeys = await this.secureStore.getItemAsync(INDEX_KEY);
    let keys: string[] = [];

    if (serializedKeys !== null) {
      const parsed: unknown = JSON.parse(serializedKeys);
      if (
        !Array.isArray(parsed) ||
        parsed.some((key) => typeof key !== "string") ||
        new Set(parsed).size !== parsed.length
      ) {
        throw new Error("Expo SecureStore key index is invalid");
      }
      keys = parsed;
    }

    for (const key of keys) {
      const value = await this.secureStore.getItemAsync(this.itemKey(key));
      if (value !== null) {
        this.values.set(key, value);
        this.keys.push(key);
      }
    }

    this.initialized = true;
  }

  getItem(key: string): string | null {
    this.assertInitialized();
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.assertInitialized();
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);

    this.enqueue(async () => {
      await this.secureStore.setItemAsync(this.itemKey(key), value);
      await this.persistIndex();
    });
  }

  removeItem(key: string): void {
    this.assertInitialized();
    if (!this.values.delete(key)) return;
    this.keys = this.keys.filter((storedKey) => storedKey !== key);

    this.enqueue(async () => {
      await this.secureStore.deleteItemAsync(this.itemKey(key));
      await this.persistIndex();
    });
  }

  key(index: number): string | null {
    this.assertInitialized();
    return this.keys[index] ?? null;
  }

  async flush(): Promise<void> {
    this.assertInitialized();
    let pending: Promise<void>;
    do {
      pending = this.pendingWrites;
      await pending;
    } while (pending !== this.pendingWrites);

    if (this.persistenceError) {
      throw this.persistenceError;
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.pendingWrites = this.pendingWrites.then(async () => {
      try {
        await operation();
      } catch (error) {
        this.persistenceError ??=
          error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  private async persistIndex(): Promise<void> {
    await this.secureStore.setItemAsync(INDEX_KEY, JSON.stringify(this.keys));
  }

  private itemKey(key: string): string {
    return `${ITEM_PREFIX}${encodeURIComponent(key)}`;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ExpoSecureStoreKeyStorage must be initialized before it is used",
      );
    }
  }
}
