/**
 * Deep health diagnostics for Lumen.
 *
 * Provides `runDeepHealthCheck`, which concurrently probes each external
 * dependency (Redis, Horizon, KMS signer, sponsor account) with per-probe
 * timeouts and reports a component status map. Used by the `/health/deep`
 * endpoint to return 200 when everything is healthy or 503 when any
 * dependency is degraded.
 */

export type ComponentStatus = 'healthy' | string;

export interface DeepHealthResult {
  healthy: boolean;
  components: Record<string, ComponentStatus>;
  latencyMs: Record<string, number>;
}

/** Minimal Redis-like client surface used for the ping probe. */
export interface RedisProbeClient {
  ping?: () => Promise<unknown>;
  readinessCheck?: () => Promise<unknown>;
}

/** Minimal Horizon client surface used for the latency probe. */
export interface HorizonProbeClient {
  root: () => Promise<unknown>;
}

/** Minimal signer surface used for the KMS signing probe. */
export interface SignerProbe {
  sign: (data: Buffer) => Promise<unknown> | unknown;
}

/** Minimal sponsor/fee service surface used for the balance probe. */
export interface SponsorBalanceProbe {
  checkBalance: () => Promise<number | { balance?: number | string }> | number | { balance?: number | string };
}

export interface DeepHealthDeps {
  /** Redis client (or any object exposing `ping`/`readinessCheck`). */
  redis?: RedisProbeClient;
  /** Horizon client wrapper exposing `horizon.root()`. */
  client?: { horizon?: HorizonProbeClient };
  /** KMS signer used to verify signing works. */
  signer?: SignerProbe;
  /** Sponsor balance service (feeSponsorService / sponsorMonitorService). */
  feeSponsorService?: SponsorBalanceProbe;
  sponsorMonitorService?: SponsorBalanceProbe;
  /** Minimum acceptable sponsor balance. */
  minSponsorBalance?: number;
  /** Per-probe timeout in milliseconds (default 3000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Fixed 32-byte buffer used for the KMS signing probe. */
const SIGN_PROBE_BUFFER = Buffer.alloc(32, 0x01);

interface ProbeOutcome {
  status: ComponentStatus;
  latencyMs: number;
}

/**
 * Runs a single probe with a timeout. Any thrown error or timeout is captured
 * and converted into a failure status string rather than propagating.
 */
async function runProbe(
  probe: () => Promise<ComponentStatus>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<ComponentStatus>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const status = await Promise.race([probe(), timeout]);
    return { status, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'unreachable';
    return { status: message, latencyMs: Date.now() - start };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isBytes(value: unknown): boolean {
  return (
    value instanceof Uint8Array ||
    Buffer.isBuffer(value) ||
    (typeof value === 'object' &&
      value !== null &&
      'length' in value &&
      typeof (value as { length: unknown }).length === 'number' &&
      (value as { length: number }).length > 0)
  );
}

function extractBalance(value: number | { balance?: number | string }): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && value.balance !== undefined) {
    const parsed = typeof value.balance === 'string' ? Number(value.balance) : value.balance;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Concurrently probes all dependencies and returns a consolidated report.
 *
 * Each component reports `'healthy'` on success or a failure string such as
 * `'unreachable'`, `'degraded'`, or `'timeout'`.
 */
export async function runDeepHealthCheck(deps: DeepHealthDeps): Promise<DeepHealthResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const redisProbe = async (): Promise<ComponentStatus> => {
    const redis = deps.redis;
    if (!redis) return 'unreachable';
    if (typeof redis.ping === 'function') {
      const result = await redis.ping();
      return result === 'PONG' || result === true || result === 'OK' ? 'healthy' : 'degraded';
    }
    if (typeof redis.readinessCheck === 'function') {
      const result = await redis.readinessCheck();
      return result === false ? 'degraded' : 'healthy';
    }
    return 'unreachable';
  };

  const horizonProbe = async (): Promise<ComponentStatus> => {
    const horizon = deps.client?.horizon;
    if (!horizon || typeof horizon.root !== 'function') return 'unreachable';
    await horizon.root();
    return 'healthy';
  };

  const kmsProbe = async (): Promise<ComponentStatus> => {
    const signer = deps.signer;
    if (!signer || typeof signer.sign !== 'function') return 'unreachable';
    const signature = await signer.sign(SIGN_PROBE_BUFFER);
    return isBytes(signature) ? 'healthy' : 'degraded';
  };

  const sponsorProbe = async (): Promise<ComponentStatus> => {
    const service = deps.feeSponsorService ?? deps.sponsorMonitorService;
    if (!service || typeof service.checkBalance !== 'function') return 'unreachable';
    const raw = await service.checkBalance();
    const balance = extractBalance(raw);
    if (balance === null) return 'degraded';
    const min = deps.minSponsorBalance ?? 0;
    return balance >= min ? 'healthy' : 'degraded';
  };

  const [redis, horizon, kms, sponsor] = await Promise.all([
    runProbe(redisProbe, timeoutMs),
    runProbe(horizonProbe, timeoutMs),
    runProbe(kmsProbe, timeoutMs),
    runProbe(sponsorProbe, timeoutMs),
  ]);

  const components: Record<string, ComponentStatus> = {
    redis: redis.status,
    horizon: horizon.status,
    kms: kms.status,
    sponsor: sponsor.status,
  };

  const latencyMs: Record<string, number> = {
    redis: redis.latencyMs,
    horizon: horizon.latencyMs,
    kms: kms.latencyMs,
    sponsor: sponsor.latencyMs,
  };

  const healthy = Object.values(components).every((status) => status === 'healthy');

  return { healthy, components, latencyMs };
}