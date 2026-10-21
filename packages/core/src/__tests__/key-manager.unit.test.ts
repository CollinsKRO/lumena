import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KeyManager, type KeyStorage } from "../keys/manager.js";
import { Keypair } from "@stellar/stellar-sdk";

function createStorage(): KeyStorage {
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

describe("KeyManager", () => {
  let keyManager: KeyManager;

  beforeEach(() => {
    keyManager = new KeyManager();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("generateKeypair", () => {
    it("generates a valid Keypair", () => {
      const kp = keyManager.generateKeypair();
      expect(kp).toBeInstanceOf(Keypair);
      expect(typeof kp.publicKey()).toBe("string");
      expect(kp.publicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    });
  });

  describe("store", () => {
    it("stores a key and returns StoredKey", async () => {
      const kp = keyManager.generateKeypair();
      const stored = await keyManager.store(kp, "test-passphrase");

      expect(stored).toHaveProperty("publicKey");
      expect(stored).toHaveProperty("encryptedSecret");
      expect(stored).toHaveProperty("createdAt");
      expect(stored.publicKey).toBe(kp.publicKey());
      expect(stored.publicKey).not.toBe("");
      expect(typeof stored.encryptedSecret).toBe("string");
      expect(stored.encryptedSecret).not.toBe("");

      const loaded = await keyManager.load(stored.publicKey, "test-passphrase");
      expect(loaded.publicKey()).toBe(kp.publicKey());
    });

    it("store and load round-trip with correct passphrase returns the original keypair", async () => {
      const originalKeypair = keyManager.generateKeypair();
      const originalPublicKey = originalKeypair.publicKey();
      const originalSecret = originalKeypair.secret();

      const stored = await keyManager.store(originalKeypair, "correct-passphrase");
      const loadedKeypair = await keyManager.load(stored.publicKey, "correct-passphrase");

      expect(loadedKeypair.publicKey()).toBe(originalPublicKey);
      expect(loadedKeypair.secret()).toBe(originalSecret);
    });

    it("load with wrong passphrase throws a decryption error", async () => {
      const kp = keyManager.generateKeypair();
      const stored = await keyManager.store(kp, "correct-passphrase");

      await expect(keyManager.load(stored.publicKey, "wrong-passphrase")).rejects.toThrow();
    });
  });

  describe("load", () => {
    it("loads a previously stored key", async () => {
      const kp = keyManager.generateKeypair();
      const stored = await keyManager.store(kp, "test-passphrase");

      const loaded = await keyManager.load(stored.publicKey, "test-passphrase");
      expect(loaded.publicKey()).toBe(kp.publicKey());
    });

    it("throws Key not found error for unknown public key", async () => {
      const unknownPublicKey = Keypair.random().publicKey();
      await expect(keyManager.load(unknownPublicKey, "test-passphrase")).rejects.toThrow(
        `Key not found: ${unknownPublicKey}`,
      );
    });
  });

  describe("list", () => {
    it("returns all stored keys", async () => {
      const storage = createStorage();
      const manager = new KeyManager(storage);

      const kp1 = manager.generateKeypair();
      const kp2 = manager.generateKeypair();
      const kp3 = manager.generateKeypair();

      await manager.store(kp1, "pass1");
      await manager.store(kp2, "pass2");
      await manager.store(kp3, "pass3");

      const listedKeys = manager.list();
      expect(listedKeys).toHaveLength(3);
      expect(listedKeys.map((k) => k.publicKey)).toContain(kp1.publicKey());
      expect(listedKeys.map((k) => k.publicKey)).toContain(kp2.publicKey());
      expect(listedKeys.map((k) => k.publicKey)).toContain(kp3.publicKey());
    });

    it("returns empty array when no keys are stored", () => {
      const storage = createStorage();
      const manager = new KeyManager(storage);
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe("delete", () => {
    it("removes the stored key and reports whether it existed", async () => {
      const manager = new KeyManager(createStorage());
      const stored = await manager.store(manager.generateKeypair(), "test-passphrase");

      expect(manager.delete(stored.publicKey)).toBe(true);
      expect(manager.list()).toEqual([]);
      expect(manager.delete(stored.publicKey)).toBe(false);
      await expect(manager.load(stored.publicKey, "test-passphrase")).rejects.toThrow(
        `Key not found: ${stored.publicKey}`,
      );
    });
  });

  it("restores encrypted keys from browser storage in a new manager", async () => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    const firstManager = new KeyManager();
    const keypair = firstManager.generateKeypair();
    const stored = await firstManager.store(keypair, "test-passphrase");

    const persistedValue = storage.getItem(`lumen:key-manager:${stored.publicKey}`);
    expect(persistedValue).not.toContain(keypair.secret());

    const restoredManager = new KeyManager();
    const restoredKeys = restoredManager.list();
    expect(restoredKeys).toHaveLength(1);
    expect(restoredKeys[0].createdAt).toEqual(stored.createdAt);

    const restoredKeypair = await restoredManager.load(stored.publicKey, "test-passphrase");
    expect(restoredKeypair.publicKey()).toBe(keypair.publicKey());
  });

  describe("generateFromOAuth", () => {
    it("derives a keypair from OAuth token", async () => {
      const kp = await keyManager.deriveFromOAuth("google", "test-oauth-token", "salt-value");
      expect(kp).toBeInstanceOf(Keypair);
      expect(typeof kp.publicKey()).toBe("string");
    });

    it("derives a keypair without salt", async () => {
      const kp = await keyManager.deriveFromOAuth("github", "another-token");
      expect(kp).toBeInstanceOf(Keypair);
    });
  });

  describe("encrypted keystore export/import", () => {
    it("exports an envelope containing salt, IV, ciphertext and auth tag", async () => {
      const kp = keyManager.generateKeypair();
      const envelope = await keyManager.exportKeystore(kp, "strong-password");

      expect(envelope).toHaveProperty("salt");
      expect(envelope).toHaveProperty("iv");
      expect(envelope).toHaveProperty("ciphertext");
      expect(envelope).toHaveProperty("authTag");

      expect(typeof envelope.salt).toBe("string");
      expect(typeof envelope.iv).toBe("string");
      expect(typeof envelope.ciphertext).toBe("string");
      expect(typeof envelope.authTag).toBe("string");

      expect(envelope.salt).not.toBe("");
      expect(envelope.iv).not.toBe("");
      expect(envelope.ciphertext).not.toBe("");
      expect(envelope.authTag).not.toBe("");

      // The plaintext secret must never appear in the serialized envelope.
      expect(JSON.stringify(envelope)).not.toContain(kp.secret());
    });

    it("round-trips: importing with the correct password restores the keypair", async () => {
      const original = keyManager.generateKeypair();
      const envelope = await keyManager.exportKeystore(original, "strong-password");

      const restored = await keyManager.importKeystore(envelope, "strong-password");

      expect(restored.publicKey()).toBe(original.publicKey());
      expect(restored.secret()).toBe(original.secret());
    });

    it("fails auth-tag verification when the password is wrong", async () => {
      const original = keyManager.generateKeypair();
      const envelope = await keyManager.exportKeystore(original, "correct-password");

      await expect(keyManager.importKeystore(envelope, "wrong-password")).rejects.toThrow();
    });

    it("fails auth-tag verification when the ciphertext is tampered with", async () => {
      const original = keyManager.generateKeypair();
      const envelope = await keyManager.exportKeystore(original, "strong-password");

      const tampered = {
        ...envelope,
        ciphertext: envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.endsWith("00") ? "11" : "00"),
      };

      await expect(keyManager.importKeystore(tampered, "strong-password")).rejects.toThrow();
    });

    it("produces a versioned envelope format", async () => {
      const kp = keyManager.generateKeypair();
      const envelope = await keyManager.exportKeystore(kp, "strong-password");

      expect(envelope).toHaveProperty("version");
      expect(typeof envelope.version).toBe("number");
      expect(envelope.version).toBeGreaterThanOrEqual(1);
    });

    it("uses a fresh salt and IV for each export", async () => {
      const kp = keyManager.generateKeypair();
      const first = await keyManager.exportKeystore(kp, "strong-password");
      const second = await keyManager.exportKeystore(kp, "strong-password");

      expect(first.salt).not.toBe(second.salt);
      expect(first.iv).not.toBe(second.iv);
    });
  });
});
