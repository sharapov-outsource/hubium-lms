import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Envelope for secrets stored in the database (AI keys, LTI private keys, SMTP passwords).
// Format: "v1.<iv>.<tag>.<ciphertext>" with base64url parts, AES-256-GCM, key = sha256(APP_SECRET).

const VERSION = 'v1';

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(`hubium:secrets:${secret}`).digest();
}

export function encryptSecret(plaintext: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(appSecret), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

export function decryptSecret(envelope: string, appSecret: string): string {
  const [version, iv, tag, data] = envelope.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error('Malformed secret envelope');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFrom(appSecret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** HMAC-SHA256 signature, base64url. Used for signed file URLs and unsubscribe links. */
export function sign(value: string, appSecret: string, purpose: string): string {
  return createHmac('sha256', `${purpose}:${appSecret}`).update(value).digest('base64url');
}

export function verifySignature(
  value: string,
  signature: string,
  appSecret: string,
  purpose: string,
): boolean {
  const expected = Buffer.from(sign(value, appSecret, purpose));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
