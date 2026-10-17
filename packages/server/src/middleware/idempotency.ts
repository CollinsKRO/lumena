import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash } from 'crypto';

/**
 * Minimal Redis client interface required by the idempotency middleware.
 * Compatible with `ioredis` and `redis` (v4+) clients.
 */
export interface IdempotencyRedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface IdempotencyOptions {
  /** Redis client used to persist idempotency records. */
  redis: IdempotencyRedisClient;
  /** Time-to-live for idempotency records, in seconds. Defaults to 24 hours. */
  ttlSeconds?: number;
  /** Header name carrying the idempotency key. Defaults to `Idempotency-Key`. */
  headerName?: string;
  /** Key prefix used in Redis. Defaults to `idempotency:`. */
  keyPrefix?: string;
  /** Poll interval (ms) while awaiting an in-flight request. Defaults to 100ms. */
  pollIntervalMs?: number;
  /** Maximum time (ms) to await an in-flight request before giving up. Defaults to 30s. */
  maxWaitMs?: number;
}

/** HTTP methods considered mutating and therefore eligible for idempotency. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const DEFAULT_HEADER_NAME = 'Idempotency-Key';
const DEFAULT_KEY_PREFIX = 'idempotency:';
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 30_000;

interface StoredRecord {
  state: 'in-progress' | 'completed';
  fingerprint: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  createdAt: number;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Headers that should not be replayed from a cached response, since they are
 * connection-specific or would otherwise confuse the client/proxy.
 */
const EXCLUDED_REPLAY_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
]);

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeFingerprint(req: Request): string {
  const method = req.method.toUpperCase();
  const path = req.originalUrl || req.url || req.path || '';
  const body = req.body !== undefined ? JSON.stringify(req.body) : '';
  return sha256(`${method}\n${path}\n${sha256(body)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRecord(raw: string | null): StoredRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredRecord;
    if (!parsed || typeof parsed !== 'object' || !parsed.state) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function replayResponse(res: Response, record: StoredRecord): void {
  if (typeof record.status === 'number') {
    res.status(record.status);
  }
  if (record.headers) {
    for (const [name, value] of Object.entries(record.headers)) {
      if (!EXCLUDED_REPLAY_HEADERS.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
  }
  res.setHeader('Idempotent-Replayed', 'true');
  if (record.body !== undefined) {
    res.send(record.body);
  } else {
    res.end();
  }
}

function sendConflict(res: Response): void {
  res.status(422).json({
    error: 'Idempotency key reuse with a different request payload',
    code: 'IDEMPOTENCY_KEY_MISMATCH',
  });
}

/**
 * Captures the response status, headers, and body written by the downstream
 * handler so they can be persisted and replayed for subsequent requests.
 */
function captureResponse(res: Response): { restore: () => void; get: () => CapturedResponse } {
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const chunks: Buffer[] = [];
  let captured = false;

  const collect = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) {
      return;
    }
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(String(chunk)));
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).write = function patchedWrite(
    chunk: any,
    encoding?: any,
    callback?: any
  ): boolean {
    collect(chunk);
    return originalWrite(chunk, encoding, callback);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = function patchedEnd(
    chunk?: any,
    encoding?: any,
    callback?: any
  ): Response {
    if (!captured) {
      captured = true;
      collect(chunk);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEnd as any)(chunk, encoding, callback);
  };

  const get = (): CapturedResponse => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.getHeaders())) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        headers[name] = value.join(', ');
      } else {
        headers[name] = String(value);
      }
    }
    return {
      status: res.statusCode,
      headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
  };

  const restore = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).write = originalWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).end = originalEnd;
  };

  return { restore, get };
}

/**
 * Creates an RFC 7231 `Idempotency-Key` middleware.
 *
 * - Reads the `Idempotency-Key` header on mutating requests; passes through if absent.
 * - Computes a request fingerprint (method + path + body hash).
 * - Persists an in-progress marker in Redis (`SET NX PX`) before executing the handler.
 * - Captures the response and persists a completed record with a 24h TTL.
 * - Concurrent requests with the same key await the in-flight execution (local
 *   promise map + Redis polling) and replay the cached response.
 * - Mismatched fingerprints for the same key return HTTP 422.
 */
export function idempotency(options: IdempotencyOptions): RequestHandler {
  const {
    redis,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    headerName = DEFAULT_HEADER_NAME,
    keyPrefix = DEFAULT_KEY_PREFIX,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
  } = options;

  if (!redis) {
    throw new Error('idempotency middleware requires a redis client');
  }

  const ttlMs = ttlSeconds * 1000;
  const lowerHeaderName = headerName.toLowerCase();

  // Tracks in-flight executions within this process so concurrent requests can
  // await the same promise instead of polling Redis.
  const inFlight = new Map<string, Promise<CapturedResponse | null>>();

  async function awaitInFlight(
    redisKey: string,
    fingerprint: string
  ): Promise<StoredRecord | null> {
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const record = parseRecord(await redis.get(redisKey));

      if (record) {
        if (record.fingerprint !== fingerprint) {
          return { state: 'completed', fingerprint, status: 422 } as StoredRecord;
        }
        if (record.state === 'completed') {
          return record;
        }
      } else {
        // The in-progress marker expired or was removed without a completed
        // record being written. Treat as available for re-execution.
        return null;
      }

      await sleep(pollIntervalMs);
    }

    return null;
  }

  return function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const method = req.method.toUpperCase();

    if (!MUTATING_METHODS.has(method)) {
      next();
      return;
    }

    const rawKey = req.headers[lowerHeaderName];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      next();
      return;
    }

    const redisKey = `${keyPrefix}${idempotencyKey}`;
    const fingerprint = computeFingerprint(req);

    const handle = async (): Promise<void> => {
      // Fast path: check for an existing record before attempting to lock.
      const existing = parseRecord(await redis.get(redisKey));
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          sendConflict(res);
          return;
        }
        if (existing.state === 'completed') {
          replayResponse(res, existing);
          return;
        }
        // In-progress record exists; fall through to await it.
      }

      // Try to acquire the lock / in-progress marker.
      const lockValue = JSON.stringify({
        state: 'in-progress',
        fingerprint,
        createdAt: Date.now(),
      } satisfies StoredRecord);

      const acquired = await redis.set(redisKey, lockValue, 'PX', ttlMs, 'NX');

      if (!acquired) {
        // Another request holds the lock. Await its completion.
        const pending = inFlight.get(redisKey);
        if (pending) {
          const result = await pending;
          if (result) {
            replayResponse(res, {
              state: 'completed',
              fingerprint,
              status: result.status,
              headers: result.headers,
              body: result.body,
              createdAt: Date.now(),
            });
            return;
          }
        }

        const record = await awaitInFlight(redisKey, fingerprint);
        if (record) {
          if (record.status === 422 && record.fingerprint === fingerprint && !record.headers) {
            sendConflict(res);
            return;
          }
          if (record.fingerprint !== fingerprint) {
            sendConflict(res);
            return;
          }
          replayResponse(res, record);
          return;
        }

        // Could not resolve the in-flight request; retry by executing.
        next();
        return;
      }

      // We own the lock. Execute the handler and capture the response.
      const execution = new Promise<CapturedResponse | null>((resolve) => {
        const capture = captureResponse(res);

        const finalize = async (): Promise<void> => {
          capture.restore();
          const captured = capture.get();
          try {
            const completed: StoredRecord = {
              state: 'completed',
              fingerprint,
              status: captured.status,
              headers: captured.headers,
              body: captured.body,
              createdAt: Date.now(),
            };
            await redis.set(redisKey, JSON.stringify(completed), 'PX', ttlMs);
          } catch {
            // Persisting the completed record failed; best-effort cleanup so
            // the key is not stuck in-progress.
            try {
              await redis.del(redisKey);
            } catch {
              /* ignore */
            }
          } finally {
            inFlight.delete(redisKey);
          }
          resolve(captured);
        };

        res.once('finish', () => {
          void finalize();
        });
        res.once('close', () => {
          // Client disconnected before finish; still attempt to finalize so
          // the lock is released.
          if (!res.writableEnded) {
            void finalize();
          }
        });

        try {
          next();
        } catch (err) {
          capture.restore();
          inFlight.delete(redisKey);
          void redis.del(redisKey).catch(() => undefined);
          resolve(null);
          next(err);
        }
      });

      inFlight.set(redisKey, execution);
      await execution;
    };

    handle().catch((err) => {
      // Ensure the lock is released on unexpected errors.
      inFlight.delete(redisKey);
      void redis.del(redisKey).catch(() => undefined);
      next(err);
    });
  };
}

export default idempotency;