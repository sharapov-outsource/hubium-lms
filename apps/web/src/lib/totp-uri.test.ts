import { describe, expect, it } from 'vitest';
import { withIssuer } from './totp-uri';

describe('TOTP issuer', () => {
  const uri =
    'otpauth://totp/Hubium%20LMS:anna%40school.ru?secret=JBSWY3DPEHPK3PXP&issuer=Hubium%20LMS&digits=6&period=30';

  it('names the site as the issuer in the label and the parameter', () => {
    const out = withIssuer(uri, 'Школа №5');
    const u = new URL(out);
    expect(decodeURIComponent(u.pathname)).toBe('/Школа №5:anna@school.ru');
    expect(u.searchParams.get('issuer')).toBe('Школа №5');
    expect(u.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(out).not.toContain('+');
  });

  it('leaves other URIs and empty names alone', () => {
    expect(withIssuer('https://example.org/x', 'Школа')).toBe('https://example.org/x');
    expect(withIssuer(uri, '  ')).toBe(uri);
  });
});
