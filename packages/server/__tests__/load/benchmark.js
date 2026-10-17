import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// ---------------------------------------------------------------------------
// Configuration (overridable via environment variables)
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = parseInt(__ENV.VUS || '250', 10);
const DURATION = __ENV.DURATION || '1m';
const RAMP_UP = __ENV.RAMP_UP || '30s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '15s';
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '250', 10);
const P95_THRESHOLD_MS = parseFloat(__ENV.P95_THRESHOLD_MS || '150');

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const cosignLatency = new Trend('cosign_latency', true);
const feeBumpLatency = new Trend('fee_bump_latency', true);
const healthLatency = new Trend('health_latency', true);

const cosignRequests = new Counter('cosign_requests_total');
const feeBumpRequests = new Counter('fee_bump_requests_total');
const healthRequests = new Counter('health_requests_total');

const cosignSuccess = new Rate('cosign_success_rate');
const feeBumpSuccess = new Rate('fee_bump_success_rate');
const healthSuccess = new Rate('health_success_rate');

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    // Sustained high-concurrency load against the three endpoints.
    sustained_load: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.floor(TARGET_RPS / 10)),
      timeUnit: '1s',
      preAllocatedVUs: VUS,
      maxVUs: VUS * 2,
      stages: [
        { target: TARGET_RPS, duration: RAMP_UP },
        { target: TARGET_RPS, duration: DURATION },
        { target: 0, duration: RAMP_DOWN },
      ],
    },
  },
  thresholds: {
    // Acceptance criteria: p95 < 150ms at 250 requests/second.
    'http_req_duration{scenario:sustained_load}': [
      `p(95)<${P95_THRESHOLD_MS}`,
    ],
    'http_req_duration{endpoint:cosign}': [`p(95)<${P95_THRESHOLD_MS}`],
    'http_req_duration{endpoint:fee-bump}': [`p(95)<${P95_THRESHOLD_MS}`],
    'http_req_duration{endpoint:health}': [`p(95)<${P95_THRESHOLD_MS}`],
    cosign_latency: [`p(50)<${P95_THRESHOLD_MS}`, `p(95)<${P95_THRESHOLD_MS}`, `p(99)<${P95_THRESHOLD_MS * 2}`],
    fee_bump_latency: [`p(50)<${P95_THRESHOLD_MS}`, `p(95)<${P95_THRESHOLD_MS}`, `p(99)<${P95_THRESHOLD_MS * 2}`],
    health_latency: [`p(50)<${P95_THRESHOLD_MS}`, `p(95)<${P95_THRESHOLD_MS}`, `p(99)<${P95_THRESHOLD_MS * 2}`],
    cosign_success_rate: ['rate>0.99'],
    fee_bump_success_rate: ['rate>0.99'],
    health_success_rate: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildCosignPayload() {
  return JSON.stringify({
    transaction: randomString(64),
    signature: randomString(128),
    publicKey: randomString(56),
  });
}

function buildFeeBumpPayload() {
  return JSON.stringify({
    transaction: randomString(64),
    feeSource: randomString(56),
    baseFee: '100',
    maxFee: '1000',
  });
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Default function
// ---------------------------------------------------------------------------
export default function () {
  group('health', function () {
    const res = http.get(`${BASE_URL}/health`, {
      tags: { endpoint: 'health' },
    });
    healthLatency.add(res.timings.duration);
    healthRequests.add(1);
    const ok = check(res, {
      'health status is 200': (r) => r.status === 200,
    });
    healthSuccess.add(ok);
  });

  group('cosign', function () {
    const res = http.post(`${BASE_URL}/cosign`, buildCosignPayload(), {
      headers: jsonHeaders(),
      tags: { endpoint: 'cosign' },
    });
    cosignLatency.add(res.timings.duration);
    cosignRequests.add(1);
    const ok = check(res, {
      'cosign status is 2xx': (r) => r.status >= 200 && r.status < 300,
    });
    cosignSuccess.add(ok);
  });

  group('fee-bump', function () {
    const res = http.post(`${BASE_URL}/fee-bump`, buildFeeBumpPayload(), {
      headers: jsonHeaders(),
      tags: { endpoint: 'fee-bump' },
    });
    feeBumpLatency.add(res.timings.duration);
    feeBumpRequests.add(1);
    const ok = check(res, {
      'fee-bump status is 2xx': (r) => r.status >= 200 && r.status < 300,
    });
    feeBumpSuccess.add(ok);
  });

  // Small jitter to avoid perfectly synchronized bursts across VUs.
  sleep(Math.random() * 0.05);
}

// ---------------------------------------------------------------------------
// Summary / reporting
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const metrics = data.metrics || {};

  function pick(metricName, stat) {
    const m = metrics[metricName];
    if (!m || !m.values) return null;
    return m.values[stat];
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    targetRps: TARGET_RPS,
    p95ThresholdMs: P95_THRESHOLD_MS,
    latency: {
      cosign: {
        p50: pick('cosign_latency', 'p(50)'),
        p95: pick('cosign_latency', 'p(95)'),
        p99: pick('cosign_latency', 'p(99)'),
      },
      feeBump: {
        p50: pick('fee_bump_latency', 'p(50)'),
        p95: pick('fee_bump_latency', 'p(95)'),
        p99: pick('fee_bump_latency', 'p(99)'),
      },
      health: {
        p50: pick('health_latency', 'p(50)'),
        p95: pick('health_latency', 'p(95)'),
        p99: pick('health_latency', 'p(99)'),
      },
    },
    throughput: {
      cosign: pick('cosign_requests_total', 'count'),
      feeBump: pick('fee_bump_requests_total', 'count'),
      health: pick('health_requests_total', 'count'),
      httpReqsPerSecond: pick('http_reqs', 'rate'),
    },
    successRates: {
      cosign: pick('cosign_success_rate', 'rate'),
      feeBump: pick('fee_bump_success_rate', 'rate'),
      health: pick('health_success_rate', 'rate'),
    },
  };

  // Human-readable text summary to stdout.
  const text = [
    '',
    '=== Lumen Load Benchmark Summary ===',
    `Base URL:        ${BASE_URL}`,
    `Target RPS:      ${TARGET_RPS}`,
    `p95 threshold:   ${P95_THRESHOLD_MS}ms`,
    '',
    'Latency (ms):',
    `  /cosign    p50=${fmt(summary.latency.cosign.p50)}  p95=${fmt(summary.latency.cosign.p95)}  p99=${fmt(summary.latency.cosign.p99)}`,
    `  /fee-bump  p50=${fmt(summary.latency.feeBump.p50)}  p95=${fmt(summary.latency.feeBump.p95)}  p99=${fmt(summary.latency.feeBump.p99)}`,
    `  /health    p50=${fmt(summary.latency.health.p50)}  p95=${fmt(summary.latency.health.p95)}  p99=${fmt(summary.latency.health.p99)}`,
    '',
    'Throughput (total requests):',
    `  /cosign    ${fmt(summary.throughput.cosign)}`,
    `  /fee-bump  ${fmt(summary.throughput.feeBump)}`,
    `  /health    ${fmt(summary.throughput.health)}`,
    `  overall    ${fmt(summary.throughput.httpReqsPerSecond)} req/s`,
    '',
    'Success rates:',
    `  /cosign    ${fmtRate(summary.successRates.cosign)}`,
    `  /fee-bump  ${fmtRate(summary.successRates.feeBump)}`,
    `  /health    ${fmtRate(summary.successRates.health)}`,
    '',
  ].join('\n');

  const out = {
    stdout: text,
  };

  // Optional JSON export for chart generation.
  if (__ENV.SUMMARY_JSON) {
    out[__ENV.SUMMARY_JSON] = JSON.stringify(summary, null, 2);
  }

  return out;
}

function fmt(value) {
  if (value === null || value === undefined) return 'n/a';
  return Number(value).toFixed(2);
}

function fmtRate(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${(Number(value) * 100).toFixed(2)}%`;
}