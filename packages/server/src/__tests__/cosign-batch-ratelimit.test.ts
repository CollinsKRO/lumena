import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { Redis } from "ioredis";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";
import { SponsorMonitorService } from "../fee-sponsor/monitor.js";

describe("POST /cosign/batch rate limiting", () => {
  let result: ServerResult | undefined;

  afterEach(async () => {
    await result?.shutdown();
    result = undefined;
    vi.restoreAllMocks();
  });

  it.each([1, 2])("returns 429 after the configured capacity of %i requests", async (capacity) => {
    // Keep real HTTP routing and rate-limit middleware; only Redis storage and
    // the unrelated background Horizon poll are replaced for this test.
    vi.spyOn(SponsorMonitorService.prototype, "start").mockImplementation(() => {});
    const tokenBucketConsume = vi.fn();
    for (let remaining = capacity - 1; remaining >= 0; remaining--) {
      tokenBucketConsume.mockResolvedValueOnce([1, remaining, 0]);
    }
    tokenBucketConsume.mockResolvedValue([0, 0, 60000]);
    const redis = {
      tokenBucketConsume,
      lrange: vi.fn().mockResolvedValue([]),
      smembers: vi.fn().mockResolvedValue([]),
    } as unknown as Redis;

    result = createServer({
      port: 0,
      network: "local",
      apiKey: "batch-rate-limit-test-key",
      cosignerSigner: new EnvSigner(Keypair.random().secret()),
      feePayerSigner: new EnvSigner(Keypair.random().secret()),
      redis,
      max: capacity,
      windowMs: 60000,
    });
    await new Promise<void>((resolve) => result!.server.once("listening", resolve));
    const address = result.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const cosignBatch = vi.spyOn(result.cosignerService, "cosignBatch");
    const request = () =>
      fetch(`http://127.0.0.1:${address.port}/cosign/batch`, {
        method: "POST",
        headers: {
          Authorization: "Bearer batch-rate-limit-test-key",
          "Content-Type": "application/json",
        },
        // Invalid input reaches validation only while the bucket has tokens.
        // No transaction signing or network submission is needed.
        body: JSON.stringify({ transactions: [] }),
      });

    for (let index = 0; index < capacity; index++) {
      const response = await request();
      expect(response.status).toBe(400);
      await response.json();
    }
    const throttled = await request();
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "Too Many Requests" });
    expect(throttled.headers.get("retry-after")).toBe("60");
    expect(cosignBatch).not.toHaveBeenCalled();
    expect(tokenBucketConsume).toHaveBeenCalledTimes(capacity + 1);
    expect(tokenBucketConsume).toHaveBeenLastCalledWith(
      expect.stringContaining(":ip:"),
      capacity,
      capacity / 60,
      expect.any(Number),
      1,
    );
  });
});
