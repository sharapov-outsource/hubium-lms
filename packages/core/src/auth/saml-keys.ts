import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// The signing key of Hubium as a SAML service provider: an RSA key with a self-signed
// certificate, made per provider when it is added. Identity providers that want signed
// authentication requests (ADFS, Keycloak by default) read the certificate from Hubium's
// metadata. Node can make keys but not certificates, hence the small DER encoder below.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : n < 0x10000
          ? Buffer.from([0x82, n >> 8, n & 0xff])
          : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

const seq = (...p: Buffer[]) => der(0x30, ...p);
const set = (...p: Buffer[]) => der(0x31, ...p);
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (s: string) => der(0x0c, Buffer.from(s, 'utf8'));
const bits = (b: Buffer) => der(0x03, Buffer.from([0]), b);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups: number[] = [];
    let v = n;
    do {
      groups.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return der(0x06, Buffer.from(out));
}

function integer(b: Buffer): Buffer {
  // positive: a leading zero when the high bit is set
  return der(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // UTCTime until 2049, GeneralizedTime after (RFC 5280)
  return d.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : der(0x18, Buffer.from(`${iso}Z`));
}

const SHA256_RSA = '1.2.840.113549.1.1.11';
const COMMON_NAME = '2.5.4.3';

export interface SpKeyPair {
  /** PKCS#1 PEM */
  privateKey: string;
  /** PEM certificate */
  certificate: string;
}

/** A 2048-bit RSA key and a self-signed certificate valid for `years` years. */
export function generateSpKeyPair(commonName: string, years = 10, now = new Date()): SpKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid(SHA256_RSA), nul());
  const name = seq(set(seq(oid(COMMON_NAME), utf8(commonName.slice(0, 64)))));
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + years);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    seq(time(now), time(until)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, algorithm, bits(signature));
  const b64 = cert.toString('base64').replace(/.{64}/g, '$&\n');
  return {
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    certificate: `-----BEGIN CERTIFICATE-----\n${b64.trimEnd()}\n-----END CERTIFICATE-----\n`,
  };
}

/** The certificate body as SAML metadata carries it (base64, no armour). */
export function certificateBody(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
}

const xmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Service provider metadata with the signing certificate, for the IdP and for samlify. */
export function spMetadataXml(o: { entityId: string; acsUrl: string; certificate: string }) {
  return [
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlAttr(o.entityId)}">`,
    `<md:SPSSODescriptor AuthnRequestsSigned="true" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificateBody(o.certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`,
    `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlAttr(o.acsUrl)}" index="0" isDefault="true"/>`,
    `</md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join('');
}
