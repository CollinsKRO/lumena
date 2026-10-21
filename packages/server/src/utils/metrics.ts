/**
 * Metrics facade used by the Stellar failover router.
 *
 * The router only needs a narrow set of operations, so this module wraps the
 * prom-client collectors defined in `src/metrics.ts` behind a small, stable
 * API. Keeping the mapping here means the collectors themselves stay in one
 * place and the router does not need to know their label names.
 */
import {
  stellarEndpointHealthy,
  stellarEndpointLatencyMs,
  stellarEndpointRequestsTotal,
  stellarHealthyEndpoints,
  stellarTotalEndpoints,
} from "../metrics.js";

export const metrics = {
  /** Record the last observed latency for a Stellar endpoint. */
  observeStellarEndpointLatency(endpoint: string, latencyMs: number): void {
    stellarEndpointLatencyMs.set({ endpoint }, latencyMs);
  },

  /** Count a failed health probe against a Stellar endpoint. */
  incrementStellarEndpointProbeFailure(endpoint: string): void {
    stellarEndpointRequestsTotal.inc({ endpoint, status: "probe_failure" });
  },

  /** Count a request that was successfully routed to a Stellar endpoint. */
  incrementStellarRequest(endpoint: string): void {
    stellarEndpointRequestsTotal.inc({ endpoint, status: "success" });
  },

  /** Count a request that failed against a Stellar endpoint. */
  incrementStellarRequestFailure(endpoint: string): void {
    stellarEndpointRequestsTotal.inc({ endpoint, status: "failure" });
  },

  /** Count a failover to a different Stellar endpoint. */
  incrementStellarFailover(): void {
    stellarEndpointRequestsTotal.inc({ endpoint: "failover", status: "failover" });
  },

  /** Publish how many Stellar endpoints are currently healthy. */
  setStellarHealthyEndpoints(count: number): void {
    stellarHealthyEndpoints.set(count);
  },

  /** Publish how many Stellar endpoints are configured in total. */
  setStellarTotalEndpoints(count: number): void {
    stellarTotalEndpoints.set(count);
  },

  /** Publish the health status of a single Stellar endpoint. */
  setStellarEndpointHealthy(endpoint: string, healthy: boolean): void {
    stellarEndpointHealthy.set({ endpoint }, healthy ? 1 : 0);
  },
};
