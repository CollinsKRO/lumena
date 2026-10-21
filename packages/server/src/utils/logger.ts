/**
 * Re-export of the canonical logger module.
 *
 * Several modules (the Stellar failover router, the RBAC and error-handling
 * middleware) import the logger through `../utils/logger`, while the logger
 * itself lives at `src/logger.ts`. This module keeps both import paths
 * pointing at the same singleton so log configuration is applied once.
 */
export { logger, httpLogger, auditLog, sanitizeError, sanitizeErrorMessage } from "../logger.js";
export type { AuditLogEntry } from "../logger.js";
