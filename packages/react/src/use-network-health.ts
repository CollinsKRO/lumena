import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Overall network health as reported by {@link useNetworkHealth}.
 *
 * - `healthy`   — the RPC responded within the latency budget.
 * - `degraded`  — the RPC responded, but too slowly to be trusted.
 * - `offline`   — the RPC could not be reached at all.
 */
export type NetworkHealthStatus = 'healthy' | 'degraded' | 'offline';

/** Result of a single network probe. */
export interface NetworkHealthPing {
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs: number;
  /** Latest ledger number reported by the RPC, or 0 when unknown. */
  ledgerNumber: number;
}

export interface UseNetworkHealthOptions {
  /**
   * Poll interval in milliseconds. Defaults to 15000 (15s).
   * Set to 0 to disable polling (the probe still runs once on mount).
   */
  pollInterval?: number;
  /** Stellar RPC endpoint used by the default probe. */
  rpcUrl?: string;
  /** Optional fetch implementation override (useful for tests). */
  fetcher?: typeof fetch;
  /** Optional probe override (useful for tests). */
  ping?: () => Promise<NetworkHealthPing>;
}

export interface UseNetworkHealthResult {
  /** Current network health. */
  status: NetworkHealthStatus;
  /** Latency of the most recent probe, in milliseconds. */
  latencyMs: number;
  /** Ledger number reported by the most recent probe. */
  ledgerNumber: number;
  /** Error raised by the most recent failed probe. */
  error: Error | null;
  /** Runs a probe immediately. */
  refetch: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL = 15_000;

/** Default Stellar RPC endpoint used when none is configured. */
export const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

/**
 * Latency above which the network is reported as degraded rather than
 * healthy. A wallet that cannot reach the ledger within this budget should
 * surface a failover prompt to the user.
 */
export const DEGRADED_LATENCY_THRESHOLD_MS = 2500;

/**
 * Probe the Stellar RPC for the latest ledger and measure the round-trip
 * time.
 */
async function defaultPing(
  rpcUrl: string,
  fetcher: typeof fetch,
): Promise<NetworkHealthPing> {
  const doFetch = fetcher ?? fetch;
  const started = Date.now();

  const response = await doFetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestLedger',
      params: {},
    }),
  });

  const latencyMs = Date.now() - started;

  if (!response.ok) {
    throw new Error(
      `Network health probe failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    result?: { sequence?: number; ledger?: number };
  };

  return {
    latencyMs,
    ledgerNumber: payload?.result?.sequence ?? payload?.result?.ledger ?? 0,
  };
}

/**
 * Monitor the health of the Stellar network used by the wallet.
 *
 * The hook probes the RPC on mount and then on a timer, reporting the
 * latency of the probe and the latest ledger number. Applications can use
 * `status` to surface a failover prompt when the network becomes degraded or
 * offline.
 */
export function useNetworkHealth(
  options: UseNetworkHealthOptions = {},
): UseNetworkHealthResult {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    rpcUrl = DEFAULT_RPC_URL,
    fetcher,
    ping,
  } = options;

  const [status, setStatus] = useState<NetworkHealthStatus>('offline');
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [ledgerNumber, setLedgerNumber] = useState<number>(0);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);

  const probe = useCallback(async () => {
    try {
      const result = ping
        ? await ping()
        : await defaultPing(rpcUrl, fetcher ?? fetch);

      if (!mountedRef.current) return;

      setLatencyMs(result.latencyMs);
      setLedgerNumber(result.ledgerNumber);
      setStatus(
        result.latencyMs > DEGRADED_LATENCY_THRESHOLD_MS ? 'degraded' : 'healthy',
      );
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;

      setStatus('offline');
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [ping, rpcUrl, fetcher]);

  useEffect(() => {
    mountedRef.current = true;

    void probe();

    if (pollInterval <= 0) {
      return () => {
        mountedRef.current = false;
      };
    }

    const timer = setInterval(() => {
      void probe();
    }, pollInterval);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [probe, pollInterval]);

  return { status, latencyMs, ledgerNumber, error, refetch: probe };
}
