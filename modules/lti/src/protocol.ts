import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Prisma } from '@hubium/db';
import { ModuleError, msg } from '@hubium/module-sdk';
import { safeFetch } from '@hubium/module-sdk/net';
import {
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  importJWK,
  importSPKI,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';

// LTI 1.3 platform protocol helpers: platform keys (RS256, rotation, JWKS), signed
// login hints, LTI claims and verification of tool-signed JWTs.

type Db = Prisma.TransactionClient;

export const LTI = {
  version: '1.3.0',
  claim: (name: string) => `https://purl.imsglobal.org/spec/lti/claim/${name}`,
  dl: (name: string) => `https://purl.imsglobal.org/spec/lti-dl/claim/${name}`,
  ags: 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint',
  nrps: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice',
  scopes: {
    lineitem: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
    lineitemRead: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
    result: 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
    score: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
    nrps: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
  },
  roles: {
    instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
    learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
    admin: 'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  },
} as const;

export function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export const issuer = appUrl;
export const endpoint = (p: string) => `${appUrl()}/api/mod/lti/${p}`;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new ModuleError('BAD_REQUEST', msg('mod.lti.errors.noAppSecret'));
  return s;
}

// ── private key encryption (AES-256-GCM) ─────────────────────────────────────

const aesKey = () => createHash('sha256').update(`lti-keys:${secret()}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function unseal(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', aesKey(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
}

// ── platform keys ────────────────────────────────────────────────────────────

/** Retired keys stay published this long so tokens signed with them still verify. */
const RETIRED_TTL_MS = 7 * 86_400_000;

export async function rotateKey(db: Db) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomBytes(12).toString('base64url');
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid, alg: 'RS256' };
  await db.ltiPlatformKey.updateMany({
    where: { active: true },
    data: { active: false, retiredAt: new Date() },
  });
  await db.ltiPlatformKey.create({
    data: {
      kid,
      publicJwk: pub as Prisma.InputJsonValue,
      privateKeyEnc: seal(JSON.stringify(priv)),
    },
  });
  return kid;
}

export async function signingKey(db: Db) {
  let k = await db.ltiPlatformKey.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (k) {
    try {
      return {
        kid: k.kid,
        key: await importJWK(JSON.parse(unseal(k.privateKeyEnc)) as JWK, 'RS256'),
      };
    } catch {
      // sealed under an APP_SECRET changed since (`hubium secrets rotate` leaves it, being
      // the module's own): a new key takes over, the old one stays published a while
    }
  }
  await rotateKey(db);
  k = await db.ltiPlatformKey.findFirstOrThrow({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  });
  return { kid: k.kid, key: await importJWK(JSON.parse(unseal(k.privateKeyEnc)) as JWK, 'RS256') };
}

export async function jwks(db: Db): Promise<{ keys: JWK[] }> {
  const keys = await db.ltiPlatformKey.findMany({
    where: { OR: [{ active: true }, { retiredAt: { gt: new Date(Date.now() - RETIRED_TTL_MS) } }] },
    orderBy: { createdAt: 'desc' },
  });
  return { keys: keys.map((k) => k.publicJwk as JWK) };
}

export async function signPlatformJwt(db: Db, claims: JWTPayload, audience: string, ttlSec = 300) {
  const { kid, key } = await signingKey(db);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(issuer())
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

// ── tool keys ────────────────────────────────────────────────────────────────

const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies a JWT signed by the tool (deep linking response, client assertion). */
export async function verifyToolJwt(
  tool: { clientId: string; jwksUrl: string | null; publicKeyPem: string | null },
  jwt: string,
  opts: { audience: string; issuer?: string; subject?: string },
) {
  const check = {
    audience: opts.audience,
    issuer: opts.issuer,
    subject: opts.subject,
    algorithms: ['RS256'],
  };
  if (tool.publicKeyPem) {
    return jwtVerify(jwt, await importSPKI(tool.publicKeyPem, 'RS256'), check);
  }
  if (!tool.jwksUrl) throw new ModuleError('BAD_REQUEST', msg('mod.lti.errors.noToolKey'));
  let set = remoteSets.get(tool.jwksUrl);
  if (!set)
    remoteSets.set(
      tool.jwksUrl,
      (set = createRemoteJWKSet(new URL(tool.jwksUrl), {
        // tool-supplied URL: refuse internal addresses (SSRF)
        [customFetch]: (url: string, init: RequestInit) => safeFetch(url, init),
      })),
    );
  return jwtVerify(jwt, set, check);
}

// ── signed hints (login_hint / lti_message_hint) ─────────────────────────────

export interface MessageHint {
  /** Activity being launched. */
  a: string;
  /** User. */
  u: string;
  /** Tool. */
  t: string;
  /** Message type. */
  m: 'LtiResourceLinkRequest' | 'LtiDeepLinkingRequest';
  /** Expiry (unix seconds). */
  e: number;
  /** Random: each launch its own hint, which works once, even two in the same second. */
  n?: string;
}

const hmac = (v: string) =>
  createHmac('sha256', `lti-hint:${secret()}`).update(v).digest('base64url');

export function signHint(h: Omit<MessageHint, 'e'>, ttlSec = 300): string {
  const data = Buffer.from(
    JSON.stringify({
      ...h,
      e: Math.floor(Date.now() / 1000) + ttlSec,
      n: randomBytes(9).toString('base64url'),
    }),
  ).toString('base64url');
  return `${data}.${hmac(data)}`;
}

export function readHint(token: string | null | undefined): MessageHint | null {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const a = Buffer.from(hmac(data));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const h = JSON.parse(Buffer.from(data, 'base64url').toString()) as MessageHint;
    return h.e > Date.now() / 1000 ? h : null;
  } catch {
    return null;
  }
}

/** Single-use nonces (replay protection for id_tokens we issue). */
export async function claimNonce(db: Db, nonce: string, ttlSec = 600): Promise<boolean> {
  try {
    await db.ltiNonce.create({ data: { nonce, expiresAt: new Date(Date.now() + ttlSec * 1000) } });
    return true;
  } catch {
    return false;
  }
}

export function parseCustom(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

/** HTML page that auto-submits a form (OIDC redirects use form_post). */
export function autoPostForm(
  action: string,
  fields: Record<string, string>,
  method: 'post' | 'get' = 'post',
): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>LTI</title></head><body>
<form id="f" method="${method}" action="${esc(action)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form>
<script>document.getElementById('f').submit()</script></body></html>`;
}
