import { createHash } from 'crypto';
import type { Signer } from './Signer';
import { SignerError } from '../errors';

/**
 * Minimal structural typing for the subset of `pkcs11js` we rely on.
 * This avoids a hard compile-time dependency on the native binding while
 * still allowing the real module to be injected at runtime.
 */
interface Pkcs11Module {
  C_Initialize(initArgs?: unknown): void;
  C_Finalize(): void;
  C_GetSlotList(tokenPresent: boolean): Buffer[];
  C_OpenSession(slot: Buffer, flags: number, application?: unknown, notify?: unknown): Buffer;
  C_CloseSession(session: Buffer): void;
  C_Login(session: Buffer, userType: number, pin: string): void;
  C_Logout(session: Buffer): void;
  C_FindObjectsInit(session: Buffer, template: unknown[]): void;
  C_FindObjects(session: Buffer, maxObjectCount: number): Buffer[];
  C_FindObjectsFinal(session: Buffer): void;
  C_GetAttributeValue(session: Buffer, object: Buffer, template: unknown[]): void;
  C_SignInit(session: Buffer, mechanism: unknown, key: Buffer): void;
  C_Sign(session: Buffer, data: Buffer): Buffer;
  CKF_SERIAL_SESSION: number;
  CKF_RW_SESSION: number;
  CKU_USER: number;
  CKA_CLASS: number;
  CKA_KEY_TYPE: number;
  CKA_LABEL: number;
  CKA_SIGN: number;
  CKA_EC_POINT: number;
  CKO_PRIVATE_KEY: number;
  CKK_EC: number;
  CKM_ECDSA: number;
}

export interface Pkcs11SignerOptions {
  /** Absolute path to the PKCS#11 provider library (e.g. SoftHSM2 `.so`). */
  modulePath: string;
  /** Slot ID containing the token that holds the key. */
  slotId: number;
  /** User PIN used to log into the token. */
  pin: string;
  /** CKA_LABEL of the private key object to sign with. */
  keyLabel: string;
  /** Optional injected pkcs11js module (defaults to requiring `pkcs11js`). */
  pkcs11?: Pkcs11Module;
}

/**
 * PKCS#11-backed {@link Signer} implementation for enterprise custody.
 *
 * The private key material never leaves the HSM: signing is delegated to the
 * token via `C_Sign`, and only the public key is ever read back.
 */
export class Pkcs11Signer implements Signer {
  private readonly pkcs11: Pkcs11Module;
  private readonly slotId: number;
  private readonly pin: string;
  private readonly keyLabel: string;

  private session: Buffer | null = null;
  private privateKeyHandle: Buffer | null = null;
  private publicKeyBytes: Buffer | null = null;
  private loggedIn = false;
  private initialized = false;

  constructor(options: Pkcs11SignerOptions) {
    if (!options.modulePath) {
      throw new SignerError('Pkcs11Signer requires a modulePath');
    }
    if (!options.keyLabel) {
      throw new SignerError('Pkcs11Signer requires a keyLabel');
    }
    if (typeof options.slotId !== 'number' || options.slotId < 0) {
      throw new SignerError('Pkcs11Signer requires a valid slotId');
    }

    this.slotId = options.slotId;
    this.pin = options.pin;
    this.keyLabel = options.keyLabel;
    this.pkcs11 = options.pkcs11 ?? Pkcs11Signer.loadModule(options.modulePath);

    this.initialize();
  }

  private static loadModule(modulePath: string): Pkcs11Module {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkcs11js = require('pkcs11js');
      const instance = new pkcs11js.PKCS11();
      instance.load(modulePath);
      return instance as Pkcs11Module;
    } catch (err) {
      throw new SignerError(
        `Failed to load PKCS#11 module at ${modulePath}: ${(err as Error).message}`,
        err,
      );
    }
  }

  private initialize(): void {
    try {
      this.pkcs11.C_Initialize();
      this.initialized = true;
    } catch (err) {
      // CKR_CRYPTOKI_ALREADY_INITIALIZED (0x191) is benign.
      if (!Pkcs11Signer.isAlreadyInitialized(err)) {
        throw new SignerError(
          `PKCS#11 C_Initialize failed: ${Pkcs11Signer.describeError(err)}`,
          err,
        );
      }
      this.initialized = true;
    }

    try {
      this.openSession();
      this.login();
      this.privateKeyHandle = this.findPrivateKey();
      this.publicKeyBytes = this.readPublicKey();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private openSession(): void {
    try {
      const flags =
        this.pkcs11.CKF_SERIAL_SESSION | this.pkcs11.CKF_RW_SESSION;
      this.session = this.pkcs11.C_OpenSession(this.slotBuffer(), flags);
    } catch (err) {
      throw new SignerError(
        `PKCS#11 C_OpenSession failed for slot ${this.slotId}: ${Pkcs11Signer.describeError(err)}`,
        err,
      );
    }
  }

  private login(): void {
    if (!this.session) {
      throw new SignerError('PKCS#11 session is not open');
    }
    try {
      this.pkcs11.C_Login(this.session, this.pkcs11.CKU_USER, this.pin);
      this.loggedIn = true;
    } catch (err) {
      // CKR_USER_ALREADY_LOGGED_IN (0x100) is benign.
      if (!Pkcs11Signer.isAlreadyLoggedIn(err)) {
        throw new SignerError(
          `PKCS#11 C_Login failed: ${Pkcs11Signer.describeError(err)}`,
          err,
        );
      }
      this.loggedIn = true;
    }
  }

  private findPrivateKey(): Buffer {
    if (!this.session) {
      throw new SignerError('PKCS#11 session is not open');
    }
    const template = [
      { type: this.pkcs11.CKA_CLASS, value: this.pkcs11.CKO_PRIVATE_KEY },
      { type: this.pkcs11.CKA_KEY_TYPE, value: this.pkcs11.CKK_EC },
      { type: this.pkcs11.CKA_LABEL, value: this.keyLabel },
      { type: this.pkcs11.CKA_SIGN, value: true },
    ];

    try {
      this.pkcs11.C_FindObjectsInit(this.session, template);
      let handles: Buffer[];
      try {
        handles = this.pkcs11.C_FindObjects(this.session, 2);
      } finally {
        this.pkcs11.C_FindObjectsFinal(this.session);
      }

      if (handles.length === 0) {
        throw new SignerError(
          `No private key found with label "${this.keyLabel}" in slot ${this.slotId}`,
        );
      }
      if (handles.length > 1) {
        throw new SignerError(
          `Multiple private keys found with label "${this.keyLabel}" in slot ${this.slotId}`,
        );
      }
      return handles[0];
    } catch (err) {
      if (err instanceof SignerError) {
        throw err;
      }
      throw new SignerError(
        `PKCS#11 key lookup failed: ${Pkcs11Signer.describeError(err)}`,
        err,
      );
    }
  }

  private readPublicKey(): Buffer {
    if (!this.session || !this.privateKeyHandle) {
      throw new SignerError('PKCS#11 session or key handle is not available');
    }
    try {
      const template = [{ type: this.pkcs11.CKA_EC_POINT, value: null }];
      this.pkcs11.C_GetAttributeValue(
        this.session,
        this.privateKeyHandle,
        template,
      );
      const value = (template[0] as { value: Buffer | null }).value;
      if (!value) {
        throw new SignerError('PKCS#11 key does not expose CKA_EC_POINT');
      }
      return Pkcs11Signer.decodeEcPoint(value);
    } catch (err) {
      if (err instanceof SignerError) {
        throw err;
      }
      throw new SignerError(
        `PKCS#11 C_GetAttributeValue failed: ${Pkcs11Signer.describeError(err)}`,
        err,
      );
    }
  }

  /**
   * Sign an arbitrary payload. The payload is hashed with SHA-256 and the
   * digest is signed using ECDSA on the token.
   */
  async sign(payload: Buffer | Uint8Array | string): Promise<Buffer> {
    if (!this.session || !this.privateKeyHandle) {
      throw new SignerError('Pkcs11Signer is not initialized');
    }

    const data = Buffer.isBuffer(payload)
      ? payload
      : typeof payload === 'string'
        ? Buffer.from(payload, 'utf8')
        : Buffer.from(payload);

    const digest = createHash('sha256').update(data).digest();

    try {
      this.pkcs11.C_SignInit(
        this.session,
        { mechanism: this.pkcs11.CKM_ECDSA },
        this.privateKeyHandle,
      );
      const signature = this.pkcs11.C_Sign(this.session, digest);
      return Buffer.from(signature);
    } catch (err) {
      throw new SignerError(
        `PKCS#11 C_Sign failed: ${Pkcs11Signer.describeError(err)}`,
        err,
      );
    }
  }

  /**
   * Returns the uncompressed SEC1 public key (0x04 || X || Y).
   */
  async publicKey(): Promise<Buffer> {
    if (!this.publicKeyBytes) {
      throw new SignerError('Pkcs11Signer public key is not available');
    }
    return Buffer.from(this.publicKeyBytes);
  }

  /**
   * Release the session, log out, and finalize the module.
   */
  close(): void {
    if (this.session) {
      if (this.loggedIn) {
        try {
          this.pkcs11.C_Logout(this.session);
        } catch {
          // Best-effort logout; ignore errors during teardown.
        }
        this.loggedIn = false;
      }
      try {
        this.pkcs11.C_CloseSession(this.session);
      } catch {
        // Best-effort close; ignore errors during teardown.
      }
      this.session = null;
    }

    this.privateKeyHandle = null;
    this.publicKeyBytes = null;

    if (this.initialized) {
      try {
        this.pkcs11.C_Finalize();
      } catch {
        // Best-effort finalize; ignore errors during teardown.
      }
      this.initialized = false;
    }
  }

  private slotBuffer(): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(this.slotId, 0);
    return buf;
  }

  private static decodeEcPoint(raw: Buffer): Buffer {
    // Some tokens wrap the EC point in a DER OCTET STRING (0x04 <len> ...).
    if (raw.length > 2 && raw[0] === 0x04 && raw[1] === raw.length - 2) {
      return Buffer.from(raw.subarray(2));
    }
    return Buffer.from(raw);
  }

  private static isAlreadyInitialized(err: unknown): boolean {
    return Pkcs11Signer.errorCode(err) === 0x191;
  }

  private static isAlreadyLoggedIn(err: unknown): boolean {
    return Pkcs11Signer.errorCode(err) === 0x100;
  }

  private static errorCode(err: unknown): number | null {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: unknown }).code;
      if (typeof code === 'number') {
        return code;
      }
    }
    return null;
  }

  private static describeError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}