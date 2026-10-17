import { describe, it, expect } from "vitest";
import { Sep41Token } from "../stellar/sep41.js";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { StellarClient } from "../stellar/client.js";
import {
  MockSep41Token,
  SEP41_DECIMALS,
  SEP41_NAME,
  SEP41_SYMBOL,
} from "../soroban/__tests__/mocks/sep41.js";

describe("Sep41Token", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const dummyClient = new StellarClient({ network: "testnet" });

  describe("Constructor", () => {
    it("initializes with contractId and optional client", () => {
      const token = new Sep41Token(contractId, dummyClient);
      expect(token.contractId).toBe(contractId);
      expect(token.client).toBe(dummyClient);
    });

    it("initializes with client and contractId order", () => {
      const token = new Sep41Token(dummyClient, contractId);
      expect(token.contractId).toBe(contractId);
      expect(token.client).toBe(dummyClient);
    });
  });

  describe("Argument Encoding & Operation Building", () => {
    const fromAddr = Keypair.random().publicKey();
    const toAddr = Keypair.random().publicKey();

    it("encodes buildBalanceOperation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildBalanceOperation(fromAddr);

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes transfer arguments correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.transfer(fromAddr, toAddr, "1000000");

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes approve arguments correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.approve(fromAddr, toAddr, "5000000", 123456);

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes spendable_balance operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildSpendableBalanceOperation(fromAddr);

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes authorized operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildAuthorizedOperation(fromAddr);

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes burn operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.burn(fromAddr, "2500000");

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes burn_from operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.burnFrom(fromAddr, toAddr, "2500000");

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes decimals operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildDecimalsOperation();

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes name operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildNameOperation();

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });

    it("encodes symbol operation correctly", () => {
      const token = new Sep41Token(contractId);
      const op = token.buildSymbolOperation();

      expect(op.body().switch()).toBe(xdr.OperationType.invokeHostFunction());
    });
  });

  describe("Response Parsing", () => {
    it("parses xdr.ScVal i128 response", () => {
      const scVal = nativeToScVal(123456789n, { type: "i128" });
      const parsed = Sep41Token.parseBalanceResponse(scVal);
      expect(parsed).toBe(123456789n);
    });

    it("parses simulation result object", () => {
      const scVal = nativeToScVal(999n, { type: "i128" });
      const simResult = {
        result: {
          retval: scVal,
        },
      };
      const parsed = Sep41Token.parseBalanceResponse(simResult);
      expect(parsed).toBe(999n);
    });

    it("handles fallback and null values", () => {
      expect(Sep41Token.parseBalanceResponse(null)).toBe(0n);
      expect(Sep41Token.parseBalanceResponse("500")).toBe(500n);
      expect(Sep41Token.parseBalanceResponse(100)).toBe(100n);
    });

    it("parses authorized boolean response", () => {
      const scVal = nativeToScVal(true, { type: "bool" });
      expect(Sep41Token.parseAuthorizedResponse(scVal)).toBe(true);
      expect(Sep41Token.parseAuthorizedResponse({ result: { retval: scVal } })).toBe(true);
      expect(Sep41Token.parseAuthorizedResponse(nativeToScVal(false, { type: "bool" }))).toBe(false);
      expect(Sep41Token.parseAuthorizedResponse(null)).toBe(false);
    });

    it("parses decimals u32 response", () => {
      const scVal = nativeToScVal(7, { type: "u32" });
      expect(Sep41Token.parseDecimalsResponse(scVal)).toBe(7);
      expect(Sep41Token.parseDecimalsResponse({ result: { retval: scVal } })).toBe(7);
      expect(Sep41Token.parseDecimalsResponse(null)).toBe(0);
    });

    it("parses name and symbol string responses", () => {
      const nameVal = nativeToScVal("Lumen Token", { type: "string" });
      const symbolVal = nativeToScVal("LMN", { type: "string" });

      expect(Sep41Token.parseNameResponse(nameVal)).toBe("Lumen Token");
      expect(Sep41Token.parseNameResponse({ result: { retval: nameVal } })).toBe("Lumen Token");
      expect(Sep41Token.parseNameResponse(null)).toBe("");

      expect(Sep41Token.parseSymbolResponse(symbolVal)).toBe("LMN");
      expect(Sep41Token.parseSymbolResponse({ result: { retval: symbolVal } })).toBe("LMN");
      expect(Sep41Token.parseSymbolResponse(null)).toBe("");
    });
  });

  describe("Mock bindings", () => {
    it("exposes reference contract metadata", () => {
      const mock = new MockSep41Token();
      expect(mock.decimals()).toBe(SEP41_DECIMALS);
      expect(mock.name()).toBe(SEP41_NAME);
      expect(mock.symbol()).toBe(SEP41_SYMBOL);
    });

    it("tracks balances, spendable balances and authorization", () => {
      const mock = new MockSep41Token();
      const alice = Keypair.random().publicKey();
      const bob = Keypair.random().publicKey();

      mock.mint(alice, 1_000n);
      expect(mock.balance(alice)).toBe(1_000n);
      expect(mock.spendableBalance(alice)).toBe(1_000n);
      expect(mock.authorized(alice)).toBe(true);
      expect(mock.balance(bob)).toBe(0n);

      mock.setAuthorized(bob, false);
      expect(mock.authorized(bob)).toBe(false);
    });

    it("supports transfer, transfer_from, burn and burn_from", () => {
      const mock = new MockSep41Token();
      const alice = Keypair.random().publicKey();
      const bob = Keypair.random().publicKey();
      const spender = Keypair.random().publicKey();

      mock.mint(alice, 1_000n);
      mock.transfer(alice, bob, 400n);
      expect(mock.balance(alice)).toBe(600n);
      expect(mock.balance(bob)).toBe(400n);

      mock.approve(alice, spender, 200n);
      mock.transferFrom(spender, alice, bob, 200n);
      expect(mock.balance(alice)).toBe(400n);
      expect(mock.balance(bob)).toBe(600n);

      mock.burn(alice, 100n);
      expect(mock.balance(alice)).toBe(300n);

      mock.approve(alice, spender, 50n);
      mock.burnFrom(spender, alice, 50n);
      expect(mock.balance(alice)).toBe(250n);
    });

    it("rejects transfers exceeding balance or allowance", () => {
      const mock = new MockSep41Token();
      const alice = Keypair.random().publicKey();
      const bob = Keypair.random().publicKey();

      mock.mint(alice, 10n);
      expect(() => mock.transfer(alice, bob, 11n)).toThrow();
      expect(() => mock.burn(alice, 11n)).toThrow();
    });
  });
});
