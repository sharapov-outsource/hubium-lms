import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Open Badges 2.0, hosted verification: the JSON-LD documents a badge's public addresses
// answer with, and badge images "baked" with the assertion (PNG iTXt chunk, SVG element)
// so the image alone can be checked by any Open Badges verifier. Pure.

export const OB_CONTEXT = 'https://w3id.org/openbadges/v2';

/** "sha256$" + hex of the identity and salt, as recipient profiles are hashed. */
export function hashedIdentity(identity: string, salt: string): string {
  return `sha256$${createHash('sha256')
    .update(identity + salt)
    .digest('hex')}`;
}

export function issuerJson(o: { id: string; name: string; url: string; email?: string }) {
  return {
    '@context': OB_CONTEXT,
    type: 'Issuer',
    id: o.id,
    name: o.name,
    url: o.url,
    ...(o.email ? { email: o.email } : {}),
  };
}

export function badgeClassJson(o: {
  id: string;
  name: string;
  description: string;
  image: string;
  criteriaUrl: string;
  criteriaNarrative: string;
  issuer: string;
}) {
  return {
    '@context': OB_CONTEXT,
    type: 'BadgeClass',
    id: o.id,
    name: o.name,
    description: o.description || o.name,
    image: o.image,
    criteria: { id: o.criteriaUrl, narrative: o.criteriaNarrative },
    issuer: o.issuer,
  };
}

export function assertionJson(o: {
  id: string;
  badge: string;
  recipientType: 'email' | 'id';
  salt: string;
  identity: string;
  issuedOn: Date;
  expires?: Date | null;
  image?: string;
}) {
  return {
    '@context': OB_CONTEXT,
    type: 'Assertion',
    id: o.id,
    recipient: {
      type: o.recipientType,
      hashed: true,
      salt: o.salt,
      identity: hashedIdentity(o.identity, o.salt),
    },
    badge: o.badge,
    issuedOn: o.issuedOn.toISOString(),
    ...(o.expires ? { expires: o.expires.toISOString() } : {}),
    ...(o.image ? { image: o.image } : {}),
    verification: { type: 'hosted' },
  };
}

/** What a revoked assertion answers (with HTTP 410). */
export function revokedJson(id: string, reason: string) {
  return { '@context': OB_CONTEXT, type: 'Assertion', id, revoked: true, revocationReason: reason };
}

// ── baking ───────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEYWORD = 'openbadges';

export function isPng(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 8)).equals(PNG_SIGNATURE);
}

export function isSvg(data: Uint8Array): boolean {
  const head = Buffer.from(data.subarray(0, 1024)).toString('utf8');
  return /<svg[\s>]/i.test(head);
}

interface Chunk {
  type: string;
  data: Buffer;
}

function chunks(png: Uint8Array): Chunk[] {
  const buf = Buffer.from(png);
  if (!isPng(buf)) throw new Error('Not a PNG image');
  const out: Chunk[] = [];
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (at + 12 + len > buf.length) throw new Error('The PNG image is cut short');
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  if (out.at(-1)?.type !== 'IEND') throw new Error('The PNG image has no end');
  return out;
}

function encode(c: Chunk): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(c.data.length, 0);
  head.write(c.type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), c.data])) >>> 0, 0);
  return Buffer.concat([head, c.data, crc]);
}

const isBadgeChunk = (c: Chunk) =>
  c.type === 'iTXt' && c.data.subarray(0, KEYWORD.length + 1).toString('latin1') === `${KEYWORD}\0`;

/** The PNG with an "openbadges" iTXt chunk holding `content` (any earlier one replaced). */
export function bakePng(png: Uint8Array, content: string): Uint8Array {
  const kept = chunks(png).filter((c) => !isBadgeChunk(c));
  // keyword, no compression, no language tag, no translated keyword, then the text
  const data = Buffer.concat([
    Buffer.from(`${KEYWORD}\0\0\0\0\0`, 'latin1'),
    Buffer.from(content, 'utf8'),
  ]);
  const end = kept.pop()!;
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      ...kept.map(encode),
      encode({ type: 'iTXt', data }),
      encode(end),
    ]),
  );
}

/** The content baked into a PNG, or null. */
export function readBakedPng(png: Uint8Array): string | null {
  const c = chunks(png).find(isBadgeChunk);
  if (!c) return null;
  // after the keyword: flags (2 bytes), then language tag and translated keyword, each \0-ended
  let at = KEYWORD.length + 3;
  for (let n = 0; n < 2; n++) at = c.data.indexOf(0, at) + 1;
  return c.data.subarray(at).toString('utf8');
}

/** The SVG with an <openbadges:assertion> holding the assertion (any earlier one replaced). */
export function bakeSvg(svg: string, assertionUrl: string, assertion: string): string {
  const clean = svg.replace(/<openbadges:assertion[\s\S]*?<\/openbadges:assertion>/g, '');
  const open = /<svg\b[^>]*>/i.exec(clean);
  if (!open) throw new Error('Not an SVG image');
  let tag = open[0];
  if (!/xmlns:openbadges=/.test(tag))
    tag = tag.replace(/^<svg\b/i, '<svg xmlns:openbadges="https://openbadges.org"');
  const url = assertionUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const body = assertion.replace(/]]>/g, ']]]]><![CDATA[>');
  const element = `<openbadges:assertion verify="${url}"><![CDATA[${body}]]></openbadges:assertion>`;
  return clean.slice(0, open.index) + tag + element + clean.slice(open.index + open[0].length);
}
