import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { register as sharedRegister } from '../metrics.js';

/**
 * Registry used for all canary metrics.
 *
 * We prefer the shared application registry so that the canary metrics are
 * exposed alongside the rest of the server metrics. If the shared registry is
 * unavailable for any reason we fall back to a dedicated registry so the
 * canary daemon can still record and expose its own metrics.
 */
const canaryRegister: Registry = sharedRegister ?? new Registry();

/**
 * End-to-end confirmation latency of the synthetic canary transaction,
 * measured in seconds from submission to confirmed inclusion.
 *
 * Buckets are tuned for the seconds-to-minutes range since a gasless
 * payment on Stellar typically confirms in a few seconds, but network
 * congestion or Horizon issues can push it into the tens of seconds or
 * minutes.
 */
export const canaryConfirmationLatencySeconds = new Histogram({
  name: 'lumen_canary_confirmation_latency_seconds',
  help: 'End-to-end confirmation latency of the synthetic canary transaction in seconds',
  labelNames: ['status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600],
  registers: [canaryRegister],
});

/**
 * Total number of canary runs, labeled by their outcome.
 *
 * `status` is one of:
 *  - `success`: the canary transaction was confirmed within the timeout.
 *  - `failure`: the canary transaction failed (submission error, rejected, etc.).
 *  - `timeout`: the canary transaction was not confirmed before the timeout.
 */
export const canaryRunsTotal = new Counter({
  name: 'lumen_canary_runs_total',
  help: 'Total number of synthetic canary runs by status',
  labelNames: ['status'] as const,
  registers: [canaryRegister],
});

/**
 * Current number of consecutive canary failures (including timeouts).
 *
 * Reset to zero on the next successful run. Used to drive alerting once the
 * configured failure threshold is reached.
 */
export const canaryConsecutiveFailures = new Gauge({
  name: 'lumen_canary_consecutive_failures',
  help: 'Current number of consecutive canary failures',
  registers: [canaryRegister],
});

/**
 * Total number of alerts emitted by the canary daemon.
 */
export const canaryAlertsTotal = new Counter({
  name: 'lumen_canary_alerts_total',
  help: 'Total number of alerts emitted by the canary daemon',
  registers: [canaryRegister],
});

/**
 * Convenience type describing the possible canary run outcomes.
 */
export type CanaryRunStatus = 'success' | 'failure' | 'timeout';

/**
 * Record the outcome of a single canary run.
 *
 * @param status The outcome of the run.
 * @param latencySeconds The end-to-end confirmation latency in seconds.
 *   Only recorded for successful runs; failures and timeouts do not have a
 *   meaningful confirmation latency.
 */
export function recordCanaryRun(status: CanaryRunStatus, latencySeconds?: number): void {
  canaryRunsTotal.inc({ status });

  if (status === 'success' && typeof latencySeconds === 'number' && Number.isFinite(latencySeconds)) {
    canaryConfirmationLatencySeconds.observe({ status }, latencySeconds);
  }
}

/**
 * Update the consecutive failure gauge.
 *
 * @param count The current number of consecutive failures.
 */
export function setConsecutiveFailures(count: number): void {
  canaryConsecutiveFailures.set(count);
}

/**
 * Increment the alert counter.
 */
export function recordCanaryAlert(): void {
  canaryAlertsTotal.inc();
}

export { canaryRegister };