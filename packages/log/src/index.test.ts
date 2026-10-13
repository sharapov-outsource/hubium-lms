import { describe, expect, it } from 'vitest';
import { createLogger, formatPretty } from './index.ts';

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: { write: (l: string) => lines.push(JSON.parse(l)) },
  };
};

describe('logger', () => {
  it('writes one JSON record per line with service, component, level and fields', () => {
    const c = capture();
    const logger = createLogger(c.stream).child({ component: 'webhooks' });
    logger.warn({ deliveryId: 'd1', status: 503 }, 'delivery failed');
    expect(c.lines[0]).toMatchObject({
      level: 'warn',
      service: 'web',
      component: 'webhooks',
      deliveryId: 'd1',
      status: 503,
      msg: 'delivery failed',
    });
    expect(String(c.lines[0]!.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serialises errors with their stack and redacts secrets', () => {
    const c = capture();
    const logger = createLogger(c.stream);
    logger.error(
      { err: new Error('boom'), webhook: { secret: 'whsec_x', url: 'https://h' }, password: 'p' },
      'failed',
    );
    const r = c.lines[0] as {
      err: { message: string; stack: string };
      webhook: object;
      password: string;
    };
    expect(r.err.message).toBe('boom');
    expect(r.err.stack).toContain('Error: boom');
    expect(r.webhook).toEqual({ secret: '[redacted]', url: 'https://h' });
    expect(r.password).toBe('[redacted]');
  });

  it('prints readable lines for development', () => {
    const line = JSON.stringify({
      level: 'info',
      time: '2026-10-13T12:04:05.123Z',
      service: 'worker',
      component: 'jobs',
      msg: 'job done',
      job: 'email.send',
      ms: 12,
    });
    expect(formatPretty(line)).toBe(
      '12:04:05.123 INFO  worker [jobs] job done job=email.send ms=12',
    );
    expect(formatPretty('not json')).toBe('not json');
  });
});
