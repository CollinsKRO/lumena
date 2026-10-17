import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { LumenClient, createSessionKey } from "../client.js";

describe("web-sdk client", () => {
  const sponsorKeypair = Keypair.random();
  const serverKeypair = Keypair.random();

  it("creates session key with expiration", () => {
    const sessionKey = createSessionKey(1800);
    expect(sessionKey.publicKey).toBeDefined();
    expect(sessionKey.secretKey).toBeDefined();
    expect(sessionKey.expiresAt).toBeGreaterThan(Date.now());
  });

  it("instantiates LumenClient correctly", () => {
    const client = new LumenClient({
      network: "testnet",
      sponsorSecret: sponsorKeypair.secret(),
      serverPublicKey: serverKeypair.publicKey(),
    });

    expect(client).toBeInstanceOf(LumenClient);
    expect(client.getWallet("non-existent")).toBeUndefined();
  });

  describe("apiKey and custom headers", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("sends Authorization Bearer and custom headers to serverUrl", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
        serverUrl: "https://lumen.example.com",
        apiKey: "my-secret-api-key",
        headers: { "X-Custom-Header": "custom-value" },
      });

      const wallet = await client.createWallet();
      expect(wallet).toBeDefined();

      // Trigger a fetch against serverUrl via sendPayment.
      const destination = Keypair.random().publicKey();
      try {
        await client.sendPayment(wallet.id, destination, "10");
      } catch {
        // Ignore errors from response parsing; we only care about the request.
      }

      expect(fetchMock).toHaveBeenCalled();
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("https://lumen.example.com");

      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-api-key");
      expect(headers["X-Custom-Header"]).toBe("custom-value");
    });

    it("does not send Authorization header when apiKey is not set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
        serverUrl: "https://lumen.example.com",
        headers: { "X-Custom-Header": "custom-value" },
      });

      const wallet = await client.createWallet();
      const destination = Keypair.random().publicKey();
      try {
        await client.sendPayment(wallet.id, destination, "10");
      } catch {
        // Ignore.
      }

      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0];
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["X-Custom-Header"]).toBe("custom-value");
    });
  });

  describe("importWallet and exportWallet", () => {
    it("imports and exports a wallet round-trip", async () => {
      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
      });

      const importedKeypair = Keypair.random();
      const result = await client.importWallet(importedKeypair.secret());

      expect(result.address).toBe(importedKeypair.publicKey());
      expect(result.id).toBeDefined();

      const exported = await client.exportWallet(result.id);
      expect(exported).toBe(importedKeypair.secret());
      expect(exported.startsWith("S")).toBe(true);
    });

    it("throws on invalid secret key", async () => {
      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
      });

      await expect(client.importWallet("not-a-valid-secret")).rejects.toThrow();
    });

    it("throws on unknown wallet ID during export", async () => {
      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
      });

      await expect(client.exportWallet("unknown-wallet-id")).rejects.toThrow();
    });
  });

  describe("getTransactions", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("queries the server endpoint with limit/cursor/order when serverUrl is set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ transactions: [{ id: "tx-1" }] }),
        text: async () => JSON.stringify({ transactions: [{ id: "tx-1" }] }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
        serverUrl: "https://lumen.example.com",
        apiKey: "my-secret-api-key",
      });

      const importedKeypair = Keypair.random();
      const wallet = await client.importWallet(importedKeypair.secret());

      const txs = await client.getTransactions(wallet.id, {
        limit: 5,
        cursor: "cursor-123",
        order: "desc",
      });

      expect(Array.isArray(txs)).toBe(true);
      expect(fetchMock).toHaveBeenCalled();

      const [url, init] = fetchMock.mock.calls[0];
      const urlStr = String(url);
      expect(urlStr).toContain(`/wallet/${importedKeypair.publicKey()}/transactions`);
      expect(urlStr).toContain("limit=5");
      expect(urlStr).toContain("cursor=cursor-123");
      expect(urlStr).toContain("order=desc");

      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-api-key");
    });

    it("falls back to Horizon when serverUrl is not set", async () => {
      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
      });

      const importedKeypair = Keypair.random();
      const wallet = await client.importWallet(importedKeypair.secret());

      const records = [{ id: "horizon-tx-1" }];
      const callMock = vi.fn().mockResolvedValue({ records });
      const forAccountMock = vi.fn().mockReturnValue({ call: callMock });
      const transactionsMock = vi.fn().mockReturnValue({
        forAccount: forAccountMock,
      });

      // Replace the horizon client with a mock.
      (client as any).horizon = { transactions: transactionsMock };

      const txs = await client.getTransactions(wallet.id, { limit: 3 });

      expect(transactionsMock).toHaveBeenCalled();
      expect(forAccountMock).toHaveBeenCalledWith(importedKeypair.publicKey());
      expect(callMock).toHaveBeenCalled();
      expect(txs).toEqual(records);
    });

    it("throws when wallet ID is not found", async () => {
      const client = new LumenClient({
        network: "testnet",
        sponsorSecret: sponsorKeypair.secret(),
        serverPublicKey: serverKeypair.publicKey(),
      });

      await expect(client.getTransactions("unknown-wallet-id")).rejects.toThrow();
    });
  });
});