import { type Attributes, SpanKind } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

// URLs in spans can carry secrets: signed content links, unsubscribe and calendar-feed
// tokens in paths (as Caddy's access log, these are replaced), anything in query strings,
// and webhook URLs whose path is the secret. Spans are cleaned before they leave the process.

/** Path segments that are tokens: /c/<token>/…, /unsubscribe/<token>, …/ical/<token>. */
const TOKEN_SEGMENT = /(\/(?:c|unsubscribe|ical)\/)[^/?#]+/g;

/** A request target without tokens or query values: "/c/[redacted]/index.html?[redacted]". */
export function cleanTarget(target: string): string {
  const q = target.search(/[?#]/);
  const path = (q < 0 ? target : target.slice(0, q)).replace(TOKEN_SEGMENT, '$1[redacted]');
  return q < 0 ? path : `${path}?[redacted]`;
}

function cleanUrl(value: string, outgoing: boolean): string {
  try {
    const u = new URL(value);
    // calls to other services: their path may be the secret (webhooks), so the origin only
    return outgoing ? u.origin : `${u.origin}${cleanTarget(u.pathname + u.search)}`;
  } catch {
    return outgoing ? '[redacted]' : cleanTarget(value);
  }
}

/** The span's attributes with URLs cleaned, or the same object when nothing changed. */
export function redactAttributes(attributes: Attributes, kind: SpanKind): Attributes {
  const outgoing = kind === SpanKind.CLIENT || kind === SpanKind.PRODUCER;
  let out: Attributes | undefined;
  const set = (key: string, value: string) => {
    if (attributes[key] === value) return;
    out ??= { ...attributes };
    out[key] = value;
  };
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue;
    if (key === 'url.full' || key === 'http.url') set(key, cleanUrl(value, outgoing));
    else if (key === 'http.target' || key === 'url.path')
      set(key, outgoing ? '[redacted]' : cleanTarget(value));
    else if (key === 'url.query') set(key, '[redacted]');
  }
  return out ?? attributes;
}

function redactSpan(span: ReadableSpan): ReadableSpan {
  const attributes = redactAttributes(span.attributes, span.kind);
  if (attributes === span.attributes) return span;
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Passes spans on to `inner` with their URLs cleaned. */
export class RedactingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), done);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
