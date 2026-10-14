import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@hubium/log';
import { propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { afterAll, describe, expect, it } from 'vitest';
import { shutdownTelemetry, startTelemetry, telemetryConfigured } from './index.ts';

describe('telemetry', () => {
  const received: { path: string; type: string; body: Buffer }[] = [];
  // a stand-in OTLP/HTTP collector
  const collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        type: String(req.headers['content-type']),
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  afterAll(() => collector.close());

  it('stays off without an OTLP endpoint', () => {
    expect(telemetryConfigured({})).toBe(false);
    expect(telemetryConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })).toBe(true);
    expect(
      telemetryConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318',
        OTEL_SDK_DISABLED: 'true',
      }),
    ).toBe(false);
    expect(startTelemetry({ service: 'web', env: {} })).toBe(false);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('exports spans over OTLP and puts their ids in the logs', async () => {
    collector.listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const { port } = collector.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/traces`;
    expect(
      startTelemetry({
        service: 'worker',
        env: { HUBIUM_VERSION: '9.9.9' },
        exporter: new OTLPTraceExporter({ url }),
      }),
    ).toBe(true);

    const lines: Record<string, string>[] = [];
    const logger = createLogger({ write: (l: string) => lines.push(JSON.parse(l)) });
    const tracer = trace.getTracer('test');
    const traceId = tracer.startActiveSpan('email.send', (span) => {
      logger.info('inside');
      span.end();
      return span.spanContext().traceId;
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({ msg: 'inside', trace_id: traceId, trace_flags: '01' });
    expect(lines[0]!.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[1]).not.toHaveProperty('trace_id');

    // URLs reach the collector without tokens, query strings or the paths of other services
    tracer
      .startSpan('GET /c/[token]/[...path]', {
        kind: SpanKind.SERVER,
        attributes: { 'http.target': '/c/s3cr3tcontent/index.html?attempt=7' },
      })
      .end();
    tracer
      .startSpan('POST', {
        kind: SpanKind.CLIENT,
        attributes: { 'url.full': 'https://hooks.example.org/services/T1/B2/hooksecret?x=1' },
      })
      .end();

    // only W3C trace context travels (into jobs and outgoing requests), no baggage
    const carrier: Record<string, string> = {};
    tracer.startActiveSpan('enqueue', (span) => {
      propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
      span.end();
    });
    expect(Object.keys(carrier)).toEqual(['traceparent']);

    await shutdownTelemetry();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toMatchObject({ path: '/v1/traces', type: 'application/x-protobuf' });
    const body = Buffer.concat(received.map((r) => r.body));
    for (const s of ['email.send', 'service.name', 'worker', 'hubium', '9.9.9'])
      expect(body.includes(s)).toBe(true);
    expect(body.includes(Buffer.from(traceId, 'hex'))).toBe(true);
    expect(body.includes('/c/[redacted]/index.html?[redacted]')).toBe(true);
    expect(body.includes('https://hooks.example.org')).toBe(true);
    for (const secret of ['s3cr3tcontent', 'attempt=7', 'hooksecret', '/services/'])
      expect(body.includes(secret)).toBe(false);
  });
});
