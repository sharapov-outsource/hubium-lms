import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { ForbiddenError } from '../errors.ts';
import {
  assertionDocument,
  awardBadgeAgain,
  BADGES_REVIEW_JOB,
  badgeClassDocument,
  badgeDetail,
  bakedBadgeImage,
  deleteBadge,
  markBadge,
  reviewAllBadges,
  reviewBadge,
  revokeBadgeAward,
  saveBadge,
  setBadgeImage,
  setBadgeStatus,
} from './badges.ts';
import { hashedIdentity } from './openbadges.ts';

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5" cx="5" cy="5"/></svg>',
);
const ORIGIN = 'https://lms.example';

describe('badges', () => {
  const t = useTestDb();

  it('a course badge is earned by completing activities, verified, locked and revoked', async () => {
    const f = await courseFixture(t.db, 'BADGE1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    const a = await f.addActivity(
      'page',
      'Читать',
      { content: '<p>x</p>' },
      {
        completionMode: 'MANUAL',
      },
    );
    const criteria = {
      method: 'all',
      rules: [{ kind: 'activities', activityIds: [a.id], method: 'all' }],
    };
    const { id } = await saveBadge.run(teacher, {
      courseId: f.courseId,
      name: 'Первые шаги',
      description: 'Прочитал вводную',
      criteria,
      expiry: 'days',
      expiresAfterDays: 30,
    });
    // a site-only rule, an activity from elsewhere
    await expect(
      saveBadge.run(teacher, {
        courseId: f.courseId,
        name: 'x',
        criteria: {
          method: 'all',
          rules: [{ kind: 'cohort', cohortIds: [f.courseId], method: 'all' }],
        },
      }),
    ).rejects.toMatchObject({
      fieldErrors: { criteria: [expect.stringMatching(/cannot have/)] },
    });
    const refused = (rules: unknown[]) =>
      saveBadge.run(teacher, { courseId: f.courseId, name: 'x', criteria: { rules } });
    await expect(
      refused([{ kind: 'activities', activityIds: [], method: 'all' }]),
    ).rejects.toMatchObject({
      fieldErrors: { criteria: ['Choose at least one for the rule activities'] },
    });
    const other = await courseFixture(t.db, 'BADGE1X');
    const elsewhere = await other.addActivity('page', 'Чужой', { content: '<p>y</p>' });
    await expect(
      refused([{ kind: 'activities', activityIds: [elsewhere.id], method: 'all' }]),
    ).rejects.toMatchObject({ fieldErrors: { criteria: ['Unknown activity'] } });
    // learners do not manage badges
    await expect(
      saveBadge.run(student, { courseId: f.courseId, name: 'x', criteria }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // the image comes first
    await expect(setBadgeStatus.run(teacher, { id, status: 'ACTIVE' })).rejects.toMatchObject({
      fieldErrors: { status: [expect.stringMatching(/image/)] },
    });
    await setBadgeImage.run(teacher, { id, name: 'b.svg', data: SVG });
    capturedJobs.length = 0;
    await setBadgeStatus.run(teacher, { id, status: 'ACTIVE' });
    expect(capturedJobs.map((j) => j.name)).toContain(BADGES_REVIEW_JOB);
    expect(await reviewBadge(t.db, id)).toBe(0);

    // completing the activity earns it, with a notification
    await toggleManualCompletion.run(student, { activityId: a.id, done: true });
    const award = await t.db.badgeAward.findUniqueOrThrow({
      where: { badgeId_userId: { badgeId: id, userId: f.users.student1! } },
    });
    const days = (award.expiresAt!.getTime() - award.issuedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(
      await t.db.notification.count({
        where: { userId: f.users.student1!, type: 'badge.awarded' },
      }),
    ).toBe(1);
    // others did not
    expect(await t.db.badgeAward.count({ where: { badgeId: id } })).toBe(1);

    // the assertion names the recipient by their hashed email
    const doc = await assertionDocument(t.db, ORIGIN, award.id);
    expect(doc?.status).toBe(200);
    const body = doc!.body as Record<string, unknown> & {
      recipient: { identity: string; salt: string };
    };
    const email = (await t.db.user.findUniqueOrThrow({ where: { id: f.users.student1! } })).email;
    expect(body.recipient.identity).toBe(hashedIdentity(email.toLowerCase(), body.recipient.salt));
    expect(body.badge).toBe(`${ORIGIN}/api/badges/classes/${id}`);
    const cls = await badgeClassDocument(t.db, ORIGIN, id);
    expect(cls).toMatchObject({ type: 'BadgeClass', name: 'Первые шаги' });
    expect(String((cls as { criteria: { narrative: string } }).criteria.narrative)).toContain(
      'Читать',
    );
    const baked = await bakedBadgeImage(t.db, ORIGIN, award.id);
    expect(baked?.mimeType).toBe('image/svg+xml');
    expect(baked!.data.toString('utf8')).toContain(`verify="${ORIGIN}/api/badges/assertions/`);

    // once awarded: criteria fixed, not deleted, not a draft
    await expect(
      saveBadge.run(teacher, {
        id,
        name: 'Первые шаги',
        criteria: { ...criteria, method: 'any' },
        expiry: 'days',
        expiresAfterDays: 30,
      }),
    ).rejects.toMatchObject({ fieldErrors: { criteria: [expect.stringMatching(/awarded/)] } });
    await saveBadge.run(teacher, {
      id,
      name: 'Первые шаги!',
      criteria,
      expiry: 'days',
      expiresAfterDays: 30,
    });
    await expect(deleteBadge.run(teacher, { id })).rejects.toMatchObject({
      fieldErrors: { id: [expect.stringMatching(/archived/)] },
    });
    await expect(setBadgeStatus.run(teacher, { id, status: 'DRAFT' })).rejects.toMatchObject({
      fieldErrors: { status: [expect.stringMatching(/archived/)] },
    });

    // revoked: the assertion says so, the image is not baked any more
    await revokeBadgeAward.run(teacher, { awardId: award.id, reason: 'Ошибка' });
    const gone = await assertionDocument(t.db, ORIGIN, award.id);
    expect(gone).toMatchObject({
      status: 410,
      body: { revoked: true, revocationReason: 'Ошибка' },
    });
    expect(await bakedBadgeImage(t.db, ORIGIN, award.id)).toBeNull();

    // a revoke stays until someone gives the badge back: earning it again does not undo it
    await toggleManualCompletion.run(student, { activityId: a.id, done: false });
    await toggleManualCompletion.run(student, { activityId: a.id, done: true });
    expect(await reviewBadge(t.db, id)).toBe(0);
    expect(
      (await t.db.badgeAward.findUniqueOrThrow({ where: { id: award.id } })).revokedAt,
    ).not.toBeNull();
    await expect(awardBadgeAgain.run(student, { awardId: award.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const later = new Date(Date.now() + 60_000);
    await awardBadgeAgain.run({ ...teacher, now: later }, { awardId: award.id });
    const again = await t.db.badgeAward.findUniqueOrThrow({ where: { id: award.id } });
    expect(again).toMatchObject({ revokedAt: null, revokedReason: null, issuedAt: later });
    expect(again.expiresAt).toEqual(new Date(later.getTime() + 30 * 86_400_000));
    expect((await assertionDocument(t.db, ORIGIN, award.id))?.status).toBe(200);
    expect(
      await t.db.notification.count({
        where: { userId: f.users.student1!, type: 'badge.awarded' },
      }),
    ).toBe(2);
    // a valid award is not given twice; an expired one is given again, as a revoked one
    await expect(awardBadgeAgain.run(teacher, { awardId: award.id })).rejects.toMatchObject({
      fieldErrors: { awardId: [expect.any(String)] },
    });
    await t.db.badgeAward.update({
      where: { id: award.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // the teacher's request comes now, after the award has run out
    await awardBadgeAgain.run({ ...teacher, now: new Date() }, { awardId: award.id });
    expect(
      (await t.db.badgeAward.findUniqueOrThrow({ where: { id: award.id } })).expiresAt! >
        new Date(),
    ).toBe(true);
  });

  it('a badge awarded by hand needs each of its roles', async () => {
    const f = await courseFixture(t.db, 'BADGE2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await saveBadge.run(teacher, {
      courseId: f.courseId,
      name: 'Помощник',
      criteria: {
        method: 'all',
        rules: [
          {
            kind: 'manual',
            roleIds: [f.roles.editingteacher!, f.roles.manager!],
            method: 'all',
          },
        ],
      },
    });
    await setBadgeImage.run(teacher, { id, name: 'b.svg', data: SVG });
    await setBadgeStatus.run(teacher, { id, status: 'ACTIVE' });
    await expect(
      markBadge.run(student, { badgeId: id, userId: f.users.student2! }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // the teacher's mark alone is not enough
    expect(await markBadge.run(teacher, { badgeId: id, userId: f.users.student2! })).toEqual({
      awarded: false,
    });
    // an administrator marks for every role
    expect(await markBadge.run(admin, { badgeId: id, userId: f.users.student2! })).toEqual({
      awarded: true,
    });
    const award = await t.db.badgeAward.findFirstOrThrow({ where: { badgeId: id } });
    expect(award.awardedById).toBe(admin.perm.userId);
    // revoked, the learner can be awarded it by hand again
    await revokeBadgeAward.run(admin, { awardId: award.id, reason: 'Ошибка' });
    expect((await badgeDetail(admin, id)).awardable.map((u) => u.id)).toContain(f.users.student2);
    expect(await markBadge.run(admin, { badgeId: id, userId: f.users.student2! })).toEqual({
      awarded: true,
    });
    expect(await t.db.badgeAward.findUniqueOrThrow({ where: { id: award.id } })).toMatchObject({
      revokedAt: null,
    });
    expect((await badgeDetail(admin, id)).awardable.map((u) => u.id)).not.toContain(
      f.users.student2,
    );
    // only the course's learners
    await expect(
      markBadge.run(admin, { badgeId: id, userId: f.users.teacher! }),
    ).rejects.toMatchObject({ fieldErrors: { userId: [expect.any(String)] } });
  });

  it('a site badge for cohort members is awarded by the review', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const users = await t.db.user.findMany({
      where: { username: { in: ['student1', 'student2'] } },
    });
    const cohort = await t.db.cohort.create({
      data: {
        name: 'Выпуск',
        contextId: SYSTEM_CONTEXT_ID,
        members: { create: users.map((u) => ({ userId: u.id })) },
      },
    });
    const { id } = await saveBadge.run(admin, {
      courseId: null,
      name: 'Выпускник',
      criteria: {
        method: 'any',
        rules: [{ kind: 'cohort', cohortIds: [cohort.id], method: 'all' }],
      },
      expiry: 'never',
    });
    await setBadgeImage.run(admin, { id, name: 'b.svg', data: SVG });
    await setBadgeStatus.run(admin, { id, status: 'ACTIVE' });
    // two reviews at once (the hourly one and "Run now"): each award is made once, and
    // neither fails on the unique key
    const [first, second] = await Promise.all([reviewAllBadges(t.db), reviewAllBadges(t.db)]);
    expect(first + second).toBe(2);
    expect(await t.db.badgeAward.count({ where: { badgeId: id } })).toBe(2);
    // once each
    expect(await reviewAllBadges(t.db)).toBe(0);
    const awards = await t.db.badgeAward.findMany({ where: { badgeId: id } });
    expect(awards.every((a) => a.expiresAt === null)).toBe(true);
    // archived: not awarded any more, awards stay
    await setBadgeStatus.run(admin, { id, status: 'ARCHIVED' });
    const u3 = await t.db.user.findFirstOrThrow({ where: { username: 'student3' } });
    await t.db.cohortMember.create({ data: { cohortId: cohort.id, userId: u3.id } });
    expect(await reviewAllBadges(t.db)).toBe(0);
    expect(await t.db.badgeAward.count({ where: { badgeId: id } })).toBe(2);
    expect((await assertionDocument(t.db, ORIGIN, awards[0]!.id))?.status).toBe(200);
  });
});
