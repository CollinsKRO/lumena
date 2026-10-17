/**
 * BIP-44 Multi-Account Hierarchical Deterministic (HD) Key Derivation Engine
 *
 * Implements BIP-44 derivation path `m/44'/148'/<account>'` for Stellar
 * (SLIP-0044 coin type 148) as specified in SEP-0005.
 *
 * References:
 *   - BIP-32: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 *   - BIP-39: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
 *   - BIP-44: https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki
 *   - SEP-0005: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 *   - SLIP-0044: coin type 148 for Stellar Lumens
 */

import { Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Internal BIP-32 / SLIP-0010 Ed25519 key derivation
// ---------------------------------------------------------------------------

/**
 * BIP-32 / SLIP-0010 child key derivation node for Ed25519.
 * Ed25519 only supports hardened derivation (all indexes are hardened).
 */
interface Ed25519Node {
  key: Uint8Array;   // 32-byte private key
  chainCode: Uint8Array; // 32-byte chain code
}

const STELLAR_CURVE_SEED = "ed25519 seed";

/** Hardened index offset as per BIP-32 (2^31). */
const HARDENED_OFFSET = 0x80000000;

/**
 * Derives the root Ed25519 master key from a BIP-39 seed buffer using
 * SLIP-0010 (HMAC-SHA512 with "ed25519 seed" key).
 */
async function deriveMasterKey(seed: Uint8Array): Promise<Ed25519Node> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STELLAR_CURVE_SEED),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );

  const result = new Uint8Array(
    await crypto.subtle.sign("HMAC", keyMaterial, seed),
  );

  return {
    key: result.slice(0, 32),
    chainCode: result.slice(32, 64),
  };
}

/**
 * Derives a hardened child key at `index` from a parent Ed25519 node using
 * SLIP-0010. Per the spec, Ed25519 only supports hardened derivation.
 *
 * @param parent - Parent Ed25519 node (key + chainCode).
 * @param index  - Child index (without hardened offset; the function adds it).
 */
async function deriveChildKey(parent: Ed25519Node, index: number): Promise<Ed25519Node> {
  const hardenedIndex = (index | HARDENED_OFFSET) >>> 0;

  // Data: 0x00 || parent_key || ser32(index)
  const data = new Uint8Array(37);
  data[0] = 0x00;
  data.set(parent.key, 1);
  data[33] = (hardenedIndex >>> 24) & 0xff;
  data[34] = (hardenedIndex >>> 16) & 0xff;
  data[35] = (hardenedIndex >>> 8) & 0xff;
  data[36] = hardenedIndex & 0xff;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    parent.chainCode,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );

  const result = new Uint8Array(await crypto.subtle.sign("HMAC", keyMaterial, data));

  return {
    key: result.slice(0, 32),
    chainCode: result.slice(32, 64),
  };
}

// ---------------------------------------------------------------------------
// BIP-39 mnemonic → seed (PBKDF2-SHA512)
// ---------------------------------------------------------------------------

/**
 * Converts a BIP-39 mnemonic phrase and optional passphrase into a 64-byte
 * seed using PBKDF2-SHA512 with 2048 iterations, as specified in BIP-39.
 *
 * @param mnemonic   - Space-separated BIP-39 mnemonic word list.
 * @param passphrase - Optional BIP-39 passphrase (default: `""`).
 */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase: string = "",
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const mnemonicNFKD = mnemonic.normalize("NFKD");
  const passphraseNFKD = ("mnemonic" + passphrase).normalize("NFKD");

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(mnemonicNFKD),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(passphraseNFKD),
      iterations: 2048,
      hash: "SHA-512",
    },
    keyMaterial,
    512, // 64 bytes
  );

  return new Uint8Array(derivedBits);
}

// ---------------------------------------------------------------------------
// Public HD Wallet API
// ---------------------------------------------------------------------------

/**
 * A derived Stellar account from an HD wallet.
 */
export interface HdDerivedAccount {
  /** BIP-44 derivation path used (e.g. `m/44'/148'/0'`). */
  path: string;
  /** BIP-44 account index. */
  accountIndex: number;
  /** Stellar Keypair for this account. */
  keypair: Keypair;
  /** Stellar public key (G... address). */
  publicKey: string;
}

/**
 * Options for creating an `HdWallet`.
 */
export interface HdWalletOpts {
  /**
   * BIP-39 mnemonic phrase (12 or 24 words).
   * Exactly one of `mnemonic` or `seed` must be provided.
   */
  mnemonic?: string;
  /**
   * Pre-derived 64-byte BIP-39 seed. Use this when you already have a seed
   * and want to skip the mnemonic → seed step.
   * Exactly one of `mnemonic` or `seed` must be provided.
   */
  seed?: Uint8Array;
  /**
   * Optional BIP-39 passphrase used during mnemonic → seed derivation.
   * Ignored when `seed` is provided directly.
   */
  passphrase?: string;
}

/**
 * BIP-44 HD Wallet for Stellar.
 *
 * Derives accounts under the path `m/44'/148'/<accountIndex>'` as defined in
 * SEP-0005, which follows SLIP-0010 Ed25519 hardened derivation.
 *
 * @example
 * ```ts
 * const wallet = await HdWallet.fromMnemonic(
 *   "illness spike retreat truth genius clock brain pass fit cave bargain toe"
 * );
 *
 * const account0 = await wallet.deriveAccount(0);
 * console.log(account0.publicKey); // GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ
 *
 * const accounts = await wallet.listDerivedAccounts(3);
 * ```
 */
export class HdWallet {
  private seed: Uint8Array;

  private constructor(seed: Uint8Array) {
    this.seed = seed;
  }

  /**
   * Creates an `HdWallet` from a BIP-39 mnemonic phrase.
   *
   * @param mnemonic   - Space-separated BIP-39 mnemonic (12 or 24 words).
   * @param passphrase - Optional BIP-39 passphrase (default: `""`).
   */
  static async fromMnemonic(mnemonic: string, passphrase: string = ""): Promise<HdWallet> {
    if (!mnemonic || mnemonic.trim().split(/\s+/).length < 12) {
      throw new Error("HdWallet: mnemonic must contain at least 12 words");
    }
    const seed = await mnemonicToSeed(mnemonic.trim(), passphrase);
    return new HdWallet(seed);
  }

  /**
   * Creates an `HdWallet` directly from a 64-byte BIP-39 seed buffer.
   *
   * @param seed - 64-byte seed (e.g. the output of `mnemonicToSeed`).
   */
  static fromSeed(seed: Uint8Array): HdWallet {
    if (seed.byteLength !== 64) {
      throw new Error(`HdWallet: seed must be exactly 64 bytes, got ${seed.byteLength}`);
    }
    return new HdWallet(seed);
  }

  /**
   * Parses a BIP-44 path string in the form `m/44'/148'/<index>'` and
   * returns the account index.
   *
   * @throws if the path does not match the Stellar BIP-44 scheme.
   */
  static parsePath(path: string): number {
    const match = /^m\/44'\/148'\/(\d+)'$/.exec(path.trim());
    if (!match || !match[1]) {
      throw new Error(
        `HdWallet: invalid Stellar BIP-44 path "${path}". ` +
          "Expected format: m/44'/148'/<accountIndex>'",
      );
    }
    return parseInt(match[1], 10);
  }

  /**
   * Builds the canonical BIP-44 path for the given account index.
   *
   * @example
   * HdWallet.buildPath(0) // → "m/44'/148'/0'"
   */
  static buildPath(accountIndex: number): string {
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
      throw new Error(`HdWallet: accountIndex must be a non-negative integer, got ${accountIndex}`);
    }
    return `m/44'/148'/${accountIndex}'`;
  }

  /**
   * Derives the Stellar Keypair at BIP-44 path `m/44'/148'/<accountIndex>'`.
   *
   * The derivation follows SLIP-0010 Ed25519:
   *   1. Master key = HMAC-SHA512("ed25519 seed", seed)
   *   2. Child at 44' (purpose)
   *   3. Child at 148' (Stellar coin type, SLIP-0044)
   *   4. Child at <accountIndex>' (account)
   *
   * @param accountIndex - BIP-44 account level index (0-based).
   */
  async deriveAccount(accountIndex: number): Promise<HdDerivedAccount> {
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
      throw new Error(`HdWallet.deriveAccount: accountIndex must be a non-negative integer, got ${accountIndex}`);
    }

    const master = await deriveMasterKey(this.seed);
    // m/44' — BIP-44 purpose
    const purposeNode = await deriveChildKey(master, 44);
    // m/44'/148' — Stellar coin type (SLIP-0044)
    const coinTypeNode = await deriveChildKey(purposeNode, 148);
    // m/44'/148'/<accountIndex>'
    const accountNode = await deriveChildKey(coinTypeNode, accountIndex);

    const keypair = Keypair.fromRawEd25519Seed(Buffer.from(accountNode.key));
    const path = HdWallet.buildPath(accountIndex);

    return {
      path,
      accountIndex,
      keypair,
      publicKey: keypair.publicKey(),
    };
  }

  /**
   * Derives the Stellar Keypair at an explicit BIP-44 path string.
   *
   * The path must conform to `m/44'/148'/<accountIndex>'`.
   *
   * @param path - BIP-44 path string, e.g. `"m/44'/148'/2'"`.
   */
  async deriveAccountFromPath(path: string): Promise<HdDerivedAccount> {
    const accountIndex = HdWallet.parsePath(path);
    return this.deriveAccount(accountIndex);
  }

  /**
   * Derives `count` consecutive accounts starting at index 0.
   *
   * @param count - Number of accounts to derive (must be ≥ 1).
   * @returns An array of `HdDerivedAccount` objects ordered by account index.
   */
  async listDerivedAccounts(count: number): Promise<HdDerivedAccount[]> {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`HdWallet.listDerivedAccounts: count must be a positive integer, got ${count}`);
    }

    const accounts: HdDerivedAccount[] = [];
    for (let i = 0; i < count; i++) {
      accounts.push(await this.deriveAccount(i));
    }
    return accounts;
  }
}
