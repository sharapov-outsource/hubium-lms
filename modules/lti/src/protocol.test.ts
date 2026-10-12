import { describe, expect, it } from 'vitest';
import { autoPostForm, parseCustom, readHint, seal, signHint, unseal } from './protocol.ts';

process.env.APP_SECRET ??= 'unit-test-secret-unit-test-secret-0000';

describe('LTI protocol helpers', () => {
  it('seals private keys with AES-GCM', () => {
    const s = seal('{"d":"secret"}');
    expect(s).not.toContain('secret');
    expect(unseal(s)).toBe('{"d":"secret"}');
    const [iv, tag, data] = s.split('.');
    expect(() => unseal([iv, tag, `${data}x`].join('.'))).toThrow();
  });
  it('signs hints and rejects tampering or expiry', () => {
    const h = signHint({ a: 'act', u: 'usr', t: 'tool', m: 'LtiResourceLinkRequest' });
    expect(readHint(h)).toMatchObject({ a: 'act', u: 'usr', t: 'tool' });
    expect(readHint(`${h}x`)).toBeNull();
    expect(
      readHint(signHint({ a: 'a', u: 'u', t: 't', m: 'LtiDeepLinkingRequest' }, -1)),
    ).toBeNull();
    expect(readHint(null)).toBeNull();
  });
  it('parses custom parameters', () => {
    expect(parseCustom('A=1\n bad line\nCourse_Code = X y \n')).toEqual({
      a: '1',
      course_code: 'X y',
    });
  });
  it('escapes auto-post forms', () => {
    const html = autoPostForm('https://t/"><x', { id_token: '"/><script>' });
    expect(html).not.toContain('"><x');
    expect(html).toContain('&quot;/&gt;&lt;script&gt;');
  });
});
