import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * Granular Role-Based Access Control (RBAC) middleware.
 *
 * Roles:
 *  - auditor  : read-only access (GET routes)
 *  - operator : policy updates (POST/PUT on /policy) plus read access
 *  - admin    : full access
 *
 * Every access attempt (allowed or denied) is recorded in a structured
 * audit log entry containing the actor ID, role, HTTP method, path,
 * decision, and an ISO timestamp.
 */

export type Role = 'admin' | 'operator' | 'auditor';

export interface AuthClaims {
  sub: string;
  role: Role;
  [key: string]: unknown;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthClaims;
}

/**
 * Permission actions understood by the RBAC layer.
 */
export type PermissionAction =
  | 'read'
  | 'policy:update'
  | 'webhooks:update'
  | 'wallets:read'
  | 'admin';

const VALID_ROLES: Role[] = ['admin', 'operator', 'auditor'];

/**
 * Permission map: which actions each role is allowed to perform.
 * Least-privilege by default — anything not listed is denied.
 */
export const ROLE_PERMISSIONS: Record<Role, PermissionAction[]> = {
  auditor: ['read', 'wallets:read'],
  operator: ['read', 'wallets:read', 'policy:update'],
  admin: ['read', 'wallets:read', 'policy:update', 'webhooks:update', 'admin'],
};

/**
 * Resolve the permission action implied by an HTTP method + path.
 */
export function resolveAction(method: string, path: string): PermissionAction {
  const upperMethod = method.toUpperCase();
  const normalizedPath = path.split('?')[0].replace(/\/+$/, '') || '/';

  if (upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS') {
    if (normalizedPath.startsWith('/wallets')) {
      return 'wallets:read';
    }
    return 'read';
  }

  if (normalizedPath.startsWith('/policy')) {
    return 'policy:update';
  }

  if (normalizedPath.startsWith('/webhooks')) {
    return 'webhooks:update';
  }

  // Any other mutating route requires full admin access.
  return 'admin';
}

/**
 * Base64url-decode a JWT segment into a UTF-8 string.
 */
function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64').toString('utf8');
}

/**
 * Verify an HS256 JWT signature if a secret is configured.
 * Returns true when the token is valid or when no secret is configured.
 */
function verifySignature(token: string, secret: string | undefined): boolean {
  if (!secret) {
    return true;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    return false;
  }

  if (header.alg !== 'HS256') {
    // Only HS256 is supported for local verification.
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const provided = signatureB64.replace(/=+$/, '');

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Extract and validate JWT claims from the Authorization bearer token.
 * Returns null when the token is missing, malformed, or invalid.
 */
export function parseClaims(req: Request): AuthClaims | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  const secret = process.env.JWT_SECRET;

  if (!verifySignature(token, secret)) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }

  const sub = payload.sub;
  const role = payload.role;

  if (typeof sub !== 'string' || sub.length === 0) {
    return null;
  }

  if (typeof role !== 'string' || !VALID_ROLES.includes(role as Role)) {
    return null;
  }

  // Reject expired tokens when an exp claim is present.
  if (typeof payload.exp === 'number') {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp < nowSeconds) {
      return null;
    }
  }

  return { ...payload, sub, role: role as Role };
}

/**
 * Base64url-encode a string into a JWT segment.
 */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mint an HS256 JWT carrying the given role claims.
 *
 * This is the counterpart of {@link parseClaims}: it is used by tests and by
 * tooling that needs to authenticate against the admin API.
 */
export function signRoleToken(
  claims: { sub: string; role: Role } & Record<string, unknown>,
  secret: string,
  expiresInSeconds = 3600,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { ...claims, iat: issuedAt, exp: issuedAt + expiresInSeconds };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Emit a structured audit log entry for an access attempt.
 */
function audit(
  req: Request,
  claims: AuthClaims | null,
  decision: 'allowed' | 'denied',
  reason?: string,
): void {
  const entry = {
    type: 'rbac_audit',
    actorId: claims?.sub ?? null,
    role: claims?.role ?? null,
    method: req.method,
    path: req.originalUrl || req.url,
    decision,
    timestamp: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };

  if (decision === 'denied') {
    logger.warn(entry, 'RBAC access denied');
  } else {
    logger.info(entry, 'RBAC access allowed');
  }
}

/**
 * Middleware factory: require the authenticated user to hold one of the
 * given roles. Returns 403 Forbidden on denial.
 */
export function requireRole(...roles: Role[]) {
  const allowed = new Set<Role>(roles);

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const claims = parseClaims(req);

    if (!claims) {
      audit(req, null, 'denied', 'missing_or_invalid_token');
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    req.user = claims;

    if (!allowed.has(claims.role)) {
      audit(req, claims, 'denied', 'insufficient_role');
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    audit(req, claims, 'allowed');
    next();
  };
}

/**
 * Middleware factory: require the authenticated user to hold a specific
 * permission action. Returns 403 Forbidden on denial.
 */
export function requirePermission(action: PermissionAction) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const claims = parseClaims(req);

    if (!claims) {
      audit(req, null, 'denied', 'missing_or_invalid_token');
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    req.user = claims;

    const permissions = ROLE_PERMISSIONS[claims.role] ?? [];
    if (!permissions.includes(action)) {
      audit(req, claims, 'denied', `missing_permission:${action}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    audit(req, claims, 'allowed');
    next();
  };
}

/**
 * Convenience middleware that derives the required permission from the
 * request method and path, then enforces it.
 */
export function enforceRoutePermission() {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const action = resolveAction(req.method, req.path || req.url);
    return requirePermission(action)(req, res, next);
  };
}

export default {
  requireRole,
  requirePermission,
  enforceRoutePermission,
  parseClaims,
  resolveAction,
  ROLE_PERMISSIONS,
};