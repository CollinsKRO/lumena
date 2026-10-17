import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "../errors.js";

export type Role = "admin" | "operator" | "auditor";

export interface AuthUser {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface AuthMiddlewareOpts {
  apiKey?: string;
  jwtSecret?: string;
}

interface JwtPayload {
  sub?: string;
  id?: string;
  role?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(["admin", "operator", "auditor"]);

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64");
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify an HS256 JWT and return its decoded payload, or null if invalid.
 */
function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }

  if (!header || header.alg !== "HS256") {
    return null;
  }

  const expectedSig = base64UrlEncode(
    createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest(),
  );

  if (!safeEqual(expectedSig, signatureB64)) {
    return null;
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) {
    return null;
  }
  if (typeof payload.nbf === "number" && now < payload.nbf) {
    return null;
  }

  return payload;
}

function extractUser(payload: JwtPayload): AuthUser | null {
  const id = typeof payload.sub === "string" ? payload.sub : typeof payload.id === "string" ? payload.id : undefined;
  const role = typeof payload.role === "string" ? (payload.role as Role) : undefined;

  if (!id || !role || !VALID_ROLES.has(role)) {
    return null;
  }

  return { id, role };
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function apiKeyAuth(opts: AuthMiddlewareOpts = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const expectedKey = opts.apiKey || process.env.LUMEN_API_KEY;
    const jwtSecret = opts.jwtSecret || process.env.LUMEN_JWT_SECRET;

    const headerKey = req.headers["x-api-key"] as string | undefined;
    const authHeader = req.headers.authorization;
    const bearerKey =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : undefined;

    // Attempt JWT verification when a bearer token is present and a secret is configured.
    if (bearerKey && jwtSecret && looksLikeJwt(bearerKey)) {
      const payload = verifyJwt(bearerKey, jwtSecret);
      if (payload) {
        const user = extractUser(payload);
        if (user) {
          req.user = user;
          return next();
        }
      }
      // Invalid JWT: fall through to API-key checks (if any) or reject below.
    }

    // If no API key configured in server environment/options, pass through
    if (!expectedKey) {
      return next();
    }

    const providedKey = headerKey || bearerKey;

    if (!providedKey || providedKey !== expectedKey) {
      return next(
        new ValidationError("Unauthorized: Invalid or missing API key", undefined, 401),
      );
    }

    next();
  };
}