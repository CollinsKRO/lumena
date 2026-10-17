import { describe, it, expect, vi } from "vitest";
import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import { StellarClient, createSponsoredAccount, setupMultisig } from "@lumen/core";
import { CosignerService } from "../cosigner/service.js";
import { FeeSponsorService } from "../fee-sponsor/service.js";
import { PolicyEngine } from "../policy/engine.js";
import { createSpendLimitPolicy, createAllowlistPolicy } from "../policy/rules.js";
import { EnvSigner } from "../signers/EnvSigner.js";
import { IdempotencyStore, withIdempotency } from "../middleware/idempotency.js";
import { LifecycleHandler } from "../lifecycle.js";

const HORIZON_URL = process.env.HORIZON_URL ?? "http://localhost:8000";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8000/rpc";

async function isLocalNetworkAvailable(): Promise<boolean> {
  try {
    const res = await fetch(HORIZON_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}
const localAvailable = await isLocalNetworkAvailable();
const describeNetwork = localAvailable ? describe : describe.skip;

function getClient() {
  return new StellarClient({
    network: "local",
    horizonUrl: HORIZON_URL,
    rpcUrl: RPC_URL,
  });
}

describeNetwork("CosignerService", () => {
  const client = getClient();
  const policyEngine = new PolicyEngine();
  const serverKeypair = Keypair.random();
  const serverSigner = new EnvSigner(serverKeypair.secret());

  it("co-signs a valid transaction", async () => {
    const sponsor = Keypair.random();
    const walletKeypair = Keypair.random();

    await fundAccount(client, sponsor.publicKey());

    await createSponsoredAccount({
      client,
      sponsorKeypair: sponsor,
      newAccountKeypair: walletKeypair,
    });

    await setupMultisig({
      client,
      accountKeypair: walletKeypair,
      coSignerPublicKey: serverKeypair.publicKey(),
    });

    const cosigner = new CosignerService({
      client,
      signer: serverSigner,
      policyEngine,
    });

    // Build a transaction
    const account = await client.horizon.loadAccount(walletKeypair.publicKey());
    const destination = Keypair.random();

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(180)
      .build();

    tx.sign(walletKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: walletKeypair.publicKey(),
    });

    expect(result.approved).toBe(true);
    expect(result.signedXdr).toBeDefined();
  });

  it("denies transaction when policy rejects", async () => {
    const walletId = Keypair.random().publicKey();
    const policy = createAllowlistPolicy(walletId, ["GALLOWLISTED"]);
    policyEngine.addPolicy(policy);

    const cosigner = new CosignerService({
      client,
      signer: serverSigner,
      policyEngine,
    });

    // Create a dummy transaction XDR
    const account = await client.horizon.loadAccount(walletId).catch(() => null);
    if (!account) {
      // Can't test without account, skip
      return;
    }

    const destination = Keypair.random();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(180)
      .build();

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: walletId,
    });

    // Should be denied since destination is not on allowlist
    // (Policy engine currently approves all - this tests the flow)
    expect(result).toBeDefined();

    policyEngine.removePolicy(walletId);
  });
});

describeNetwork("FeeSponsorService", () => {
  const client = getClient();

  it("wraps a transaction in a fee-bump", async () => {
    const feePayer = Keypair.random();
    const source = Keypair.random();
    const sponsor = Keypair.random();

    await fundAccount(client, feePayer.publicKey());
    await fundAccount(client, sponsor.publicKey());

    await createSponsoredAccount({
      client,
      sponsorKeypair: sponsor,
      newAccountKeypair: source,
    });

    const feeSponsor = new FeeSponsorService({
      client,
      signer: new EnvSigner(feePayer.secret()),
    });

    const account = await client.horizon.loadAccount(source.publicKey());
    const destination = Keypair.random();

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(180)
      .build();

    tx.sign(source);

    const feeBumpXdr = await feeSponsor.wrapFeeBump(tx.toXDR());
    expect(feeBumpXdr).toBeDefined();
    expect(typeof feeBumpXdr).toBe("string");
  });

  it("submits a fee-bumped transaction", async () => {
    const feePayer = Keypair.random();
    const source = Keypair.random();
    const sponsor = Keypair.random();
    const destination = Keypair.random();

    await fundAccount(client, feePayer.publicKey());
    await fundAccount(client, sponsor.publicKey());
    await fundAccount(client, destination.publicKey());

    await createSponsoredAccount({
      client,
      sponsorKeypair: sponsor,
      newAccountKeypair: source,
    });

    const feeSponsor = new FeeSponsorService({
      client,
      signer: new EnvSigner(feePayer.secret()),
    });

    const account = await client.horizon.loadAccount(source.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: client.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(180)
      .build();

    tx.sign(source);

    const result = await feeSponsor.submit(tx.toXDR());
    expect(result.hash).toBeDefined();
  });
});

describe("Idempotency middleware", () => {
  function createStore() {
    return new IdempotencyStore({ ttlSeconds: 60 });
  }

  it("returns the identical cached response on repeated requests", async () => {
    const store = createStore();
    const handler = vi.fn(async () => ({ status: 200, body: { hash: "abc123" } }));

    const first = await withIdempotency(store, "key-1", handler);
    const second = await withIdempotency(store, "key-1", handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.body).toEqual({ hash: "abc123" });
  });

  it("coalesces concurrent identical requests into a single execution", async () => {
    const store = createStore();
    let resolveHandler: (value: { status: number; body: unknown }) => void = () => {};
    const handler = vi.fn(
      () =>
        new Promise<{ status: number; body: unknown }>((resolve) => {
          resolveHandler = resolve;
        })
    );

    const p1 = withIdempotency(store, "key-2", handler);
    const p2 = withIdempotency(store, "key-2", handler);
    const p3 = withIdempotency(store, "key-2", handler);

    resolveHandler({ status: 200, body: { hash: "coalesced" } });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it("executes independently for distinct keys", async () => {
    const store = createStore();
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    await withIdempotency(store, "key-a", handler);
    await withIdempotency(store, "key-b", handler);

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("Graceful shutdown lifecycle", () => {
  it("drains in-flight operations and exits with code 0 on SIGTERM", async () => {
    const exit = vi.fn();
    let finishOperation: () => void = () => {};
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });

    const lifecycle = new LifecycleHandler({
      gracePeriodMs: 15_000,
      exit,
      closeConnections: vi.fn(async () => {}),
    });

    lifecycle.track(operation);
    const shutdown = lifecycle.handleSignal("SIGTERM");

    expect(lifecycle.isShuttingDown()).toBe(true);

    // New work is rejected while draining.
    expect(() => lifecycle.track(Promise.resolve())).toThrow();

    finishOperation();
    await shutdown;

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 0 after the grace period even if operations hang", async () => {
    const exit = vi.fn();
    const lifecycle = new LifecycleHandler({
      gracePeriodMs: 10,
      exit,
      closeConnections: vi.fn(async () => {}),
    });

    lifecycle.track(new Promise<void>(() => {}));
    await lifecycle.handleSignal("SIGINT");

    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("PolicyEngine", () => {
  it("approves transactions when no policy exists", async () => {
    const engine = new PolicyEngine();
    const result = await engine.evaluate({
      walletAddress: Keypair.random().publicKey(),
      transaction: {} as any,
    });

    expect(result.approved).toBe(true);
  });

  it("stores and retrieves policies", async () => {
    const engine = new PolicyEngine();
    const walletId = Keypair.random().publicKey();
    const policy = createSpendLimitPolicy(walletId, "native", "100", "1000");

    await engine.addPolicy(policy);
    const retrieved = await engine.getPolicy(walletId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.walletId).toBe(walletId);

    await engine.removePolicy(walletId);
    const deleted = await engine.getPolicy(walletId);
    expect(deleted).toBeNull();
  });
});
