import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { cleanTarget, redactAttributes } from './redact.ts';

describe('span redaction', () => {
  it('replaces token segments and query strings in request targets', () => {
    expect(cleanTarget('/c/abc.def/scorm/index.html')).toBe('/c/[redacted]/scorm/index.html');
    expect(cleanTarget('/unsubscribe/tok123')).toBe('/unsubscribe/[redacted]');
    expect(cleanTarget('/api/calendar/ical/feedtok?x=1')).toBe(
      '/api/calendar/ical/[redacted]?[redacted]',
    );
    expect(cleanTarget('/api/v1/courses/42?userId=7')).toBe('/api/v1/courses/42?[redacted]');
    expect(cleanTarget('/dashboard')).toBe('/dashboard');
  });

  it('keeps only the origin of calls to other services', () => {
    const a = redactAttributes(
      {
        'url.full': 'https://hooks.example.org/services/T/B/secret?sig=1',
        'url.path': '/services/T/B/secret',
        'url.query': 'sig=1',
        'http.response.status_code': 200,
      },
      SpanKind.CLIENT,
    );
    expect(a).toEqual({
      'url.full': 'https://hooks.example.org',
      'url.path': '[redacted]',
      'url.query': '[redacted]',
      'http.response.status_code': 200,
    });
    const server = redactAttributes(
      { 'http.url': 'https://lms.example.org/c/tok/x?y=1', 'next.route': '/c/[token]/[...path]' },
      SpanKind.SERVER,
    );
    expect(server).toEqual({
      'http.url': 'https://lms.example.org/c/[redacted]/x?[redacted]',
      'next.route': '/c/[token]/[...path]',
    });
    const clean = { 'http.route': '/api/v1/me', 'http.target': '/api/v1/me' };
    expect(redactAttributes(clean, SpanKind.SERVER)).toBe(clean);
  });
});
