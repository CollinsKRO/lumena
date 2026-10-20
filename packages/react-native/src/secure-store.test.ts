import { describe, expect, it, vi } from "vitest";
import {
  ExpoSecureStoreKeyStorage,
  type SecureStoreAdapter,
} from "./secure-store.js";

function createSecureStore(): SecureStoreAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

describe("ExpoSecureStoreKeyStorage", () => {
  it("requires initialization and persists values across instances", async () => {
    const secureStore = createSecureStore();
    const storage = new ExpoSecureStoreKeyStorage(secureStore);

    expect(() => storage.getItem("key")).toThrow(/must be initialized/);
    await storage.initialize();
    storage.setItem("lumen:key-manager:GABC", "encrypted");
    await storage.flush();

    const restored = new ExpoSecureStoreKeyStorage(secureStore);
    await restored.initialize();
    expect(restored.length).toBe(1);
    expect(restored.key(0)).toBe("lumen:key-manager:GABC");
    expect(restored.getItem("lumen:key-manager:GABC")).toBe("encrypted");
  });

  it("removes a persisted value and updates its index", async () => {
    const secureStore = createSecureStore();
    const storage = new ExpoSecureStoreKeyStorage(secureStore);
    await storage.initialize();
    storage.setItem("first", "one");
    storage.setItem("second", "two");
    await storage.flush();

    storage.removeItem("first");
    await storage.flush();

    const restored = new ExpoSecureStoreKeyStorage(secureStore);
    await restored.initialize();
    expect(restored.length).toBe(1);
    expect(restored.key(0)).toBe("second");
    expect(restored.getItem("first")).toBeNull();
  });

  it("surfaces asynchronous secure-store failures from flush", async () => {
    const secureStore = createSecureStore();
    vi.mocked(secureStore.setItemAsync).mockRejectedValueOnce(
      new Error("secure storage unavailable"),
    );
    const storage = new ExpoSecureStoreKeyStorage(secureStore);
    await storage.initialize();
    storage.setItem("key", "value");

    await expect(storage.flush()).rejects.toThrow("secure storage unavailable");
  });
});
