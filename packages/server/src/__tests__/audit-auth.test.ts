import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";
import { WebSocket } from "ws";
import crypto from "node:crypto";

function signJwt(payload: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

describe("Audit WebSocket Authentication", () => {
  let serverResult: ServerResult;
  let wsUrl: string;
  const apiKey = "test-secret-api-key-123";
  const jwtSecret = "test-jwt-secret-audit";

  beforeAll(async () => {
    const cosignerKeypair = Keypair.random();
    const feePayerKeypair = Keypair.random();
    process.env.JWT_SECRET = jwtSecret;
    serverResult = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
      apiKey,
      rbac: {},
    });
    await new Promise<void>((resolve) => serverResult.server.once("listening", resolve));
    const address = serverResult.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to TCP port");
    }
    wsUrl = `ws://127.0.0.1:${address.port}/audit/stream`;
  });

  afterAll(async () => {
    serverResult.sponsorMonitorService.stop();
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve) => serverResult.server.close(() => resolve()));
  });

  it("rejects unauthenticated WebSocket connection with 401 when apiKey is set", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on("open", () => {
        ws.close();
        reject(new Error("Should not have connected without authentication"));
      });
      ws.on("error", (err) => {
        expect(err.message).toContain("401");
        resolve();
      });
    });
  });

  it("connects successfully with valid Authorization Bearer API key token", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", (err) => {
        reject(err);
      });
    });
  });

  it("connects successfully with valid ?token= query parameter API key", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}?token=${apiKey}`);
      ws.on("open", () => {
        ws.close();
        resolve();
      });
      ws.on("error", (err) => {
        reject(err);
      });
    });
  });

  it("connects successfully with valid JWT token having auditor role (audit:read permission)", async () => {
    const cosignerKeypair = Keypair.random();
    const feePayerKeypair = Keypair.random();
    const rbacServer = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
      rbac: {},
    });
    await new Promise<void>((resolve) => rbacServer.server.once("listening", resolve));
    const address = rbacServer.server.address() as import("node:net").AddressInfo;
    const rbacWsUrl = `ws://127.0.0.1:${address.port}/audit/stream`;

    const token = signJwt(
      { sub: "auditor-1", role: "auditor", exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
    );

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${rbacWsUrl}?token=${token}`);
      ws.on("open", () => {
        ws.close();
        rbacServer.server.close(() => resolve());
      });
      ws.on("error", (err) => {
        rbacServer.server.close(() => reject(err));
      });
    });
  });

  it("rejects unauthenticated request on RBAC-enabled server", async () => {
    const cosignerKeypair = Keypair.random();
    const feePayerKeypair = Keypair.random();
    const rbacServer = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
      rbac: {},
    });
    await new Promise<void>((resolve) => rbacServer.server.once("listening", resolve));
    const address = rbacServer.server.address() as import("node:net").AddressInfo;
    const rbacWsUrl = `ws://127.0.0.1:${address.port}/audit/stream`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(rbacWsUrl);
      ws.on("open", () => {
        ws.close();
        rbacServer.server.close(() => reject(new Error("Should not have connected")));
      });
      ws.on("error", (err) => {
        expect(err.message).toMatch(/401|403/);
        rbacServer.server.close(() => resolve());
      });
    });
  });
});
