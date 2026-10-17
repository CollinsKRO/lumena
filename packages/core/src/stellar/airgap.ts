/**
 * Air-gapped offline transaction drafting and animated QR-code signer pipeline.
 *
 * High-security wallets frequently keep the signing key on a device that has no
 * network interface at all (an "air-gapped" device). The only practical way to
 * move a transaction from an online device to the signer and back is via an
 * optical channel: animated QR codes.
 *
 * This module implements a small, self-contained multipart URI scheme inspired
 * by Blockchain Commons' BC-UR format. A (potentially large) base64-encoded
 * Stellar transaction XDR envelope is split into ordered fragments, each of
 * which is rendered as a single QR frame. The frames are displayed in a loop
 * (an "animated" QR code) and scanned by the air-gapped device, which
 * reassembles and verifies the payload before signing.
 *
 * Frame format:
 *
 *     ur:lumen-tx/<seq>-<total>/<checksum>/<payload>
 *
 *   - `seq`     1-based index of the frame.
 *   - `total`   total number of frames in the sequence.
 *   - `checksum` CRC32 (8 lowercase hex chars) of the *full* reassembled payload.
 *   - `payload`  a fragment of the base64 XDR string.
 *
 * The checksum is carried on every frame so that the receiving device can
 * verify integrity as soon as the final fragment arrives, without any
 * out-of-band data.
 *
 * @module stellar/airgap
 */

/** Options controlling how an XDR envelope is split into QR frames. */
export interface AirgapOptions {
  /**
   * Maximum length (in characters) of the full URI for a single frame.
   * When provided, the fragment size is derived from this budget so that no
   * frame exceeds it. Ignored when `fragmentSize` is also provided.
   */
  maxFrameLength?: number;
  /**
   * Number of payload characters carried by each frame. Defaults to a value
   * chosen so that a 2KB XDR envelope fits in 5 frames.
   */
  fragmentSize?: number;
}

/** A single decoded multipart frame. */
export interface UrFrame {
  /** 1-based sequence number of this frame. */
  seq: number;
  /** Total number of frames in the sequence. */
  total: number;
  /** CRC32 checksum (8 lowercase hex chars) of the full payload. */
  checksum: string;
  /** The payload fragment carried by this frame. */
  payload: string;
}

const UR_PREFIX = 'ur:lumen-tx/';

/**
 * Default fragment size. A 2KB (2048 byte) XDR envelope base64-encodes to
 * roughly 2732 characters; splitting that into 5 frames requires fragments of
 * at most ~547 characters. We use 512 to leave headroom and keep frames small
 * enough for reliable scanning.
 */
const DEFAULT_FRAGMENT_SIZE = 512;

/** Overhead of the URI prefix plus `seq-total/checksum/` separators. */
const FRAME_OVERHEAD = UR_PREFIX.length + 8 + 8 + 3;

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC32_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Computes the CRC32 checksum of a string (UTF-8 encoded) and returns it as an
 * 8-character lowercase hexadecimal string.
 */
function crc32(input: string): string {
  const bytes = utf8Encode(input);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, '0');
}

/** Minimal UTF-8 encoder that works without relying on TextEncoder. */
function utf8Encode(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair.
      const next = input.charCodeAt(++i);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Splits a base64-encoded Stellar transaction XDR envelope into ordered
 * multipart URIs suitable for rendering as an animated QR code.
 *
 * Each returned string is a complete frame of the form
 * `ur:lumen-tx/<seq>-<total>/<checksum>/<payload>`. The frames must be
 * displayed in order (looping) so that an air-gapped device can scan and
 * reassemble them.
 *
 * @param xdr     The base64-encoded transaction envelope XDR.
 * @param options Optional framing controls. See {@link AirgapOptions}.
 * @returns An array of frame URIs, ordered by sequence number.
 *
 * @example
 * ```ts
 * const frames = encodeXdrToUrFrames(envelopeXdr);
 * // Render `frames` as an animated QR code loop.
 * ```
 */
export function encodeXdrToUrFrames(xdr: string, options: AirgapOptions = {}): string[] {
  if (typeof xdr !== 'string' || xdr.length === 0) {
    throw new Error('encodeXdrToUrFrames: xdr must be a non-empty string');
  }

  const fragmentSize = resolveFragmentSize(options);
  const checksum = crc32(xdr);
  const total = Math.max(1, Math.ceil(xdr.length / fragmentSize));
  const frames: string[] = [];

  for (let i = 0; i < total; i++) {
    const seq = i + 1;
    const payload = xdr.slice(i * fragmentSize, (i + 1) * fragmentSize);
    frames.push(`${UR_PREFIX}${seq}-${total}/${checksum}/${payload}`);
  }

  return frames;
}

/** Resolves the effective fragment size from the supplied options. */
function resolveFragmentSize(options: AirgapOptions): number {
  if (options.fragmentSize !== undefined) {
    if (!Number.isInteger(options.fragmentSize) || options.fragmentSize <= 0) {
      throw new Error('encodeXdrToUrFrames: fragmentSize must be a positive integer');
    }
    return options.fragmentSize;
  }

  if (options.maxFrameLength !== undefined) {
    if (!Number.isInteger(options.maxFrameLength) || options.maxFrameLength <= 0) {
      throw new Error('encodeXdrToUrFrames: maxFrameLength must be a positive integer');
    }
    const budget = options.maxFrameLength - FRAME_OVERHEAD;
    if (budget <= 0) {
      throw new Error(
        'encodeXdrToUrFrames: maxFrameLength is too small to hold frame metadata',
      );
    }
    return budget;
  }

  return DEFAULT_FRAGMENT_SIZE;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Reassembles and verifies a set of multipart frames produced by
 * {@link encodeXdrToUrFrames}.
 *
 * The frames may be supplied in any order (as they are scanned). This function
 * validates that:
 *   - every frame is a well-formed `ur:lumen-tx` URI,
 *   - all frames agree on the total count and checksum,
 *   - the sequence is complete (no missing or duplicate frames), and
 *   - the CRC32 of the reassembled payload matches the carried checksum.
 *
 * @param frames The scanned frame URIs.
 * @returns The reassembled base64 XDR envelope.
 * @throws If the frames are malformed, incomplete, inconsistent, or fail the
 *         checksum verification.
 */
export function decodeUrFrames(frames: string[]): string {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('decodeUrFrames: no frames provided');
  }

  const parsed: UrFrame[] = frames.map((frame, index) => parseFrame(frame, index));

  const total = parsed[0].total;
  const checksum = parsed[0].checksum;

  const bySeq = new Map<number, string>();
  for (const frame of parsed) {
    if (frame.total !== total) {
      throw new Error(
        `decodeUrFrames: inconsistent total count (expected ${total}, got ${frame.total})`,
      );
    }
    if (frame.checksum !== checksum) {
      throw new Error('decodeUrFrames: inconsistent checksum across frames');
    }
    if (bySeq.has(frame.seq)) {
      throw new Error(`decodeUrFrames: duplicate frame for sequence ${frame.seq}`);
    }
    bySeq.set(frame.seq, frame.payload);
  }

  if (bySeq.size !== total) {
    const missing: number[] = [];
    for (let seq = 1; seq <= total; seq++) {
      if (!bySeq.has(seq)) missing.push(seq);
    }
    throw new Error(
      `decodeUrFrames: incomplete sequence, missing frame(s): ${missing.join(', ')}`,
    );
  }

  let payload = '';
  for (let seq = 1; seq <= total; seq++) {
    payload += bySeq.get(seq) as string;
  }

  const actual = crc32(payload);
  if (actual !== checksum) {
    throw new Error(
      `decodeUrFrames: checksum mismatch (expected ${checksum}, got ${actual})`,
    );
  }

  return payload;
}

/** Parses a single frame URI into its components. */
function parseFrame(frame: string, index: number): UrFrame {
  if (typeof frame !== 'string' || !frame.startsWith(UR_PREFIX)) {
    throw new Error(`decodeUrFrames: frame ${index} is not a valid lumen-tx URI`);
  }

  const rest = frame.slice(UR_PREFIX.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash === -1) {
    throw new Error(`decodeUrFrames: frame ${index} is missing metadata`);
  }

  const meta = rest.slice(0, firstSlash);
  const remainder = rest.slice(firstSlash + 1);

  const secondSlash = remainder.indexOf('/');
  if (secondSlash === -1) {
    throw new Error(`decodeUrFrames: frame ${index} is missing checksum`);
  }

  const checksum = remainder.slice(0, secondSlash);
  const payload = remainder.slice(secondSlash + 1);

  const metaParts = meta.split('-');
  if (metaParts.length !== 2) {
    throw new Error(`decodeUrFrames: frame ${index} has malformed sequence metadata`);
  }

  const seq = Number(metaParts[0]);
  const total = Number(metaParts[1]);

  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`decodeUrFrames: frame ${index} has invalid sequence number`);
  }
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`decodeUrFrames: frame ${index} has invalid total count`);
  }
  if (seq > total) {
    throw new Error(`decodeUrFrames: frame ${index} sequence exceeds total`);
  }
  if (!/^[0-9a-f]{8}$/.test(checksum)) {
    throw new Error(`decodeUrFrames: frame ${index} has invalid checksum format`);
  }

  return { seq, total, checksum, payload };
}