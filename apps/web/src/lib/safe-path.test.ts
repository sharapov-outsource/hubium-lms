import { describe, expect, it } from 'vitest';
import { isSafePath, safePath } from './safe-path';

describe('redirect targets', () => {
  it('accepts same-site paths', () => {
    for (const p of ['/', '/dashboard', '/course/1?edit=1#a-2', '/a/b%2F%2Fc'])
      expect(isSafePath(p), p).toBe(true);
  });

  it('refuses other sites in all their spellings', () => {
    for (const p of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/ /evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/ok\\..\\x',
      '',
      null,
      undefined,
    ])
      expect(isSafePath(p), String(p)).toBe(false);
    expect(safePath('//evil', '/home')).toBe('/home');
  });
});
