import { afterEach, describe, expect, it, vi } from "vitest";
import { LumenClient } from "../client.js";

// HTTP helper tests do not need a Horizon/RPC client or a live Stellar network.
vi.mock("@lumen/core", () => ({ StellarClient: class {} }));

describe("LumenClient.post", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new LumenClient({
      network: "testnet",
      serverUrl: "https://lumen.example/",
      serverPublicKey: "unused-for-http",
      apiKey: "test-api-key",
      headers: { "X-Client": "recovery-test" },
    });

  it("sends JSON in the body while preserving authentication and custom headers", async () => {
    const response = { id: "request-1" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    const body = { walletId: "wallet/private", newPublicKey: "key+&?" };

    await expect(client().post("/recovery/initiate", body)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://lumen.example/recovery/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-api-key",
        "X-Client": "recovery-test",
      },
      body: JSON.stringify(body),
    });
  });

  it("omits the body when none is supplied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ state: "cancelled" })));
    vi.stubGlobal("fetch", fetchMock);
    await client().post("/recovery/request-1/cancel");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("propagates HTTP errors without echoing the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client().post("/recovery/initiate", { walletId: "private-wallet" }),
    ).rejects.toThrow("POST /recovery/initiate failed (403): Forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
