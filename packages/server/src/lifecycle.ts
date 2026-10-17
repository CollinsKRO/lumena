import type { Server } from 'http';
import type { Redis } from 'ioredis';

/**
 * Graceful shutdown lifecycle coordinator.
 *
 * Intercepts SIGINT/SIGTERM, stops accepting new HTTP requests, drains
 * in-flight co-sign / submit operations within a grace period, closes
 * Redis and other resources, then exits the process.
 */

type DrainableRedis = Pick<Redis, 'quit' | 'disconnect'> | { quit?: () => Promise<unknown>; disconnect?: () => void };

export interface ShutdownOptions {
  /** HTTP server to stop accepting new connections. */
  server?: Server;
  /** Redis client (or compatible) to close during shutdown. */
  redis?: DrainableRedis;
  /** Grace period for draining in-flight operations, in milliseconds. */
  drainTimeoutMs?: number;
  /** Optional hook invoked after draining, before resources are closed. */
  onDrain?: () => void | Promise<void>;
}

interface InFlightEntry {
  promise: Promise<unknown>;
}

const inFlight = new Set<InFlightEntry>();

let shuttingDown = false;
let handlersRegistered = false;

/**
 * Register an in-flight operation so the shutdown coordinator can wait for it
 * to settle before exiting. Returns the wrapped promise.
 */
export function trackOperation<T>(fn: () => Promise<T> | T): Promise<T> {
  const entry: InFlightEntry = { promise: Promise.resolve() };
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(entry);
    }
  })();
  entry.promise = promise;
  inFlight.add(entry);
  return promise;
}

/** Number of currently tracked in-flight operations. */
export function inFlightCount(): number {
  return inFlight.size;
}

/** Whether a shutdown has been initiated. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // `close` stops accepting new connections and invokes the callback once
    // all existing connections have ended. We resolve regardless of error.
    server.close(() => resolve());
    // Ensure keep-alive sockets don't block shutdown indefinitely.
    if (typeof (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections === 'function') {
      (server as unknown as { closeIdleConnections: () => void }).closeIdleConnections();
    }
  });
}

async function drainInFlight(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) {
    return true;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  const drained = Promise.allSettled(Array.from(inFlight, (entry) => entry.promise)).then(() => true as const);

  try {
    return await Promise.race([drained, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function closeRedis(redis?: DrainableRedis): Promise<void> {
  if (!redis) {
    return;
  }
  try {
    if (typeof redis.quit === 'function') {
      await redis.quit();
    } else if (typeof redis.disconnect === 'function') {
      redis.disconnect();
    }
  } catch {
    // Fall back to a hard disconnect if a graceful quit fails.
    try {
      if (typeof redis.disconnect === 'function') {
        redis.disconnect();
      }
    } catch {
      // Ignore errors during shutdown.
    }
  }
}

async function shutdown(options: ShutdownOptions): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  const { server, redis, drainTimeoutMs = 15000, onDrain } = options;

  try {
    // 1. Stop accepting new HTTP requests.
    if (server) {
      await closeServer(server);
    }

    // 2. Drain in-flight operations within the grace period.
    const drained = await drainInFlight(drainTimeoutMs);

    if (!drained) {
      // Timeout: close what we can and exit with a failure code.
      await closeRedis(redis);
      process.exit(1);
      return;
    }

    // 3. Run optional drain hook.
    if (onDrain) {
      await onDrain();
    }

    // 4. Close Redis and other resources.
    await closeRedis(redis);

    // 5. Clean exit.
    process.exit(0);
  } catch {
    try {
      await closeRedis(redis);
    } catch {
      // Ignore.
    }
    process.exit(1);
  }
}

/**
 * Register SIGINT/SIGTERM handlers that trigger a graceful shutdown.
 */
export function registerShutdownHandlers(options: ShutdownOptions): void {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[lifecycle] received ${signal}, starting graceful shutdown`);
    void shutdown(options);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}