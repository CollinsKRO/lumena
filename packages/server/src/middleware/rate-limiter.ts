import type { NextFunction, Request, Response } from "express";
import type Redis from "ioredis";

/**
 * Sliding-window token bucket rate limiter backed by Redis.
 *
 * Implements a token bucket algorithm atomically via a Lua script. Each bucket
 * has a capacity (burst limit) and a steady-state refill rate (tokens/second).
 * Bursts up to the capacity succeed immediately; sustained traffic is throttled
 * to the refill rate.
 *
 * See issue #244.
 */

export interface BucketConfig {
  /** Maximum number of tokens (burst capacity). */
  capacity: number;
  /** Tokens refilled per second (steady-state rate). */
  refillRate: number;
}

export interface TokenBucketRateLimiterOptions {
  /** ioredis client. When omitted, the limiter falls back to pass-through. */
  redis?: Redis | null;
  /** Bucket configuration applied per client IP. */
  ip?: BucketConfig;
  /** Bucket configuration applied per wallet address. */
  wallet?: BucketConfig;
  /** Optional key prefix for Redis keys. */
  keyPrefix?: string;
  /**
   * Extracts the wallet address from the request. Defaults to reading
   * `walletAddress` or `walletId` from the request body.
   */
  keyExtractor?: (req: Request) => string | undefined | null;
  /** Optional callback invoked when Redis errors occur. */
  onError?: (err: unknown) => void;
}

export interface TokenBucketResult {
  /** Whether a token was successfully consumed. */
  allowed: boolean;
  /** Tokens remaining in the bucket after the operation. */
  remaining: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfter: number;
}

const DEFAULT_IP_BUCKET: BucketConfig = { capacity: 60, refillRate: 10 };
const DEFAULT_WALLET_BUCKET: BucketConfig = { capacity: 30, refillRate: 5 };
const DEFAULT_KEY_PREFIX = "ratelimit:tb";

/**
 * Lua script implementing an atomic token bucket.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = capacity (max tokens)
 * ARGV[2] = refill rate (tokens per second)
 * ARGV[3] = current timestamp in milliseconds
 * ARGV[4] = tokens to consume (usually 1)
 *
 * Returns: { allowed (0|1), remaining (integer), retryAfterMs (integer) }
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

if capacity <= 0 then
  return { 0, 0, 0 }
end

local data = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(data[1])
local lastMs = tonumber(data[2])

if tokens == nil then
  tokens = capacity
end
if lastMs == nil then
  lastMs = nowMs
end

-- Refill based on elapsed time.
local elapsedMs = nowMs - lastMs
if elapsedMs < 0 then
  elapsedMs = 0
end
local refill = (elapsedMs / 1000.0) * refillRate
if refill > 0 then
  tokens = math.min(capacity, tokens + refill)
end

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  if refillRate > 0 then
    retryAfterMs = math.ceil((deficit / refillRate) * 1000.0)
  else
    retryAfterMs = 1000
  end
end

-- Persist state. Expire the key once the bucket would be full again.
redis.call('HMSET', key, 'tokens', tostring(tokens), 'timestamp', tostring(nowMs))

local ttlMs = 0
if refillRate > 0 then
  ttlMs = math.ceil((capacity / refillRate) * 1000.0)
end
if ttlMs < 1000 then
  ttlMs = 1000
end
redis.call('PEXPIRE', key, ttlMs)

return { allowed, math.floor(tokens), retryAfterMs }
`;

type TokenBucketRedis = Redis & {
  tokenBucketConsume?: (
    key: string,
    capacity: number,
    refillRate: number,
    nowMs: number,
    cost: number,
  ) => Promise<[number, number, number]>;
};

function defineScript(redis: Redis): TokenBucketRedis {
  const client = redis as TokenBucketRedis;
  if (typeof client.tokenBucketConsume !== "function") {
    client.defineCommand("tokenBucketConsume", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }
  return client;
}

function defaultKeyExtractor(req: Request): string | undefined {
  const body = (req as Request & { body?: Record<string, unknown> }).body;
  if (body && typeof body === "object") {
    const walletAddress = body.walletAddress;
    if (typeof walletAddress === "string" && walletAddress.length > 0) {
      return walletAddress;
    }
    const walletId = body.walletId;
    if (typeof walletId === "string" && walletId.length > 0) {
      return walletId;
    }
  }
  return undefined;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0]?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

async function consume(
  client: TokenBucketRedis,
  key: string,
  config: BucketConfig,
): Promise<TokenBucketResult> {
  const nowMs = Date.now();
  const raw = await client.tokenBucketConsume!(
    key,
    config.capacity,
    config.refillRate,
    nowMs,
    1,
  );
  const allowed = Number(raw[0]) === 1;
  const remaining = Number(raw[1]);
  const retryAfterMs = Number(raw[2]);
  return {
    allowed,
    remaining,
    retryAfter: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

/**
 * Creates an Express middleware implementing a Redis-backed token bucket rate
 * limiter. Applies a per-IP bucket and, when a wallet address is present, a
 * per-wallet bucket. If either bucket is exhausted, responds with 429.
 *
 * When no Redis client is provided, the middleware passes through so existing
 * tests that do not configure Redis continue to work.
 */
export function createTokenBucketRateLimiter(
  opts: TokenBucketRateLimiterOptions = {},
) {
  const ipConfig = opts.ip ?? DEFAULT_IP_BUCKET;
  const walletConfig = opts.wallet ?? DEFAULT_WALLET_BUCKET;
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const extractWallet = opts.keyExtractor ?? defaultKeyExtractor;
  const onError = opts.onError;

  const client = opts.redis ? defineScript(opts.redis) : null;

  return async function tokenBucketRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Graceful fallback: no Redis configured -> pass through.
    if (!client) {
      next();
      return;
    }

    try {
      const ip = getClientIp(req);
      const ipKey = `${keyPrefix}:ip:${ip}`;
      const ipResult = await consume(client, ipKey, ipConfig);

      if (!ipResult.allowed) {
        sendTooManyRequests(res, ipResult.retryAfter);
        return;
      }

      const wallet = extractWallet(req);
      if (wallet) {
        const walletKey = `${keyPrefix}:wallet:${wallet}`;
        const walletResult = await consume(client, walletKey, walletConfig);
        if (!walletResult.allowed) {
          sendTooManyRequests(res, walletResult.retryAfter);
          return;
        }
      }

      next();
    } catch (err) {
      if (onError) {
        onError(err);
      }
      // Fail open on Redis errors to avoid taking down the API.
      next();
    }
  };
}

function sendTooManyRequests(res: Response, retryAfter: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  if (typeof res.setHeader === "function") {
    res.setHeader("Retry-After", String(seconds));
  }
  res.status(429).json({ error: "Too Many Requests" });
}

export default createTokenBucketRateLimiter;