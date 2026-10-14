import { isSpanContextValid, trace } from '@opentelemetry/api';
import { type DestinationStream, type Logger, pino } from 'pino';

// One logger for every process. Production writes one JSON object per line to stdout
// (for `docker compose logs`, Loki, Elastic…); development prints readable lines.
//
//   LOG_LEVEL       trace | debug | info (default) | warn | error | fatal | silent
//   LOG_FORMAT      json | pretty (default: json when NODE_ENV=production)
//   HUBIUM_SERVICE  service name on every line: web (default), worker, worker-media, cli
//
// Records carry `component` and fields, never secrets: common secret fields are redacted.
// Inside a traced request or job (see @hubium/telemetry) they also carry trace_id, span_id
// and trace_flags, so a log line leads to its trace and back.

export type { Logger };

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};
const COLORS: Record<string, string> = {
  TRACE: '90',
  DEBUG: '36',
  INFO: '32',
  WARN: '33',
  ERROR: '31',
  FATAL: '35',
};

/** Fields every record has; the rest are printed as key=value after the message. */
const FRAME = new Set([
  'level',
  'time',
  'service',
  'component',
  'msg',
  'pid',
  'hostname',
  'trace_id',
  'span_id',
  'trace_flags',
]);

/** The active span's ids, as the OpenTelemetry log data model names them. */
function traceFields(): Record<string, string> {
  const s = trace.getActiveSpan()?.spanContext();
  if (!s || !isSpanContextValid(s)) return {};
  return {
    trace_id: s.traceId,
    span_id: s.spanId,
    trace_flags: s.traceFlags.toString(16).padStart(2, '0'),
  };
}

/** "12:04:05.123 INFO  worker [webhooks] delivery failed status=503 url=…" */
export function formatPretty(line: string, color = false): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return line;
  }
  const level =
    typeof o.level === 'string' ? o.level.toUpperCase() : (LEVEL_NAMES[Number(o.level)] ?? 'INFO');
  const time = typeof o.time === 'string' ? o.time.slice(11, 23) : '';
  const paint = (code: string | undefined, s: string) =>
    color && code ? `\x1b[${code}m${s}\x1b[0m` : s;
  const err = o.err as { type?: string; message?: string; stack?: string } | undefined;
  const fields = Object.entries(o)
    .filter(([k]) => !FRAME.has(k) && k !== 'err')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const head = [
    paint('90', time),
    paint(COLORS[level], level.padEnd(5)),
    o.service ? paint('90', String(o.service)) : '',
    o.component ? `[${o.component}]` : '',
    String(o.msg ?? ''),
    fields.length ? paint('90', fields.join(' ')) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return err?.stack ? `${head}\n${paint('31', err.stack)}` : head;
}

function prettyDestination(): DestinationStream {
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  return {
    write(line: string) {
      process.stdout.write(`${formatPretty(line.trimEnd(), color)}\n`);
    },
  };
}

export const REDACTED_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  '*.headers.authorization',
  '*.headers.cookie',
  'cookie',
  '*.cookie',
];

/** A logger with the shared settings; `destination` lets tests capture the output. */
export function createLogger(destination?: DestinationStream): Logger {
  const format =
    process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: process.env.HUBIUM_SERVICE ?? 'web' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      mixin: traceFields,
    },
    destination ?? (format === 'pretty' ? prettyDestination() : undefined),
  );
}

export const logger: Logger = createLogger();

/** A child logger tagged with the part of the system it speaks for. */
export function log(component: string): Logger {
  return logger.child({ component });
}
