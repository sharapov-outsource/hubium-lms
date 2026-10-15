import { createPrivateKey, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateBody, generateSpKeyPair, spMetadataXml } from './saml-keys.ts';

// generating an RSA key takes seconds on a busy machine
describe('service provider keys', { timeout: 30_000 }, () => {
  it('makes a self-signed certificate for its key', () => {
    const k = generateSpKeyPair('Hubium LMS test', 10, new Date('2026-10-16T00:00:00Z'));
    const cert = new X509Certificate(k.certificate);
    expect(cert.subject).toBe('CN=Hubium LMS test');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.validTo).toBe('Oct 16 00:00:00 2036 GMT');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(k.privateKey))).toBe(true);
  });

  it('dates past 2049 as GeneralizedTime', () => {
    const k = generateSpKeyPair('x', 30, new Date('2040-01-01T00:00:00Z'));
    expect(new X509Certificate(k.certificate).validTo).toBe('Jan  1 00:00:00 2070 GMT');
  });

  it('publishes the certificate in the metadata', () => {
    const k = generateSpKeyPair('x');
    const xml = spMetadataXml({
      entityId: 'https://lms.example.org/api/auth/sso/saml2/sp/metadata?providerId=a&b',
      acsUrl: 'https://lms.example.org/api/auth/sso/saml2/sp/acs/a',
      certificate: k.certificate,
    });
    expect(xml).toContain(
      'entityID="https://lms.example.org/api/auth/sso/saml2/sp/metadata?providerId=a&amp;b"',
    );
    expect(xml).toContain(
      `<ds:X509Certificate>${certificateBody(k.certificate)}</ds:X509Certificate>`,
    );
    expect(xml).toContain('AuthnRequestsSigned="true"');
  });
});
