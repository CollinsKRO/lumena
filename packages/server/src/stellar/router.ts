import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

export type EndpointKind = 'horizon' | 'soroban';

export interface StellarEndpoint {
  url: string;
  kind: EndpointKind;
  region?: string;
}

export interface EndpointStatus {
  url: string;
  kind: EndpointKind;
  region?: string;
  healthy: boolean;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
}

export interface FailoverStellarClientOptions {
  endpoints?: StellarEndpoint[];
  network?: 'mainnet' | 'testnet' | 'futurenet';
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const NETWORK_PRESETS: Record<string, StellarEndpoint[]> = {
  mainnet: [
    { url: 'https://horizon.stellar.org', kind: 'horizon', region: 'global' },
    { url: 'https://horizon.stellar.lobstr.co', kind: 'horizon', region: 'global' },
    { url: 'https://soroban-rpc.mainnet.stellar.gateway.fm', kind: 'soroban', region: 'global' },
    { url: 'https://rpc.ankr.com/stellar_soroban', kind: 'soroban', region: 'global' },
  ],
  testnet: [
    { url: 'https://horizon-testnet.stellar.org', kind: 'horizon', region: 'global' },
    { url: 'https://soroban-testnet.stellar.org', kind: 'soroban', region: 'global' },
  ],
  futurenet: [
    { url: 'https://horizon-futurenet.stellar.org', kind: 'horizon', region: 'global' },
    { url: 'https://rpc-futurenet.stellar.org', kind: 'soroban', region: 'global' },
  ],
};

const DEFAULT_PROBE_INTERVAL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;

interface InternalEndpointState {
  endpoint: StellarEndpoint;
  healthy: boolean;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
}

export interface StellarRequestOptions {
  kind?: EndpointKind;
  method?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
  maxRetries?: number;
}

export class FailoverStellarClient {
  private readonly states: InternalEndpointState[];
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(opts: FailoverStellarClientOptions = {}) {
    const endpoints =
      opts.endpoints && opts.endpoints.length > 0
        ? opts.endpoints
        : NETWORK_PRESETS[opts.network ?? 'testnet'] ?? NETWORK_PRESETS.testnet;

    this.states = endpoints.map((endpoint) => ({
      endpoint,
      healthy: true,
      latencyMs: null,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      totalRequests: 0,
      totalFailures: 0,
    }));

    this.probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? fetch;

    this.updateGauges();
  }

  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => {
      void this.probeAll();
    }, this.probeIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
    logger.info('FailoverStellarClient started', {
      endpoints: this.states.length,
      probeIntervalMs: this.probeIntervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('FailoverStellarClient stopped');
  }

  getEndpointStatus(): EndpointStatus[] {
    return this.states.map((s) => ({
      url: s.endpoint.url,
      kind: s.endpoint.kind,
      region: s.endpoint.region,
      healthy: s.healthy,
      latencyMs: s.latencyMs,
      lastCheckedAt: s.lastCheckedAt,
      consecutiveFailures: s.consecutiveFailures,
      totalRequests: s.totalRequests,
      totalFailures: s.totalFailures,
    }));
  }

  async probeAll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      await Promise.all(this.states.map((s) => this.probeEndpoint(s)));
    } finally {
      this.probing = false;
      this.updateGauges();
    }
  }

  private async probeEndpoint(state: InternalEndpointState): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const probeUrl =
        state.endpoint.kind === 'horizon'
          ? `${state.endpoint.url.replace(/\/$/, '')}/`
          : state.endpoint.url;
      const res = await this.fetchImpl(probeUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const latency = Date.now() - started;
      state.latencyMs = latency;
      state.lastCheckedAt = Date.now();
      if (res.ok || res.status === 404 || res.status === 405) {
        state.healthy = true;
        state.consecutiveFailures = 0;
        metrics.observeStellarEndpointLatency(state.endpoint.url, latency);
      } else {
        state.healthy = false;
        state.consecutiveFailures += 1;
        metrics.incrementStellarEndpointProbeFailure(state.endpoint.url);
        logger.warn('Stellar endpoint probe returned non-OK status', {
          url: state.endpoint.url,
          status: res.status,
        });
      }
    } catch (err) {
      state.lastCheckedAt = Date.now();
      state.healthy = false;
      state.consecutiveFailures += 1;
      metrics.incrementStellarEndpointProbeFailure(state.endpoint.url);
      logger.warn('Stellar endpoint probe failed', {
        url: state.endpoint.url,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private updateGauges(): void {
    const healthy = this.states.filter((s) => s.healthy).length;
    metrics.setStellarHealthyEndpoints(healthy);
    metrics.setStellarTotalEndpoints(this.states.length);
  }

  private rankCandidates(kind?: EndpointKind): InternalEndpointState[] {
    const pool = kind ? this.states.filter((s) => s.endpoint.kind === kind) : this.states.slice();
    return pool.sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      const aLat = a.latencyMs ?? Number.POSITIVE_INFINITY;
      const bLat = b.latencyMs ?? Number.POSITIVE_INFINITY;
      if (aLat !== bLat) return aLat - bLat;
      return a.consecutiveFailures - b.consecutiveFailures;
    });
  }

  async request<T = unknown>(options: StellarRequestOptions = {}): Promise<T> {
    const candidates = this.rankCandidates(options.kind);
    if (candidates.length === 0) {
      throw new Error('No Stellar endpoints configured');
    }

    const maxRetries = options.maxRetries ?? this.maxRetries;
    const attempts = Math.min(candidates.length, Math.max(1, maxRetries));
    let lastError: unknown = null;

    for (let i = 0; i < attempts; i++) {
      const state = candidates[i];
      const url = this.buildUrl(state, options);
      state.totalRequests += 1;
      metrics.incrementStellarRequest(state.endpoint.url);
      try {
        const res = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers: {
            accept: 'application/json',
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(options.headers ?? {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        if (!res.ok) {
          throw new Error(`Stellar endpoint ${state.endpoint.url} responded ${res.status}`);
        }

        state.healthy = true;
        state.consecutiveFailures = 0;
        const data = (await res.json()) as T;
        return data;
      } catch (err) {
        lastError = err;
        state.totalFailures += 1;
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= 2) {
          state.healthy = false;
        }
        metrics.incrementStellarRequestFailure(state.endpoint.url);
        metrics.incrementStellarFailover();
        logger.warn('Stellar request failed, attempting failover', {
          url: state.endpoint.url,
          attempt: i + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.updateGauges();
    throw lastError instanceof Error
      ? lastError
      : new Error('All Stellar endpoints failed');
  }

  private buildUrl(state: InternalEndpointState, options: StellarRequestOptions): string {
    const base = state.endpoint.url.replace(/\/$/, '');
    const path = options.path ?? '';
    if (!path) return base;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

export default FailoverStellarClient;