import { Account, Asset, Keypair, Networks, Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildTransaction } from "../stellar/transaction.js";
import {
  decodeUrFrames,
  encodeUrFrames,
  type UrFrame,
} from "../stellar/airgap.js";

describe("buildTransaction", () => {
  it("builds a transaction from an account with a sequence number", () => {
    const sourceAccount = new Account(Keypair.random().publicKey(), "7");
    const transaction = buildTransaction({
      sourceAccount,
      operations: [
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      ],
      networkPassphrase: Networks.TESTNET,
    });

    expect(transaction.source).toBe(sourceAccount.accountId());
    expect(transaction.operations).toHaveLength(1);
    expect(sourceAccount.sequenceNumber()).toBe("8");
  });
});

describe("air-gap UR pipeline", () => {
  // Build a ~2KB XDR envelope by padding with a large memo-like payload.
  const buildLargeXdr = (): string => {
    const sourceAccount = new Account(Keypair.random().publicKey(), "7");
    const transaction = buildTransaction({
      sourceAccount,
      operations: [
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      ],
      networkPassphrase: Networks.TESTNET,
    });
    const baseXdr = transaction.toEnvelope().toXDR("base64");
    // Pad to approximately 2KB using a deterministic filler.
    const targetLength = 2048;
    const filler = "A".repeat(Math.max(0, targetLength - baseXdr.length));
    return baseXdr + filler;
  };

  it("splits a ~2KB XDR into 5 sequential UR frames", () => {
    const xdr = buildLargeXdr();
    expect(xdr.length).toBeGreaterThanOrEqual(2000);

    const frames = encodeUrFrames(xdr);
    expect(frames).toHaveLength(5);

    // Frames must be sequential and carry index/total metadata.
    frames.forEach((frame: UrFrame, index: number) => {
      expect(frame.sequenceNum).toBe(index);
      expect(frame.total).toBe(5);
    });
  });

  it("reassembles frames received out of order and round-trips the XDR", () => {
    const xdr = buildLargeXdr();
    const frames = encodeUrFrames(xdr);

    // Simulate an animated QR scan that delivers frames out of order.
    const shuffled = [frames[2], frames[0], frames[4], frames[1], frames[3]];
    const reassembled = decodeUrFrames(shuffled);

    expect(reassembled).toBe(xdr);
  });

  it("throws a checksum error when a frame is corrupted", () => {
    const xdr = buildLargeXdr();
    const frames = encodeUrFrames(xdr);

    const corrupted: UrFrame[] = frames.map((frame, index) =>
      index === 2
        ? { ...frame, payload: frame.payload.slice(0, -1) + "X" }
        : frame,
    );

    expect(() => decodeUrFrames(corrupted)).toThrow(/checksum/i);
  });

  it("throws a completeness error when a frame is missing", () => {
    const xdr = buildLargeXdr();
    const frames = encodeUrFrames(xdr);

    const missing = frames.filter((_, index) => index !== 3);

    expect(() => decodeUrFrames(missing)).toThrow(/incomplete|missing/i);
  });
});