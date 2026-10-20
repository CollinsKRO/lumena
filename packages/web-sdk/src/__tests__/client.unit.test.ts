import { describe, it, expect, vi } from "vitest";
import { LumenClient, createSessionKey } from "../client.js";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { StellarClient } from "@lumen/core";

describe("LumenClient (unit)", () => {
  const sponsor = Keypair.random();
  const cosigner = Keypair.random();

  it("initializes LumenClient with options", () => {
    const client = new LumenClient({
      network: "local",
      sponsorSecret: sponsor.secret(),
      serverPublicKey: cosigner.publicKey(),
    });
    expect(client).toBeInstanceOf(LumenClient);
  });

  it("creates a session key", () => {
    const session = createSessionKey(60);
    expect(session.publicKey).toBeDefined();
    expect(session.secretKey).toBeDefined();
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("creates and registers a wallet with a caller-managed keypair", async () => {
    const owner = Keypair.random();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ address: owner.publicKey() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new LumenClient({
        network: "testnet",
        serverUrl: "https://lumen.example",
        serverPublicKey: cosigner.publicKey(),
      });
      const stellarClient = (client as unknown as { client: StellarClient }).client;
      vi.spyOn(stellarClient.horizon, "loadAccount").mockResolvedValue(
        new Account(owner.publicKey(), "1"),
      );
      vi.spyOn(stellarClient.horizon, "submitTransaction").mockResolvedValue({
        successful: true,
        hash: "multisig-setup-hash",
      } as never);
      const result = await client.createWalletWithKeypair(owner);

      expect(result).toEqual({
        address: owner.publicKey(),
        id: owner.publicKey(),
        keypair: owner,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://lumen.example/wallet/create",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ownerPublicKey: owner.publicKey() }),
        }),
      );
      expect(client.getWallet(result.id)).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
