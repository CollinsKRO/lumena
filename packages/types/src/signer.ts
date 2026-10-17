/**
 * Signer abstracts over how a private key operation is performed.
 *
 * In development / testnet:  EnvSigner  — wraps a raw Stellar Keypair loaded
 *                                         from an environment variable.
 * In production:             AwsKmsSigner, GcpKmsSigner, VaultSigner, etc. —
 *                            the private key never leaves the HSM; only the
 *                            signature bytes are returned.
 *
 * Both CosignerService and FeeSponsorService depend on this interface so that
 * switching from env-based secrets to a KMS/HSM is a wiring change in main.ts,
 * not a service-level change.
 */
export interface Signer {
  /**
   * Returns the Ed25519 public key in Stellar's strkey format (G…).
   */
  publicKey(): string;

  /**
   * Signs the 32-byte transaction hash and returns the 64-byte signature.
   *
   * @param payload - The raw bytes to sign (typically tx.hash()).
   *                  Uses Uint8Array for cross-platform compatibility;
   *                  Node.js Buffer is a Uint8Array subtype and is accepted.
   */
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export interface GcpKmsSignerConfig {
  projectId?: string;
  locationId?: string;
  keyRingId?: string;
  keyId?: string;
  keyVersion?: string;
  /** Full resource name, e.g. projects/.../locations/.../keyRings/.../cryptoKeys/.../cryptoKeyVersions/... */
  keyResourceName?: string;
  endpoint?: string;
}

export interface VaultSignerConfig {
  vaultUrl: string;
  token: string;
  keyName: string;
  mountPath?: string; // defaults to 'transit'
  namespace?: string;
  prehashed?: boolean;
}

export interface Pkcs11SignerConfig {
  /** Path to the PKCS#11 provider library, e.g. /usr/lib/softhsm/libsofthsm2.so */
  modulePath: string;
  /** PKCS#11 slot ID containing the token. */
  slotId: number;
  /** PIN used to log into the token session. */
  pin: string;
  /** CKA_LABEL of the private key object to sign with. */
  keyLabel: string;
  /** Optional CKA_ID of the private key object (used when label is ambiguous). */
  keyId?: string;
  /** Optional user PIN, if distinct from the primary PIN. */
  userPin?: string;
}
