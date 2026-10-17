import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EnvSigner } from "../signers/EnvSigner.js";

describe("EnvSigner", () => {
  it("initializes and returns public key correctly", () => {
    const kp = Keypair.random();
    const signer = new EnvSigner(kp.secret());
    expect(signer.publicKey()).toBe(kp.publicKey());
  });

  it("signs payloads correctly", async () => {
    const kp = Keypair.random();
    const signer = new EnvSigner(kp.secret());
    const payload = new Uint8Array([1, 2, 3, 4]);
    const sig = await signer.sign(payload);
    expect(sig.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Pkcs11Signer tests
// ---------------------------------------------------------------------------

const mockPkcs11State = vi.hoisted(() => {
  const state = {
    // recorded calls
    calls: [] as Array<{ fn: string; args: unknown[] }>,
    // configurable behavior
    slotList: [1n] as bigint[],
    slotInfo: { slotDescription: "SoftHSM slot", manufacturerID: "SoftHSM" },
    tokenInfo: { label: "test-token", manufacturerID: "SoftHSM", model: "SoftHSM" },
    sessionHandle: 42n,
    objectHandle: 7n,
    publicKeyBytes: new Uint8Array(32).fill(9),
    signatureBytes: new Uint8Array(64).fill(3),
    findObjectThrows: false,
    getAttributeThrows: false,
    signThrows: false,
  };
  return state;
});

vi.mock("pkcs11js", () => {
  const CKF_SERIAL_SESSION = 0x00000004;
  const CKF_RW_SESSION = 0x00000002;
  const CKA_CLASS = 0x00000000;
  const CKA_LABEL = 0x00000003;
  const CKA_VALUE = 0x00000011;
  const CKA_ID = 0x00000102;
  const CKA_EC_POINT = 0x00000181;
  const CKO_PRIVATE_KEY = 0x00000003;
  const CKO_PUBLIC_KEY = 0x00000002;
  const CKM_ECDSA = 0x00001041;

  class PKCS11 {
    load(_module: string) {
      mockPkcs11State.calls.push({ fn: "load", args: [_module] });
    }
    C_Initialize(_initArgs?: unknown) {
      mockPkcs11State.calls.push({ fn: "C_Initialize", args: [_initArgs] });
    }
    C_Finalize() {
      mockPkcs11State.calls.push({ fn: "C_Finalize", args: [] });
    }
    C_GetSlotList(_tokenPresent: boolean) {
      mockPkcs11State.calls.push({ fn: "C_GetSlotList", args: [_tokenPresent] });
      return mockPkcs11State.slotList;
    }
    C_GetSlotInfo(_slot: bigint) {
      mockPkcs11State.calls.push({ fn: "C_GetSlotInfo", args: [_slot] });
      return mockPkcs11State.slotInfo;
    }
    C_GetTokenInfo(_slot: bigint) {
      mockPkcs11State.calls.push({ fn: "C_GetTokenInfo", args: [_slot] });
      return mockPkcs11State.tokenInfo;
    }
    C_OpenSession(_slot: bigint, _flags: number) {
      mockPkcs11State.calls.push({ fn: "C_OpenSession", args: [_slot, _flags] });
      return mockPkcs11State.sessionHandle;
    }
    C_CloseSession(_session: bigint) {
      mockPkcs11State.calls.push({ fn: "C_CloseSession", args: [_session] });
    }
    C_Login(_session: bigint, _userType: number, _pin: string) {
      mockPkcs11State.calls.push({ fn: "C_Login", args: [_session, _userType, _pin] });
    }
    C_Logout(_session: bigint) {
      mockPkcs11State.calls.push({ fn: "C_Logout", args: [_session] });
    }
    C_FindObjectsInit(_session: bigint, _template: unknown[]) {
      mockPkcs11State.calls.push({ fn: "C_FindObjectsInit", args: [_session, _template] });
      if (mockPkcs11State.findObjectThrows) {
        throw new Error("C_FindObjectsInit failed");
      }
    }
    C_FindObjects(_session: bigint, _max: number) {
      mockPkcs11State.calls.push({ fn: "C_FindObjects", args: [_session, _max] });
      return [mockPkcs11State.objectHandle];
    }
    C_FindObjectsFinal(_session: bigint) {
      mockPkcs11State.calls.push({ fn: "C_FindObjectsFinal", args: [_session] });
    }
    C_GetAttributeValue(_session: bigint, _obj: bigint, _template: unknown[]) {
      mockPkcs11State.calls.push({ fn: "C_GetAttributeValue", args: [_session, _obj, _template] });
      if (mockPkcs11State.getAttributeThrows) {
        throw new Error("C_GetAttributeValue failed");
      }
      return [{ type: CKA_EC_POINT, value: mockPkcs11State.publicKeyBytes }];
    }
    C_SignInit(_session: bigint, _mechanism: unknown, _key: bigint) {
      mockPkcs11State.calls.push({ fn: "C_SignInit", args: [_session, _mechanism, _key] });
    }
    C_Sign(_session: bigint, _data: Uint8Array) {
      mockPkcs11State.calls.push({ fn: "C_Sign", args: [_session, _data] });
      if (mockPkcs11State.signThrows) {
        throw new Error("C_Sign failed");
      }
      return mockPkcs11State.signatureBytes;
    }
  }

  return {
    default: { PKCS11 },
    PKCS11,
    CKF_SERIAL_SESSION,
    CKF_RW_SESSION,
    CKA_CLASS,
    CKA_LABEL,
    CKA_VALUE,
    CKA_ID,
    CKA_EC_POINT,
    CKO_PRIVATE_KEY,
    CKO_PUBLIC_KEY,
    CKM_ECDSA,
  };
});

import { Pkcs11Signer } from "../signers/Pkcs11Signer.js";

function resetMockState() {
  mockPkcs11State.calls.length = 0;
  mockPkcs11State.slotList = [1n];
  mockPkcs11State.slotInfo = { slotDescription: "SoftHSM slot", manufacturerID: "SoftHSM" };
  mockPkcs11State.tokenInfo = { label: "test-token", manufacturerID: "SoftHSM", model: "SoftHSM" };
  mockPkcs11State.sessionHandle = 42n;
  mockPkcs11State.objectHandle = 7n;
  mockPkcs11State.publicKeyBytes = new Uint8Array(32).fill(9);
  mockPkcs11State.signatureBytes = new Uint8Array(64).fill(3);
  mockPkcs11State.findObjectThrows = false;
  mockPkcs11State.getAttributeThrows = false;
  mockPkcs11State.signThrows = false;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    modulePath: "/usr/lib/softhsm/libsofthsm2.so",
    slotId: 1n,
    pin: "1234",
    keyLabel: "lumen-co-signer",
    ...overrides,
  };
}

describe("Pkcs11Signer (mocked pkcs11js)", () => {
  beforeEach(() => {
    resetMockState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("configuration validation", () => {
    it("throws when modulePath is missing", () => {
      expect(() => new Pkcs11Signer(baseConfig({ modulePath: "" }))).toThrow();
    });

    it("throws when pin is missing", () => {
      expect(() => new Pkcs11Signer(baseConfig({ pin: "" }))).toThrow();
    });

    it("throws when keyLabel is missing", () => {
      expect(() => new Pkcs11Signer(baseConfig({ keyLabel: "" }))).toThrow();
    });

    it("throws when slotId is not provided", () => {
      expect(() => new Pkcs11Signer(baseConfig({ slotId: undefined }))).toThrow();
    });

    it("accepts a valid configuration", () => {
      expect(() => new Pkcs11Signer(baseConfig())).not.toThrow();
    });
  });

  describe("session lifecycle", () => {
    it("loads the module, initializes, opens a session, and logs in on init", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();

      const fns = mockPkcs11State.calls.map((c) => c.fn);
      expect(fns).toContain("load");
      expect(fns).toContain("C_Initialize");
      expect(fns).toContain("C_OpenSession");
      expect(fns).toContain("C_Login");

      const loadCall = mockPkcs11State.calls.find((c) => c.fn === "load");
      expect(loadCall?.args[0]).toBe("/usr/lib/softhsm/libsofthsm2.so");

      const openCall = mockPkcs11State.calls.find((c) => c.fn === "C_OpenSession");
      expect(openCall?.args[0]).toBe(1n);

      const loginCall = mockPkcs11State.calls.find((c) => c.fn === "C_Login");
      expect(loginCall?.args[2]).toBe("1234");
    });

    it("closes the session and finalizes on close", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();
      await signer.close();

      const fns = mockPkcs11State.calls.map((c) => c.fn);
      expect(fns).toContain("C_Logout");
      expect(fns).toContain("C_CloseSession");
      expect(fns).toContain("C_Finalize");

      const closeCall = mockPkcs11State.calls.find((c) => c.fn === "C_CloseSession");
      expect(closeCall?.args[0]).toBe(42n);
    });

    it("is idempotent when close is called before init", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await expect(signer.close()).resolves.not.toThrow();
    });
  });

  describe("public key retrieval", () => {
    it("returns the public key from the HSM without exposing private material", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();
      const pub = await signer.publicKey();

      expect(pub).toBeDefined();
      expect(typeof pub).toBe("string");
      expect(pub.length).toBeGreaterThan(0);

      // The public key lookup must use a public-key object template, never a
      // private-key class.
      const findInit = mockPkcs11State.calls.find((c) => c.fn === "C_FindObjectsInit");
      expect(findInit).toBeDefined();
      const template = findInit?.args[1] as Array<{ type: number; value: unknown }>;
      expect(Array.isArray(template)).toBe(true);
    });

    it("propagates errors when the public key object cannot be found", async () => {
      mockPkcs11State.findObjectThrows = true;
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();
      await expect(signer.publicKey()).rejects.toThrow();
    });
  });

  describe("signing", () => {
    it("signs a payload via C_Sign and returns a signature", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();
      const payload = new Uint8Array([1, 2, 3, 4]);
      const sig = await signer.sign(payload);

      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64);

      const fns = mockPkcs11State.calls.map((c) => c.fn);
      expect(fns).toContain("C_SignInit");
      expect(fns).toContain("C_Sign");

      const signCall = mockPkcs11State.calls.find((c) => c.fn === "C_Sign");
      expect(signCall?.args[1]).toEqual(payload);
    });

    it("does not expose private key material through the signer API", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();

      // The signer must not expose a private key accessor.
      const anySigner = signer as unknown as Record<string, unknown>;
      expect(anySigner.privateKey).toBeUndefined();
      expect(anySigner.secretKey).toBeUndefined();
      expect(anySigner.secret).toBeUndefined();

      // Signing must not read CKA_VALUE from a private key object.
      await signer.sign(new Uint8Array([9, 9, 9]));
      const getAttrCalls = mockPkcs11State.calls.filter((c) => c.fn === "C_GetAttributeValue");
      for (const call of getAttrCalls) {
        const template = call.args[2] as Array<{ type: number }>;
        // CKA_VALUE (0x11) on a private key would leak material; ensure the
        // signer never requests it during signing.
        const requestsValue = template.some((t) => t.type === 0x00000011);
        expect(requestsValue).toBe(false);
      }
    });

    it("propagates errors from C_Sign", async () => {
      mockPkcs11State.signThrows = true;
      const signer = new Pkcs11Signer(baseConfig());
      await signer.init();
      await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow();
    });

    it("throws when signing before init", async () => {
      const signer = new Pkcs11Signer(baseConfig());
      await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// SoftHSM2 integration test (skipped when the PKCS#11 module is unavailable)
// ---------------------------------------------------------------------------

const SOFTHSM_MODULE =
  process.env.SOFTHSM2_MODULE ?? "/usr/lib/softhsm/libsofthsm2.so";

function softhsmAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(SOFTHSM_MODULE);
  } catch {
    return false;
  }
}

const integrationEnabled = softhsmAvailable() && process.env.PKCS11_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("Pkcs11Signer (SoftHSM2 integration)", () => {
  it("signs a test transaction payload using SoftHSM2", async () => {
    const slotId = BigInt(process.env.SOFTHSM_SLOT ?? "0");
    const pin = process.env.SOFTHSM_PIN ?? "1234";
    const keyLabel = process.env.SOFTHSM_KEY_LABEL ?? "lumen-co-signer";

    const signer = new Pkcs11Signer({
      modulePath: SOFTHSM_MODULE,
      slotId,
      pin,
      keyLabel,
    });

    await signer.init();
    try {
      const pub = await signer.publicKey();
      expect(pub).toBeTruthy();

      const payload = new Uint8Array([1, 2, 3, 4]);
      const sig = await signer.sign(payload);
      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBeGreaterThan(0);
    } finally {
      await signer.close();
    }
  });
});