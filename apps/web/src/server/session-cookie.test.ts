import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sessionToken } from './session-cookie';

const secret = 's'.repeat(40);
const signed = (token: string, key = secret) =>
  encodeURIComponent(`${token}.${createHmac('sha256', key).update(token).digest('base64')}`);

describe('session cookie', () => {
  it('gives the token of a cookie Better Auth signed, and nothing for one it did not', () => {
    const cookie = (value: string) => [{ name: '__Secure-hubium.session_token', value }];
    expect(sessionToken(cookie(signed('abc123')), secret)).toBe('abc123');
    // a token copied without its signature, or signed with another key
    expect(sessionToken(cookie('abc123'), secret)).toBeNull();
    expect(sessionToken(cookie('abc123.forged'), secret)).toBeNull();
    expect(sessionToken(cookie(signed('abc123', 'x'.repeat(40))), secret)).toBeNull();
    expect(sessionToken([{ name: 'other', value: signed('abc123') }], secret)).toBeNull();
  });
});
