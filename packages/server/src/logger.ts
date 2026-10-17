import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // In production, avoid leaking internal details (stack traces, raw values)
  // into logs that may be surfaced to clients. Structured logging keeps
  // internal diagnostics server-side only.
  redact: {
    paths: [
      'err.stack',
      'error.stack',
      'stack',
      'txHash',
      'transactionHash',
      'hash',
      '*.txHash',
      '*.transactionHash',
      '*.hash',
    ],
    remove: true,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }),
});

/**
 * Sanitize an error message for safe inclusion in API responses.
 *
 * In production, internal details such as stack traces and raw Stellar
 * transaction hashes must never be returned to clients. Internal details
 * are logged via Pino instead.
 */
export function sanitizeErrorMessage(
  error: unknown,
  fallback = 'An unexpected error occurred',
): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

  if (isProduction) {
    // Log the full internal detail server-side, return a generic message.
    logger.error({ err: error }, 'Internal error sanitized for API response');
    return fallback;
  }

  return message;
}

/**
 * Strip stack traces from an error object before it is serialized into an
 * API response. In production the stack is removed entirely; in other
 * environments it is preserved for debugging.
 */
export function sanitizeError(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: sanitizeErrorMessage(error),
  };

  if (!isProduction && error instanceof Error && error.stack) {
    base.stack = error.stack;
  }

  return base;
}

/**
 * Structured audit-log entry for RBAC access decisions.
 *
 * Records who attempted what, on which route, and whether it was allowed.
 * Sensitive fields (transaction hashes, stack traces) remain redacted by the
 * logger configuration above.
 */
export interface AuditLogEntry {
  /** Identifier of the authenticated actor (e.g. JWT `sub`). */
  actorId: string | null;
  /** Role carried by the actor's JWT claim. */
  role: string | null;
  /** Action being attempted, e.g. `policy:update`. */
  action: string;
  /** HTTP method and path of the attempted request. */
  route: string;
  /** Outcome of the permission check. */
  decision: 'allow' | 'deny';
  /** Optional reason for the decision (e.g. `insufficient_role`). */
  reason?: string;
  /** ISO-8601 timestamp of the access attempt. */
  timestamp?: string;
}

/**
 * Write a structured audit-log entry for an RBAC access decision.
 *
 * Allowed decisions are logged at `info`; denied decisions at `warn` so they
 * are easy to surface in alerting. The actor ID and timestamp are always
 * included.
 */
export function auditLog(entry: AuditLogEntry): void {
  const record = {
    audit: true,
    actorId: entry.actorId,
    role: entry.role,
    action: entry.action,
    route: entry.route,
    decision: entry.decision,
    ...(entry.reason ? { reason: entry.reason } : {}),
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };

  if (entry.decision === 'deny') {
    logger.warn(record, 'RBAC access denied');
  } else {
    logger.info(record, 'RBAC access granted');
  }
}
