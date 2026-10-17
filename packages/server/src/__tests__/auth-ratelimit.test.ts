import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";

describe("API Key Authentication & Rate Limiting Middleware", () => {
  const cosignerKeypair = Keypair.random();
  const feePayerKeypair = Keypair.random();
  const apiKey = "test-secret-key-12345";
  let serverResult: ServerResult;
  let baseUrl: string;

  beforeAll(async () => {
    serverResult = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
      apiKey,
      // Token bucket: capacity 2 (burst), refill 1 token per 60s (steady-state).
      windowMs: 60000,
      max: 2,
    });

    await new Promise((r) => setTimeout(r, 100));
    const addr = serverResult.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    serverResult.sponsorMonitorService?.stop();
    await new Promise<void>((resolve) => serverResult.server.close(() => resolve()));
  });

  it("allows /health without an API key", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("does not allow cross-origin requests by default", async () => {
    const res = await fetch(`${baseUrl}/cosign`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.example",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows /metrics without an API key", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
  });

  it("rejects protected endpoint with 401 when Authorization header is missing", async () => {
    const res = await fetch(`${baseUrl}/sponsor/status`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects protected endpoint with 401 when Bearer token is invalid", async () => {
    const res = await fetch(`${baseUrl}/sponsor/status`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects protected endpoint with 401 when scheme is not Bearer", async () => {
    const res = await fetch(`${baseUrl}/sponsor/status`, {
      headers: { Authorization: `Basic ${apiKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("allows protected endpoint when valid Authorization Bearer header is provided", async () => {
    const res = await fetch(`${baseUrl}/sponsor/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
  });

  it("enforces rate limiting on /fee-bump endpoint and returns 429", async () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // First request
    const r1 = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400); // validation error, but passed rate limit

    // Second request
    const r2 = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(r2.status).toBe(400);

    // Third request exceeds limit of 2
    const r3 = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("allows a burst up to bucket capacity before throttling", async () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // Fresh client IP so this bucket is independent of other tests.
    const burstHeaders = { ...headers, "X-Forwarded-For": "203.0.113.10" };

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/fee-bump`, {
          method: "POST",
          headers: burstHeaders,
          body: JSON.stringify({}),
        }),
      ),
    );

    // Both burst requests fit within capacity and pass the limiter.
    for (const res of results) {
      expect(res.status).not.toBe(429);
    }
  });

  it("throttles sustained requests beyond refill rate with 429 and Retry-After", async () => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.20",
    };

    // Drain the bucket (capacity 2).
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/fee-bump`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(429);
    }

    // Sustained request beyond refill rate is throttled.
    const throttled = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(throttled.status).toBe(429);
    const body = await throttled.json();
    expect(body.error).toBe("Too Many Requests");

    const retryAfter = throttled.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("isolates buckets per client IP", async () => {
    const makeHeaders = (ip: string) => ({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    });

    // Drain IP A.
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/fee-bump`, {
        method: "POST",
        headers: makeHeaders("203.0.113.30"),
        body: JSON.stringify({}),
      });
    }
    const drainedA = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers: makeHeaders("203.0.113.30"),
      body: JSON.stringify({}),
    });
    expect(drainedA.status).toBe(429);

    // IP B has its own untouched bucket.
    const freshB = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers: makeHeaders("203.0.113.31"),
      body: JSON.stringify({}),
    });
    expect(freshB.status).not.toBe(429);
  });

  it("isolates buckets per wallet address", async () => {
    const walletA = Keypair.random().publicKey();
    const walletB = Keypair.random().publicKey();
    const ip = "203.0.113.40";

    const makeHeaders = (wallet: string) => ({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      "X-Wallet-Address": wallet,
    });

    // Drain wallet A's bucket.
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/fee-bump`, {
        method: "POST",
        headers: makeHeaders(walletA),
        body: JSON.stringify({}),
      });
    }
    const drainedA = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers: makeHeaders(walletA),
      body: JSON.stringify({}),
    });
    expect(drainedA.status).toBe(429);

    // Wallet B on the same IP has its own bucket.
    const freshB = await fetch(`${baseUrl}/fee-bump`, {
      method: "POST",
      headers: makeHeaders(walletB),
      body: JSON.stringify({}),
    });
    expect(freshB.status).not.toBe(429);
  });
});
