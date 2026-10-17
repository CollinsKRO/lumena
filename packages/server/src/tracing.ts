import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { CompositePropagator, W3CBaggagePropagator } from '@opentelemetry/core';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

let sdk: NodeSDK | undefined;
let started = false;

/**
 * Resolve the OTLP endpoint from the environment.
 * Falls back to the standard local collector address.
 */
function resolveOtlpEndpoint(): string {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint && endpoint.trim().length > 0) {
    return endpoint.trim();
  }
  return 'http://localhost:4318';
}

/**
 * Build the OTLP trace exporter URL. The OTLP HTTP exporter expects the full
 * signal path (e.g. `/v1/traces`). If the configured endpoint already includes
 * a path, respect it; otherwise append the default traces path.
 */
function resolveTracesUrl(): string {
  const base = resolveOtlpEndpoint().replace(/\/+$/, '');
  if (/\/v1\/traces$/.test(base)) {
    return base;
  }
  return `${base}/v1/traces`;
}

function resolveServiceName(): string {
  const name = process.env.OTEL_SERVICE_NAME;
  if (name && name.trim().length > 0) {
    return name.trim();
  }
  return 'lumen-server';
}

function resolveServiceVersion(): string {
  return (
    process.env.OTEL_SERVICE_VERSION ||
    process.env.npm_package_version ||
    '0.0.0'
  );
}

function resolveEnvironment(): string {
  return process.env.NODE_ENV || process.env.OTEL_DEPLOYMENT_ENVIRONMENT || 'development';
}

/**
 * Initialize OpenTelemetry distributed tracing for the Lumen server.
 *
 * Instruments HTTP (incoming Express requests), Redis (ioredis), and outgoing
 * HTTP clients (undici / fetch) so that trace context propagates from incoming
 * request headers through Redis policy checks and out to Stellar RPC / Horizon
 * calls via W3C `traceparent` headers.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function startTracing(): NodeSDK | undefined {
  if (started) {
    return sdk;
  }
  started = true;

  // Enable diagnostic logging only when explicitly requested.
  if (process.env.OTEL_LOG_LEVEL) {
    const level =
      (DiagLogLevel as unknown as Record<string, DiagLogLevel>)[
        process.env.OTEL_LOG_LEVEL.toUpperCase()
      ] ?? DiagLogLevel.INFO;
    diag.setLogger(new DiagConsoleLogger(), level);
  }

  const traceExporter = new OTLPTraceExporter({
    url: resolveTracesUrl(),
    headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  });

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: resolveServiceName(),
    [SEMRESATTRS_SERVICE_VERSION]: resolveServiceVersion(),
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: resolveEnvironment(),
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    // W3C traceparent + baggage propagation for distributed context.
    textMapPropagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // HTTP instrumentation propagates traceparent on outgoing requests
        // (including Stellar RPC / Horizon) and extracts it from incoming ones.
        '@opentelemetry/instrumentation-http': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-ioredis': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-undici': {
          enabled: true,
        },
        // Reduce noise from filesystem instrumentation.
        '@opentelemetry/instrumentation-fs': {
          enabled: false,
        },
      }),
    ],
  });

  sdk.start();

  // Gracefully flush and shut down the SDK on process termination.
  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[tracing] Error shutting down OpenTelemetry SDK', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return sdk;
}

/**
 * Parse the OTEL_EXPORTER_OTLP_HEADERS env var (comma-separated key=value pairs)
 * into a headers object.
 */
function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key.length > 0) {
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export default startTracing;