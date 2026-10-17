export { CanaryDaemon } from './daemon.js';
export type { CanaryDaemonOptions } from './daemon.js';
export {
  canaryMetrics,
  recordCanarySuccess,
  recordCanaryFailure,
  getCanaryMetrics,
} from './metrics.js';
export type { CanaryMetrics } from './metrics.js';