import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";

describe("POST /cosign Security & Validation Endpoints", () => {
  const cosignerKeypair = Keypair.random();
  const feePayerKeypair = Keypair.random();
  let serverResult: ServerResult;
  let baseUrl: string;

  beforeAll(async () => {
    serverResult = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
    });

    await new Promise((r) => setTimeout(r, 100));
    const addr = serverResult.server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    serverResult.sponsorMonitorService?.stop();
    await new Promise<void>((resolve) => serverResult.server.close(() => resolve()));
  });

  it("returns 400 when walletAddress is not a valid Stellar public key", async () => {
    const userKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");
    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: tx.toXDR(),
        walletAddress: "not-a-stellar-public-key",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    expect(data.details?.walletAddress).toContain(
      "walletAddress must be a valid Stellar public key"
    );
  });

  it("rejects fee-bump transactions with user-friendly error message", async () => {
    const userKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");

    const innerTx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    innerTx.sign(userKeypair);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feePayerKeypair,
      BASE_FEE * 2,
      innerTx,
      Networks.STANDALONE
    );
    feeBumpTx.sign(feePayerKeypair);

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: feeBumpTx.toXDR(),
        walletAddress: userKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe(
      "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction."
    );
  });

  it("rejects transaction when source account does not match wallet address", async () => {
    const userKeypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");

    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: tx.toXDR(),
        walletAddress: otherKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Transaction source does not match wallet address");
  });

  it("rejects transaction when wallet owner has not signed the transaction", async () => {
    const userKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");

    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    // Intentionally unsigned

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: tx.toXDR(),
        walletAddress: userKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Transaction is not signed by the wallet owner");
  });

  it("successfully co-signs when owner signed and source matches", async () => {
    const userKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");

    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: tx.toXDR(),
        walletAddress: userKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signedXdr).toBeDefined();
  });

  function buildSignedPayment(
    userKeypair: Keypair,
    amount = "10"
  ): string {
    const userAccount = new Account(userKeypair.publicKey(), "100");
    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount,
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);
    return tx.toXDR();
  }

  it("co-signs a batch of 20 valid transactions in a single request", async () => {
    const userKeypair = Keypair.random();
    const transactions = Array.from({ length: 20 }, () => ({
      xdr: buildSignedPayment(userKeypair),
      walletAddress: userKeypair.publicKey(),
    }));

    const res = await fetch(`${baseUrl}/cosign/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(20);
    for (const item of data.results) {
      expect(item.success).toBe(true);
      expect(item.signedXdr).toBeDefined();
    }
  });

  it("returns item-level error details for an invalid transaction in a mixed batch", async () => {
    const userKeypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const transactions = [
      {
        xdr: buildSignedPayment(userKeypair),
        walletAddress: userKeypair.publicKey(),
      },
      {
        xdr: buildSignedPayment(userKeypair),
        walletAddress: otherKeypair.publicKey(),
      },
      {
        xdr: buildSignedPayment(userKeypair),
        walletAddress: userKeypair.publicKey(),
      },
    ];

    const res = await fetch(`${baseUrl}/cosign/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(3);

    expect(data.results[0].success).toBe(true);
    expect(data.results[0].signedXdr).toBeDefined();

    expect(data.results[1].success).toBe(false);
    expect(data.results[1].error).toBe(
      "Transaction source does not match wallet address"
    );

    expect(data.results[2].success).toBe(true);
    expect(data.results[2].signedXdr).toBeDefined();
  });

  it("rejects a high-velocity anomaly with FRAUD_VELOCITY_TRIGGERED", async () => {
    const userKeypair = Keypair.random();

    // Establish a baseline volume, then submit a sudden 10x volume increase.
    const baseline = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: buildSignedPayment(userKeypair, "10"),
        walletAddress: userKeypair.publicKey(),
      }),
    });
    expect(baseline.status).toBe(200);

    const res = await fetch(`${baseUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: buildSignedPayment(userKeypair, "1000"),
        walletAddress: userKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("FRAUD_VELOCITY_TRIGGERED");
  });
});
