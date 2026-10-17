import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyEngine } from "../policy/engine.js";
import {
  createAllowlistPolicy,
  createBlocklistPolicy,
  createAssetAllowlistPolicy,
  createSpendLimitPolicy,
  createTimeBoundsPolicy,
  createVelocityPolicy,
  createMaxOperationsPolicy,
} from "../policy/rules.js";
import { PolicyStore } from "../policy/store.js";
import type { MaxOperationsRule } from "@lumen/types";
import type { Transaction } from "@stellar/stellar-sdk";

describe("PolicyEngine Multi-Op & Asset Spend Limits", () => {
  const walletId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  it("supports allow-by-default and deny-by-default for wallets without policies", () => {
    const transaction = { operations: [] } as unknown as Transaction;

    expect(new PolicyEngine().evaluate({ walletAddress: walletId, transaction })).toEqual({
      approved: true,
    });
    expect(
      new PolicyEngine({ defaultPolicy: "deny" }).evaluate({
        walletAddress: walletId,
        transaction,
      }),
    ).toEqual({
      approved: false,
      reason: `No policy found for wallet ${walletId}`,
    });
  });

  it("evaluates multiple payment operations in a single transaction against allowlist", async () => {
    const engine = new PolicyEngine();
    const policy = createAllowlistPolicy(walletId, ["GALLISTED1", "GALLISTED2"]);
    await engine.addPolicy(policy);

    const validTx = {
      operations: [
        { type: "payment", destination: "GALLISTED1", amount: "10", asset: "native" },
        { type: "payment", destination: "GALLISTED2", amount: "20", asset: "native" },
      ],
    } as unknown as Transaction;

    const res1 = await engine.evaluate({ walletAddress: walletId, transaction: validTx });
    expect(res1.approved).toBe(true);

    const invalidTx = {
      operations: [
        { type: "payment", destination: "GALLISTED1", amount: "10", asset: "native" },
        { type: "payment", destination: "GBADDESTINATION", amount: "20", asset: "native" },
      ],
    } as unknown as Transaction;

    const res2 = await engine.evaluate({ walletAddress: walletId, transaction: invalidTx });
    expect(res2.approved).toBe(false);
    expect(res2.reason).toContain("GBADDESTINATION is not on the allowlist");
  });

  describe("PolicyEngine Blocklist", () => {
    const walletId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    it("rejects transactions with a blocked destination and approves other destinations", () => {
      const engine = new PolicyEngine();
      engine.addPolicy(createBlocklistPolicy(walletId, ["GBLOCKED"]));

      const allowedTx = {
        operations: [{ type: "payment", destination: "GOTHER", amount: "10" }],
      } as unknown as Transaction;
      expect(engine.evaluate({ walletAddress: walletId, transaction: allowedTx }).approved).toBe(
        true,
      );

      const blockedTx = {
        operations: [{ type: "payment", destination: "GBLOCKED", amount: "10" }],
      } as unknown as Transaction;
      const result = engine.evaluate({ walletAddress: walletId, transaction: blockedTx });
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("GBLOCKED is on the blocklist");
    });
  });

  it("evaluates pathPaymentStrictSend and pathPaymentStrictReceive operations", async () => {
    const engine = new PolicyEngine();
    const policy = createAllowlistPolicy(walletId, ["GALLOWEDPATH"]);
    await engine.addPolicy(policy);

    const pathTx = {
      operations: [
        {
          type: "pathPaymentStrictSend",
          destination: "GALLOWEDPATH",
          sendAmount: "50",
          sendAsset: "native",
        },
      ],
    } as unknown as Transaction;

    const res = await engine.evaluate({ walletAddress: walletId, transaction: pathTx });
    expect(res.approved).toBe(true);

    const invalidPathTx = {
      operations: [
        {
          type: "pathPaymentStrictReceive",
          destination: "GUNAUTHORIZED",
          sendMax: "100",
          sendAsset: "native",
        },
      ],
    } as unknown as Transaction;

    const resInvalid = await engine.evaluate({
      walletAddress: walletId,
      transaction: invalidPathTx,
    });
    expect(resInvalid.approved).toBe(false);
  });

  it("isolates spend limits by asset (XLM vs USDC)", async () => {
    const engine = new PolicyEngine();
    const xlmPolicy = createSpendLimitPolicy(walletId, "native", "100", "500");
    await engine.addPolicy(xlmPolicy);

    const xlmTx = {
      operations: [{ type: "payment", destination: "GDEST", amount: "50", asset: "native" }],
    } as unknown as Transaction;

    const resXlm = await engine.evaluate({ walletAddress: walletId, transaction: xlmTx });
    expect(resXlm.approved).toBe(true);

    // Payments in USDC should pass XLM spend limit rule
    const usdcTx = {
      operations: [{ type: "payment", destination: "GDEST", amount: "1000", asset: "USDC:G123" }],
    } as unknown as Transaction;

    const resUsdc = await engine.evaluate({ walletAddress: walletId, transaction: usdcTx });
    expect(resUsdc.approved).toBe(true);
  });

  it("allows payments only in configured assets", () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createAssetAllowlistPolicy(walletId, ["USDC:GISSUER"]));

    const usdcTx = {
      operations: [
        {
          type: "payment",
          destination: "GDEST",
          amount: "10",
          asset: "USDC:GISSUER",
        },
      ],
    } as unknown as Transaction;
    expect(engine.evaluate({ walletAddress: walletId, transaction: usdcTx }).approved).toBe(true);

    const xlmTx = {
      operations: [{ type: "payment", destination: "GDEST", amount: "10", asset: "native" }],
    } as unknown as Transaction;
    const result = engine.evaluate({ walletAddress: walletId, transaction: xlmTx });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Asset native is not on the allowlist");
  });

  it("enforces per-tx and daily spend limits across multi-op payments of same asset", async () => {
    const engine = new PolicyEngine();
    const policy = createSpendLimitPolicy(walletId, "native", "60", "100");
    await engine.addPolicy(policy);

    // Multi-op total = 70 exceeds maxPerTx (60)
    const exceedPerTx = {
      operations: [{ type: "payment", destination: "GDEST", amount: "70", asset: "native" }],
    } as unknown as Transaction;

    const res1 = await engine.evaluate({ walletAddress: walletId, transaction: exceedPerTx });
    expect(res1.approved).toBe(false);
    expect(res1.reason).toContain("exceeds per-tx limit");

    // First valid tx of 50
    const validTx1 = {
      operations: [{ type: "payment", destination: "GDEST", amount: "50", asset: "native" }],
    } as unknown as Transaction;
    const resValid = await engine.evaluate({ walletAddress: walletId, transaction: validTx1 });
    expect(resValid.approved).toBe(true);

    // Second valid tx of 55 will push daily total to 105 (exceeding daily limit 100)
    const validTx2 = {
      operations: [{ type: "payment", destination: "GDEST", amount: "55", asset: "native" }],
    } as unknown as Transaction;
    const resDaily = await engine.evaluate({ walletAddress: walletId, transaction: validTx2 });
    expect(resDaily.approved).toBe(false);
    expect(resDaily.reason).toContain("exceeds limit 100");
  });
});

describe("PolicyEngine TimeBounds & Expiration Enforcement", () => {
  const walletId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  it("rejects transactions without TimeBounds when unbounded is not permitted", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 300, false));

    const txNoBounds = {
      operations: [],
      timeBounds: undefined,
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: txNoBounds });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("unbounded transactions are not permitted");
  });

  it("approves transactions without TimeBounds when allowUnbounded is true", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 300, true));

    const txNoBounds = {
      operations: [],
      timeBounds: undefined,
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: txNoBounds });
    expect(result.approved).toBe(true);
  });

  it("rejects expired transactions", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 300));

    const now = Math.floor(Date.now() / 1000);
    const expiredTx = {
      operations: [],
      timeBounds: {
        minTime: (now - 600).toString(),
        maxTime: (now - 10).toString(),
      },
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: expiredTx });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("has expired");
  });

  it("rejects transactions with a minTime too far in the future", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 300));

    const now = Math.floor(Date.now() / 1000);
    const futureTx = {
      operations: [],
      timeBounds: {
        minTime: (now + 600).toString(),
        maxTime: (now + 900).toString(),
      },
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: futureTx });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("more than 5 minutes in the future");
  });

  it("rejects transactions exceeding the maximum validity window", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 120)); // max 120s window

    const now = Math.floor(Date.now() / 1000);
    const wideWindowTx = {
      operations: [],
      timeBounds: {
        minTime: now.toString(),
        maxTime: (now + 600).toString(), // 600s > 120s
      },
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: wideWindowTx });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("exceeds maximum allowed window");
  });

  it("approves valid transactions within timebounds", async () => {
    const engine = new PolicyEngine();
    engine.addPolicy(createTimeBoundsPolicy(walletId, 300));

    const now = Math.floor(Date.now() / 1000);
    const validTx = {
      operations: [],
      timeBounds: {
        minTime: (now - 10).toString(),
        maxTime: (now + 120).toString(),
      },
    } as unknown as Transaction;

    const result = engine.evaluate({ walletAddress: walletId, transaction: validTx });
    expect(result.approved).toBe(true);
  });
});

describe("PolicyEngine Velocity Limits", () => {
  const walletId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const transaction = { operations: [] } as unknown as Transaction;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("approves transactions under the limit within the window", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const engine = new PolicyEngine();
    engine.addPolicy(createVelocityPolicy(walletId, 3, 5));

    for (let index = 0; index < 2; index++) {
      const result = engine.evaluate({ walletAddress: walletId, transaction });
      expect(result.approved).toBe(true);
    }
  });

  it("approves exactly the maximum number of transactions in the window", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const engine = new PolicyEngine();
    engine.addPolicy(createVelocityPolicy(walletId, 3, 5));

    for (let index = 0; index < 3; index++) {
      const result = engine.evaluate({ walletAddress: walletId, transaction });
      expect(result.approved).toBe(true);
    }
  });

  it("rejects the transaction after the velocity limit is exceeded", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const engine = new PolicyEngine();
    engine.addPolicy(createVelocityPolicy(walletId, 3, 5));

    for (let index = 0; index < 3; index++) {
      engine.evaluate({ walletAddress: walletId, transaction });
    }

    const result = engine.evaluate({ walletAddress: walletId, transaction });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Too many transactions (4)");
  });

  it("does not count transactions outside the velocity window", () => {
    const now = 1_700_000_000_000;
    const windowMs = 5 * 60 * 1000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    const engine = new PolicyEngine();
    engine.addPolicy(createVelocityPolicy(walletId, 2, 5));

    engine.evaluate({ walletAddress: walletId, transaction });
    engine.evaluate({ walletAddress: walletId, transaction });

    dateNow.mockReturnValue(now + windowMs + 1);

    const result = engine.evaluate({ walletAddress: walletId, transaction });
    expect(result.approved).toBe(true);
  });

  describe("MaxOperationsRule", () => {
    it("approves transaction when operation count is within the maximum limit", () => {
      const engine = new PolicyEngine();
      engine.addPolicy(createMaxOperationsPolicy(walletId, 3));

      const tx = {
        operations: [
          { type: "payment", destination: "GDEST1", amount: "10" },
          { type: "payment", destination: "GDEST2", amount: "20" },
        ],
      } as unknown as Transaction;

      const result = engine.evaluate({ walletAddress: walletId, transaction: tx });
      expect(result.approved).toBe(true);
    });

    it("approves transaction when operation count exactly matches maximum limit", () => {
      const engine = new PolicyEngine();
      engine.addPolicy(createMaxOperationsPolicy(walletId, 2));

      const tx = {
        operations: [
          { type: "payment", destination: "GDEST1", amount: "10" },
          { type: "payment", destination: "GDEST2", amount: "20" },
        ],
      } as unknown as Transaction;

      const result = engine.evaluate({ walletAddress: walletId, transaction: tx });
      expect(result.approved).toBe(true);
    });

    it("rejects transaction when operation count exceeds maximum limit", () => {
      const engine = new PolicyEngine();
      engine.addPolicy(createMaxOperationsPolicy(walletId, 2));

      const tx = {
        operations: [
          { type: "payment", destination: "GDEST1", amount: "10" },
          { type: "payment", destination: "GDEST2", amount: "20" },
          { type: "payment", destination: "GDEST3", amount: "30" },
        ],
      } as unknown as Transaction;

      const result = engine.evaluate({ walletAddress: walletId, transaction: tx });
      expect(result.approved).toBe(false);
      expect(result.reason).toContain("exceeds limit of 2");
    });

    it("evaluates evaluateMaxOperations directly", () => {
      const engine = new PolicyEngine();
      const rule: MaxOperationsRule = { type: "max_operations", maxOperations: 1 };

      const txAllowed = {
        operations: [{ type: "payment" }],
      } as unknown as Transaction;
      expect(engine.evaluateMaxOperations(rule, txAllowed).approved).toBe(true);

      const txDenied = {
        operations: [{ type: "payment" }, { type: "payment" }],
      } as unknown as Transaction;
      const res = engine.evaluateMaxOperations(rule, txDenied);
      expect(res.approved).toBe(false);
      expect(res.reason).toContain("exceeds limit of 1");
    });
  });
});

describe("PolicyEngine Dynamic Policy Reload (invalidatePolicy)", () => {
  const walletId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  it("clears the cached policy so subsequent evaluations reload the updated policy", async () => {
    const store = new PolicyStore();
    const engine = new PolicyEngine({ store });

    await store.setPolicy(createBlocklistPolicy(walletId, ["GBLOCKED"]));

    const blockedTx = {
      operations: [{ type: "payment", destination: "GBLOCKED", amount: "10" }],
    } as unknown as Transaction;
    expect((await engine.evaluate({ walletAddress: walletId, transaction: blockedTx })).approved).toBe(
      false,
    );

    // Admin updates the policy in the store (e.g. via another replica).
    await store.setPolicy(createBlocklistPolicy(walletId, ["GOTHERBLOCKED"]));

    // Without invalidation the engine may still serve the stale cached policy.
    engine.invalidatePolicy(walletId);

    const result = await engine.evaluate({ walletAddress: walletId, transaction: blockedTx });
    expect(result.approved).toBe(true);
  });

  it("resets spend-limit tracking state on invalidation", async () => {
    const store = new PolicyStore();
    const engine = new PolicyEngine({ store });

    await store.setPolicy(createSpendLimitPolicy(walletId, "native", "60", "100"));

    const tx = {
      operations: [{ type: "payment", destination: "GDEST", amount: "50", asset: "native" }],
    } as unknown as Transaction;

    expect((await engine.evaluate({ walletAddress: walletId, transaction: tx })).approved).toBe(
      true,
    );

    // A second 55 would exceed the daily limit of 100.
    const tx2 = {
      operations: [{ type: "payment", destination: "GDEST", amount: "55", asset: "native" }],
    } as unknown as Transaction;
    expect((await engine.evaluate({ walletAddress: walletId, transaction: tx2 })).approved).toBe(
      false,
    );

    // Invalidation clears accumulated spend tracking.
    engine.invalidatePolicy(walletId);

    expect((await engine.evaluate({ walletAddress: walletId, transaction: tx2 })).approved).toBe(
      true,
    );
  });

  it("resets velocity tracking state on invalidation", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const store = new PolicyStore();
    const engine = new PolicyEngine({ store });
    await store.setPolicy(createVelocityPolicy(walletId, 2, 5));

    const transaction = { operations: [] } as unknown as Transaction;

    expect((await engine.evaluate({ walletAddress: walletId, transaction })).approved).toBe(true);
    expect((await engine.evaluate({ walletAddress: walletId, transaction })).approved).toBe(true);
    expect((await engine.evaluate({ walletAddress: walletId, transaction })).approved).toBe(false);

    engine.invalidatePolicy(walletId);

    expect((await engine.evaluate({ walletAddress: walletId, transaction })).approved).toBe(true);

    vi.restoreAllMocks();
  });

  it("is a no-op for wallets without cached state", () => {
    const engine = new PolicyEngine();
    expect(() => engine.invalidatePolicy(walletId)).not.toThrow();
  });
});
