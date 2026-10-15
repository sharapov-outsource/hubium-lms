import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkCriteria, criteriaMet } from './criteria.ts';
import {
  assertionJson,
  bakePng,
  bakeSvg,
  hashedIdentity,
  isPng,
  readBakedPng,
  revokedJson,
} from './openbadges.ts';

/** A 1×1 transparent PNG. */
function tinyPng(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('Open Badges 2.0', () => {
  it('bakes the assertion into a PNG, replacing an earlier one', () => {
    const png = tinyPng();
    const once = bakePng(png, '{"id":"https://lms/a/1"}');
    expect(isPng(once)).toBe(true);
    expect(readBakedPng(once)).toBe('{"id":"https://lms/a/1"}');
    const twice = bakePng(once, '{"id":"https://lms/a/2"}');
    expect(readBakedPng(twice)).toBe('{"id":"https://lms/a/2"}');
    expect(twice.length).toBe(once.length);
    expect(readBakedPng(png)).toBeNull();
    expect(() => bakePng(new Uint8Array([1, 2, 3]), 'x')).toThrow(/PNG/);
  });

  it('bakes an SVG', () => {
    const svg =
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10"><circle r="4"/></svg>';
    const baked = bakeSvg(svg, 'https://lms/api/badges/assertions/1?x=1&y=2', '{"a":"]]>"}');
    expect(baked).toContain('xmlns:openbadges="https://openbadges.org"');
    expect(baked).toContain('verify="https://lms/api/badges/assertions/1?x=1&amp;y=2"');
    expect(baked).toContain('<![CDATA[{"a":"]]]]><![CDATA[>"}]]>');
    expect(bakeSvg(baked, 'https://x', '{}').match(/openbadges:assertion /g)).toHaveLength(1);
  });

  it('hashes the recipient and describes revoked assertions', () => {
    const sha = createHash('sha256')
      .update('ann@example.org' + 'salt1')
      .digest('hex');
    expect(hashedIdentity('ann@example.org', 'salt1')).toBe(`sha256$${sha}`);
    const a = assertionJson({
      id: 'https://lms/api/badges/assertions/1',
      badge: 'https://lms/api/badges/classes/b',
      recipientType: 'email',
      salt: 'salt1',
      identity: 'ann@example.org',
      issuedOn: new Date('2026-10-01T00:00:00Z'),
      expires: null,
    });
    expect(a).toMatchObject({
      type: 'Assertion',
      recipient: { type: 'email', hashed: true, identity: `sha256$${sha}` },
      issuedOn: '2026-10-01T00:00:00.000Z',
      verification: { type: 'hosted' },
    });
    expect(a).not.toHaveProperty('expires');
    expect(revokedJson('x', 'Списывание')).toMatchObject({ revoked: true });
  });

  it('criteria: rules of the badge kind, all or any', () => {
    const c = checkCriteria(
      {
        method: 'any',
        rules: [{ kind: 'courseCompletion' }, { kind: 'courseGrade', minPercent: 80 }],
      },
      false,
    );
    const facts = {
      completedCourses: new Set<string>(),
      completedActivities: new Set<string>(),
      courseGradePercent: 85,
      markedByRoles: new Set<string>(),
      cohorts: new Set<string>(),
    };
    expect(criteriaMet(c, facts, 'c1')).toBe(true);
    expect(criteriaMet({ ...c, method: 'all' }, facts, 'c1')).toBe(false);
    expect(criteriaMet({ method: 'all', rules: [] }, facts, 'c1')).toBe(false);
    expect(() => checkCriteria({ rules: [{ kind: 'courseCompletion' }] }, true)).toThrow(/site/);
    expect(() =>
      checkCriteria(
        {
          rules: [
            { kind: 'courseGrade', minPercent: 1 },
            { kind: 'courseGrade', minPercent: 2 },
          ],
        },
        false,
      ),
    ).toThrow(/once/);
  });
});
