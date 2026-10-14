import { log } from '@hubium/log';
import { type DiagLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { RedactingExporter } from './redact.ts';

// Traces of web requests, background jobs and CLI commands, exported over OTLP (http/proto)
// to a collector (Jaeger, Tempo, the OpenTelemetry Collector…). Nothing is set up, and every
// span is a no-op, unless OTEL_EXPORTER_OTLP_ENDPOINT (or …_TRACES_ENDPOINT) is set.
//
//   OTEL_EXPORTER_OTLP_ENDPOINT   collector base URL, e.g. http://otel-collector:4318
//   OTEL_EXPORTER_OTLP_HEADERS    e.g. "authorization=Bearer …" for a hosted backend
//   OTEL_TRACES_SAMPLER_ARG       share of new traces to keep, 0…1 (default 1); a sampled
//                                 parent (a traced caller) is always followed
//   OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLER  as the spec says
//
// Only W3C trace context is propagated (no baggage): into job payloads through pg-boss,
// and from incoming requests that carry `traceparent`. Tokens and query strings in URLs
// are removed from spans before export.

const logger = log('telemetry');
let provider: NodeTracerProvider | undefined;

export interface TelemetryOptions {
  /** service.name: web, worker, worker-media, migrate or cli (OTEL_SERVICE_NAME wins). */
  service: string;
  /** Spans for outgoing fetch/undici requests (the web app gets them from Next.js). */
  fetch?: boolean;
  /** Where spans go instead of OTLP (tests). */
  exporter?: SpanExporter;
  env?: NodeJS.ProcessEnv;
}

/** Is an OTLP endpoint configured? */
export function telemetryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === 'true') return false;
  return !!(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

const diagLogger: DiagLogger = {
  error: (msg, ...args) => logger.error({ args }, msg),
  warn: (msg, ...args) => logger.warn({ args }, msg),
  info: (msg, ...args) => logger.info({ args }, msg),
  debug: (msg, ...args) => logger.debug({ args }, msg),
  verbose: (msg, ...args) => logger.trace({ args }, msg),
};

/**
 * Registers the tracer provider, the W3C propagator and the Prisma (and undici)
 * instrumentations. Returns false, doing nothing, when no endpoint is configured. Call it
 * before the first database query; calling it again does nothing.
 */
export function startTelemetry(opts: TelemetryOptions): boolean {
  const env = opts.env ?? process.env;
  if (provider) return true;
  if (!opts.exporter && !telemetryConfigured(env)) return false;
  diag.setLogger(diagLogger, DiagLogLevel.WARN);
  const ratio = env.OTEL_TRACES_SAMPLER_ARG ? Number(env.OTEL_TRACES_SAMPLER_ARG) : 1;
  provider = new NodeTracerProvider({
    // defaults (telemetry.sdk.*), then ours, then OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME
    resource: defaultResource()
      .merge(
        resourceFromAttributes({
          [ATTR_SERVICE_NAME]: opts.service,
          'service.namespace': 'hubium',
          [ATTR_SERVICE_VERSION]: env.HUBIUM_VERSION || '0.0.0',
        }),
      )
      .merge(detectResources({ detectors: [envDetector] })),
    // OTEL_TRACES_SAMPLER, when set, is read by the SDK itself
    ...(env.OTEL_TRACES_SAMPLER
      ? {}
      : {
          sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(ratio >= 0 && ratio <= 1 ? ratio : 1),
          }),
        }),
    // URLs lose their tokens and query strings before they leave (see redact.ts)
    spanProcessors: [
      new BatchSpanProcessor(new RedactingExporter(opts.exporter ?? new OTLPTraceExporter())),
    ],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new PrismaInstrumentation(),
      ...(opts.fetch ? [new UndiciInstrumentation()] : []),
    ],
  });
  logger.info(
    {
      endpoint: opts.exporter
        ? undefined
        : env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    'tracing on',
  );
  return true;
}

/** Sends the spans still buffered and stops; for process exit. */
export async function shutdownTelemetry(): Promise<void> {
  const p = provider;
  provider = undefined;
  await p?.shutdown().catch((err) => logger.warn({ err }, 'could not flush the last spans'));
}
