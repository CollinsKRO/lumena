import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ScValType, ScValInput } from "@lumen/types";

/**
 * Converts a JavaScript value or ContractArg into a Stellar Soroban xdr.ScVal.
 */
export function toScVal(input: ScValInput, explicitType?: ScValType): xdr.ScVal {
  if (input instanceof xdr.ScVal) {
    return input;
  }

  let value = input;
  let type = explicitType;

  if (
    input &&
    typeof input === "object" &&
    "value" in input &&
    ("type" in input || !explicitType)
  ) {
    value = input.value;
    type = explicitType ?? input.type;
  }

  if (type) {
    switch (type) {
      case "address":
        return new Address(value.toString()).toScVal();
      case "symbol":
        return xdr.ScVal.scvSymbol(value.toString());
      case "string":
        return xdr.ScVal.scvString(value.toString());
      case "bool":
        return xdr.ScVal.scvBool(Boolean(value));
      case "u32":
        return nativeToScVal(Number(value), { type: "u32" });
      case "i32":
        return nativeToScVal(Number(value), { type: "i32" });
      case "u64":
        return nativeToScVal(BigInt(value), { type: "u64" });
      case "i64":
        return nativeToScVal(BigInt(value), { type: "i64" });
      case "u128":
        return nativeToScVal(BigInt(value), { type: "u128" });
      case "i128":
        return nativeToScVal(BigInt(value), { type: "i128" });
      case "bytes": {
        const buf = Buffer.isBuffer(value)
          ? value
          : typeof value === "string"
            ? Buffer.from(value, "hex")
            : Buffer.from(value);
        return xdr.ScVal.scvBytes(buf);
      }
      case "bytes32": {
        const buf = toBytes32Buffer(value);
        return xdr.ScVal.scvBytes(buf);
      }
      case "timepoint":
        return nativeToScVal(BigInt(value), { type: "u64" });
      case "duration":
        return nativeToScVal(BigInt(value), { type: "u64" });
      case "price": {
        const price = normalizePrice(value);
        return xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("price"),
            val: nativeToScVal(price.price, { type: "i128" }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("timestamp"),
            val: nativeToScVal(price.timestamp, { type: "u64" }),
          }),
        ]);
      }
      default:
        return nativeToScVal(value);
    }
  }

  // Type inference
  if (typeof value === "boolean") {
    return xdr.ScVal.scvBool(value);
  }
  if (typeof value === "bigint") {
    return nativeToScVal(value, { type: "i128" });
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? nativeToScVal(value, { type: "i32" })
      : nativeToScVal(BigInt(Math.floor(value)), { type: "i128" });
  }
  if (typeof value === "string") {
    // Check if string is Stellar Account or Contract address (length 56, starts with G or C)
    if (value.length === 56 && (value.startsWith("G") || value.startsWith("C"))) {
      try {
        return new Address(value).toScVal();
      } catch {
        // Fallback to string
      }
    }
    return xdr.ScVal.scvString(value);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return xdr.ScVal.scvBytes(Buffer.from(value));
  }

  return nativeToScVal(value);
}

/**
 * Normalizes a value into a 32-byte Buffer for `BytesN<32>` arguments such as
 * contract wasm hashes (#222, #224).
 *
 * Accepts a hex string (with or without `0x` prefix), a Buffer, or a
 * Uint8Array. Throws if the resulting length is not exactly 32 bytes.
 */
export function toBytes32Buffer(value: unknown): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(value)) {
    buf = value;
  } else if (value instanceof Uint8Array) {
    buf = Buffer.from(value);
  } else if (typeof value === "string") {
    const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(`Invalid BytesN<32> hex string: ${value}`);
    }
    buf = Buffer.from(hex, "hex");
  } else {
    throw new Error(`Unsupported BytesN<32> value: ${String(value)}`);
  }

  if (buf.length !== 32) {
    throw new Error(`Expected 32 bytes for BytesN<32>, got ${buf.length}`);
  }
  return buf;
}

/**
 * Normalizes an oracle price struct (#223) into `{ price: bigint, timestamp: bigint }`.
 *
 * Accepts either an object with `price`/`timestamp` fields or a tuple
 * `[price, timestamp]`. The price is treated as a fixed-point i128 value.
 */
export function normalizePrice(value: unknown): { price: bigint; timestamp: bigint } {
  if (Array.isArray(value)) {
    if (value.length < 2) {
      throw new Error("Price tuple must contain [price, timestamp]");
    }
    return { price: BigInt(value[0] as any), timestamp: BigInt(value[1] as any) };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.price === undefined || obj.timestamp === undefined) {
      throw new Error("Price object must contain 'price' and 'timestamp' fields");
    }
    return { price: BigInt(obj.price as any), timestamp: BigInt(obj.timestamp as any) };
  }
  throw new Error(`Unsupported price value: ${String(value)}`);
}

/**
 * Converts a Soroban xdr.ScVal into its native JavaScript representation.
 *
 * Handles all common ScVal types explicitly so contract return values can be
 * decoded reliably:
 *  - scvAddress -> string (StrKey G.../C...)
 *  - scvMap     -> plain object (string keys) or Map for non-string keys
 *  - scvVec     -> array
 *  - scvBytes   -> Uint8Array
 *  - scvBool    -> boolean
 *  - scvSymbol  -> string
 *  - scvI128    -> bigint
 *  - scvU128    -> bigint
 */
export function fromScVal(scVal: any): any {
  if (scVal === null || scVal === undefined) return null;

  // Unwrap common result envelopes before decoding.
  if (scVal && !(scVal instanceof xdr.ScVal)) {
    if (scVal.retval) {
      return fromScVal(scVal.retval);
    }
    if (scVal.result?.retval) {
      return fromScVal(scVal.result.retval);
    }
  }

  if (!(scVal instanceof xdr.ScVal)) {
    return scVal;
  }

  switch (scVal.switch()) {
    case xdr.ScValType.scvAddress():
      return Address.fromScVal(scVal).toString();
    case xdr.ScValType.scvMap(): {
      const entries = scVal.map() ?? [];
      const result: Record<string, any> = {};
      let allStringKeys = true;
      const map = new Map<any, any>();
      for (const entry of entries) {
        const key = fromScVal(entry.key());
        const val = fromScVal(entry.val());
        map.set(key, val);
        if (typeof key === "string") {
          result[key] = val;
        } else {
          allStringKeys = false;
        }
      }
      return allStringKeys ? result : map;
    }
    case xdr.ScValType.scvVec():
      return (scVal.vec() ?? []).map((item) => fromScVal(item));
    case xdr.ScValType.scvBytes():
      return new Uint8Array(scVal.bytes());
    case xdr.ScValType.scvBool():
      return scVal.b();
    case xdr.ScValType.scvSymbol():
      return scVal.sym().toString();
    case xdr.ScValType.scvI128():
      return scVal.i128().toBigInt();
    case xdr.ScValType.scvU128():
      return scVal.u128().toBigInt();
    case xdr.ScValType.scvU64():
      return scVal.u64().toBigInt();
    case xdr.ScValType.scvI64():
      return scVal.i64().toBigInt();
    case xdr.ScValType.scvU32():
      return scVal.u32();
    case xdr.ScValType.scvI32():
      return scVal.i32();
    case xdr.ScValType.scvTimepoint():
      return scVal.timepoint().toBigInt();
    case xdr.ScValType.scvDuration():
      return scVal.duration().toBigInt();
    default:
      return scValToNative(scVal);
  }
}

/**
 * Decodes a `BytesN<32>` ScVal (e.g. a contract wasm hash) into a lowercase
 * hex string. Throws if the value is not exactly 32 bytes.
 */
export function fromBytes32ScVal(scVal: xdr.ScVal): string {
  if (scVal.switch() !== xdr.ScValType.scvBytes()) {
    throw new Error("Expected scvBytes for BytesN<32>");
  }
  const buf = Buffer.from(scVal.bytes());
  if (buf.length !== 32) {
    throw new Error(`Expected 32 bytes for BytesN<32>, got ${buf.length}`);
  }
  return buf.toString("hex");
}

/**
 * Decodes an oracle price struct ScVal (#223) into `{ price: bigint, timestamp: bigint }`.
 *
 * Accepts either an scvMap with `price`/`timestamp` symbol keys or an scvVec
 * tuple `[price, timestamp]`.
 */
export function fromPriceScVal(scVal: xdr.ScVal): { price: bigint; timestamp: bigint } {
  const decoded = fromScVal(scVal);
  if (decoded instanceof Map) {
    const price = decoded.get("price");
    const timestamp = decoded.get("timestamp");
    if (price === undefined || timestamp === undefined) {
      throw new Error("Price map missing 'price' or 'timestamp'");
    }
    return { price: BigInt(price), timestamp: BigInt(timestamp) };
  }
  if (Array.isArray(decoded)) {
    if (decoded.length < 2) {
      throw new Error("Price tuple must contain [price, timestamp]");
    }
    return { price: BigInt(decoded[0]), timestamp: BigInt(decoded[1]) };
  }
  if (decoded && typeof decoded === "object") {
    const obj = decoded as Record<string, unknown>;
    if (obj.price === undefined || obj.timestamp === undefined) {
      throw new Error("Price object missing 'price' or 'timestamp'");
    }
    return { price: BigInt(obj.price as any), timestamp: BigInt(obj.timestamp as any) };
  }
  throw new Error("Unsupported price ScVal");
}
