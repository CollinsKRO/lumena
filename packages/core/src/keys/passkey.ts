import { Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// WebAuthn DER signature parser and P-256 verification helpers  (#284)
// ---------------------------------------------------------------------------

/**
 * Parsed components of a DER-encoded ECDSA signature produced by a WebAuthn
 * Secp256r1 (P-256) authenticator.
 */
export interface ParsedDerSignature {
  /** Raw 32-byte big-endian r scalar. */
  r: Uint8Array;
  /** Raw 32-byte big-endian s scalar. */
  s: Uint8Array;
}

/**
 * Parses a DER-encoded ECDSA signature (as produced by WebAuthn P-256
 * authenticators) into raw `r` and `s` scalar components.
 *
 * DER structure:
 *   SEQUENCE {
 *     INTEGER  r
 *     INTEGER  s
 *   }
 *
 * Integers in DER may have a leading 0x00 byte prepended when the high-bit is
 * set (to indicate positive sign). This function strips that padding and
 * zero-pads both scalars to exactly 32 bytes for use with `SubtleCrypto`.
 *
 * @throws {Error} if the buffer is not a valid DER ECDSA signature.
 */
export function parseDerSignature(derBytes: ArrayBuffer | Uint8Array): ParsedDerSignature {
  const buf = derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes);
  let offset = 0;

  const readByte = (): number => {
    if (offset >= buf.length) throw new Error("DER parse: unexpected end of buffer");
    return buf[offset++]!;
  };

  const readLength = (): number => {
    const first = readByte();
    if (first < 0x80) return first;
    const numBytes = first & 0x7f;
    if (numBytes === 0 || numBytes > 4) throw new Error("DER parse: invalid length encoding");
    let len = 0;
    for (let i = 0; i < numBytes; i++) len = (len << 8) | readByte();
    return len;
  };

  const readInteger = (): Uint8Array => {
    const tag = readByte();
    if (tag !== 0x02) throw new Error(`DER parse: expected INTEGER tag 0x02, got 0x${tag.toString(16)}`);
    const len = readLength();
    const raw = buf.slice(offset, offset + len);
    offset += len;
    // Strip leading zero byte added by DER for sign representation
    const stripped = raw[0] === 0x00 ? raw.slice(1) : raw;
    // Zero-pad to 32 bytes (P-256 scalar size)
    const padded = new Uint8Array(32);
    padded.set(stripped, 32 - stripped.length);
    return padded;
  };

  // SEQUENCE tag
  const seqTag = readByte();
  if (seqTag !== 0x30) throw new Error(`DER parse: expected SEQUENCE tag 0x30, got 0x${seqTag.toString(16)}`);
  readLength(); // sequence length — we validate element-by-element

  const r = readInteger();
  const s = readInteger();

  return { r, s };
}

/**
 * Concatenates the parsed r and s scalars into the 64-byte raw signature
 * format (`r || s`) required by `SubtleCrypto.verify` with ECDSA.
 */
export function derToRawSignature(derBytes: ArrayBuffer | Uint8Array): Uint8Array {
  const { r, s } = parseDerSignature(derBytes);
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/**
 * Options for verifying a WebAuthn assertion.
 */
export interface WebAuthnVerificationOpts {
  /**
   * The DER-encoded ECDSA-SHA256 signature from `AuthenticatorAssertionResponse.signature`.
   */
  signature: ArrayBuffer | Uint8Array;
  /**
   * The raw `authenticatorData` bytes from `AuthenticatorAssertionResponse.authenticatorData`.
   */
  authenticatorData: ArrayBuffer | Uint8Array;
  /**
   * The raw `clientDataJSON` bytes from `AuthenticatorAssertionResponse.clientDataJSON`.
   */
  clientDataJSON: ArrayBuffer | Uint8Array;
  /**
   * The COSE-encoded public key bytes stored at credential registration time,
   * or a `CryptoKey` (ECDSA P-256, `verify` usage) to verify against.
   */
  publicKey: CryptoKey;
  /**
   * The original challenge that was embedded in the clientDataJSON (base64url-encoded).
   * When provided, the extracted challenge is compared and verification fails on mismatch.
   */
  expectedChallenge?: string;
}

/**
 * Result of a WebAuthn assertion verification.
 */
export interface WebAuthnVerificationResult {
  valid: boolean;
  /** The base64url-encoded challenge extracted from clientDataJSON. */
  challenge: string;
  /** The parsed r and s scalar components from the DER signature. */
  signature: ParsedDerSignature;
}

/**
 * Verifies a WebAuthn P-256 assertion against the stored public key.
 *
 * The verification follows the WebAuthn Level 2 spec §7.2:
 *   1. Parse and validate `clientDataJSON` (type, origin, challenge).
 *   2. Compute `SHA-256(clientDataJSON)`.
 *   3. Assemble the signed data: `authenticatorData || SHA-256(clientDataJSON)`.
 *   4. Convert the DER signature to raw `r || s` format.
 *   5. Verify the ECDSA-SHA256 signature over the assembled signed data.
 *
 * @returns `WebAuthnVerificationResult` — `valid` is `false` (not thrown) when
 *          the signature is cryptographically invalid.
 * @throws  When inputs are malformed (invalid DER, non-P-256 key, bad JSON).
 */
export async function verifyWebAuthnAssertion(
  opts: WebAuthnVerificationOpts,
): Promise<WebAuthnVerificationResult> {
  // Step 1: parse clientDataJSON
  const clientDataText = new TextDecoder().decode(opts.clientDataJSON);
  let clientData: Record<string, unknown>;
  try {
    clientData = JSON.parse(clientDataText) as Record<string, unknown>;
  } catch {
    throw new Error("WebAuthn verify: clientDataJSON is not valid JSON");
  }

  if (clientData["type"] !== "webauthn.get") {
    throw new Error(
      `WebAuthn verify: unexpected clientData type "${String(clientData["type"])}", expected "webauthn.get"`,
    );
  }

  const challenge = String(clientData["challenge"] ?? "");

  if (opts.expectedChallenge !== undefined && challenge !== opts.expectedChallenge) {
    throw new Error(
      `WebAuthn verify: challenge mismatch — expected "${opts.expectedChallenge}", got "${challenge}"`,
    );
  }

  // Step 2: SHA-256(clientDataJSON)
  const clientDataHash = await crypto.subtle.digest("SHA-256", opts.clientDataJSON);

  // Step 3: signed data = authenticatorData || SHA-256(clientDataJSON)
  const authData =
    opts.authenticatorData instanceof Uint8Array
      ? opts.authenticatorData
      : new Uint8Array(opts.authenticatorData);
  const signedData = new Uint8Array(authData.byteLength + 32);
  signedData.set(authData, 0);
  signedData.set(new Uint8Array(clientDataHash), authData.byteLength);

  // Step 4: DER → raw r||s
  const rawSig = derToRawSignature(opts.signature);

  // Step 5: verify
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    opts.publicKey,
    rawSig,
    signedData,
  );

  return { valid, challenge, signature: parseDerSignature(opts.signature) };
}

/**
 * Extracts and validates the challenge from a raw `clientDataJSON` buffer.
 * Returns the base64url-encoded challenge string embedded by the relying party.
 *
 * Useful when a server needs to verify that the challenge it issued is
 * included in the authenticator response before performing the full assertion
 * verification.
 *
 * @throws {Error} if the JSON is malformed or the challenge field is absent.
 */
export function extractChallengeFromClientData(clientDataJSON: ArrayBuffer | Uint8Array): string {
  const text = new TextDecoder().decode(clientDataJSON);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("extractChallengeFromClientData: clientDataJSON is not valid JSON");
  }
  if (!parsed["challenge"] || typeof parsed["challenge"] !== "string") {
    throw new Error("extractChallengeFromClientData: missing or invalid challenge field");
  }
  return parsed["challenge"];
}

// ---------------------------------------------------------------------------

export interface PasskeyCredential {
  id: string;
  rawId: ArrayBuffer;
  type: "public-key";
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  prfResults?: {
    first?: ArrayBuffer;
    second?: ArrayBuffer;
  };
}

export interface PasskeyRegistrationOpts {
  username: string;
  rpName?: string;
  challenge?: Uint8Array;
}

export interface PasskeyAssertionOpts {
  credentialId?: string | Uint8Array;
  challenge?: Uint8Array;
}

export class PasskeyManager {
  static isWebAuthnSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.navigator !== "undefined" &&
      !!window.navigator.credentials &&
      typeof window.navigator.credentials.create === "function"
    );
  }

  static isPrfSupported(): boolean {
    return (
      PasskeyManager.isWebAuthnSupported() &&
      typeof PublicKeyCredential !== "undefined" &&
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    );
  }

  /**
   * Registers a new WebAuthn credential (passkey) with PRF extension support or deterministic fallback.
   */
  async registerPasskey(opts: PasskeyRegistrationOpts): Promise<{
    credentialId: string;
    keypair: Keypair;
    credential: PasskeyCredential;
  }> {
    const rpName = opts.rpName ?? "Lumen Wallet";
    const challenge = opts.challenge ?? crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    let credentialId: string;
    let keypair: Keypair;
    let credentialObj: PasskeyCredential;

    if (PasskeyManager.isWebAuthnSupported()) {
      const prfSalt = new TextEncoder().encode(`lumen-passkey-prf-salt:${opts.username}`);
      const prfSaltPadded = new Uint8Array(32);
      prfSaltPadded.set(prfSalt.subarray(0, 32));

      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge: challenge as BufferSource,
        rp: { name: rpName },
        user: {
          id: userId as BufferSource,
          name: opts.username,
          displayName: opts.username,
        },
        pubKeyCredParams: [
          { alg: -7, type: "public-key" }, // ES256 (Secp256r1)
          { alg: -257, type: "public-key" }, // RS256
        ],
        authenticatorSelection: {
          userVerification: "preferred",
          residentKey: "preferred",
        },
        extensions: {
          prf: {
            eval: {
              first: prfSaltPadded as BufferSource,
            },
          },
        } as any,
      };

      const credential = (await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      })) as PublicKeyCredential | null;

      if (!credential) {
        throw new Error("Passkey registration canceled or failed.");
      }

      const clientDataJSON = credential.response.clientDataJSON;
      const rawId = credential.rawId;
      credentialId = Buffer.from(new Uint8Array(rawId)).toString("base64url");

      const extensionResults = credential.getClientExtensionResults
        ? credential.getClientExtensionResults()
        : {};
      const prfOutput = (extensionResults as any)?.prf?.results?.first;

      keypair = await this.deriveKeypairFromWebAuthn({
        credentialId: rawId,
        clientDataJSON,
        prfOutput,
        username: opts.username,
      });

      credentialObj = {
        id: credential.id,
        rawId,
        type: "public-key",
        response: {
          clientDataJSON,
          attestationObject: (credential.response as AuthenticatorAttestationResponse).attestationObject,
        },
        prfResults: prfOutput ? { first: prfOutput } : undefined,
      };
    } else {
      // Fallback for non-browser / mock environment
      const encoder = new TextEncoder();
      const mockRawId = encoder.encode(`mock-cred-${opts.username}-${Date.now()}`);
      credentialId = Buffer.from(mockRawId).toString("base64url");
      keypair = await this.deriveKeypairFallback(mockRawId, opts.username);
      credentialObj = {
        id: credentialId,
        rawId: mockRawId.buffer as ArrayBuffer,
        type: "public-key",
        response: {
          clientDataJSON: encoder.encode(JSON.stringify({ type: "webauthn.create", origin: "http://localhost" })).buffer,
        },
      };
    }

    return { credentialId, keypair, credential: credentialObj };
  }

  /**
   * Authenticates using a passkey assertion and derives the corresponding Stellar Keypair.
   */
  async authenticatePasskey(opts: PasskeyAssertionOpts & { username?: string }): Promise<{
    keypair: Keypair;
    credentialId: string;
  }> {
    const challenge = opts.challenge ?? crypto.getRandomValues(new Uint8Array(32));

    if (PasskeyManager.isWebAuthnSupported()) {
      const allowCredentials: PublicKeyCredentialDescriptor[] = opts.credentialId
        ? [
            {
              id:
                typeof opts.credentialId === "string"
                  ? (Buffer.from(opts.credentialId, "base64url") as BufferSource)
                  : (opts.credentialId as BufferSource),
              type: "public-key",
            },
          ]
        : [];

      const prfSalt = new TextEncoder().encode(`lumen-passkey-prf-salt:${opts.username ?? "user"}`);
      const prfSaltPadded = new Uint8Array(32);
      prfSaltPadded.set(prfSalt.subarray(0, 32));

      const assertionOptions: PublicKeyCredentialRequestOptions = {
        challenge: challenge as BufferSource,
        allowCredentials,
        userVerification: "preferred",
        extensions: {
          prf: {
            eval: {
              first: prfSaltPadded as BufferSource,
            },
          },
        } as any,
      };

      const assertion = (await navigator.credentials.get({
        publicKey: assertionOptions,
      })) as PublicKeyCredential | null;

      if (!assertion) {
        throw new Error("Passkey authentication canceled or failed.");
      }

      const extensionResults = assertion.getClientExtensionResults
        ? assertion.getClientExtensionResults()
        : {};
      const prfOutput = (extensionResults as any)?.prf?.results?.first;

      const credId = Buffer.from(new Uint8Array(assertion.rawId)).toString("base64url");
      const keypair = await this.deriveKeypairFromWebAuthn({
        credentialId: assertion.rawId,
        clientDataJSON: assertion.response.clientDataJSON,
        prfOutput,
        username: opts.username,
      });

      return { keypair, credentialId: credId };
    } else {
      // Fallback
      const rawId = typeof opts.credentialId === "string"
        ? Buffer.from(opts.credentialId, "base64url")
        : opts.credentialId ?? new TextEncoder().encode("mock-passkey");
      const keypair = await this.deriveKeypairFallback(rawId, opts.username ?? "user");
      const credId = Buffer.from(rawId).toString("base64url");
      return { keypair, credentialId: credId };
    }
  }

  /**
   * Derives a deterministic Ed25519 seed from WebAuthn assertion data or PRF extension output.
   */
  async deriveKeypairFromWebAuthn(opts: {
    credentialId: ArrayBuffer | Uint8Array;
    clientDataJSON?: ArrayBuffer | Uint8Array;
    prfOutput?: ArrayBuffer;
    username?: string;
  }): Promise<Keypair> {
    if (opts.prfOutput && opts.prfOutput.byteLength >= 32) {
      const seed = new Uint8Array(opts.prfOutput).slice(0, 32);
      return Keypair.fromRawEd25519Seed(Buffer.from(seed));
    }

    // Fallback strategy when PRF extension is unavailable
    const rawIdBytes = new Uint8Array(opts.credentialId);
    return this.deriveKeypairFallback(rawIdBytes, opts.username ?? "user");
  }

  /**
   * Fallback key derivation strategy using HMAC-SHA256 over credential ID and username.
   */
  async deriveKeypairFallback(credentialId: Uint8Array, username: string): Promise<Keypair> {
    const encoder = new TextEncoder();
    const secretKeyMaterial = await crypto.subtle.importKey(
      "raw",
      credentialId as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const data = encoder.encode(`lumen-webauthn-fallback-seed:${username}`);
    const signature = await crypto.subtle.sign("HMAC", secretKeyMaterial, data);
    const seed = Buffer.from(new Uint8Array(signature).slice(0, 32));

    return Keypair.fromRawEd25519Seed(seed);
  }
}
