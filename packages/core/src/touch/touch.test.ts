import { createDb, type Db } from '@hubium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { useTestDb } from '../../test/helpers.ts';
import { touch } from './touch.ts';

// Side records of page views and API use, written in the touch scope: the strict guard
// lets them through.

describe('touch', () => {
  const t = useTestDb();
  let db: Db;
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let pageId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'TOUCH');
    pageId = (
      await f.addActivity(
        'page',
        'Viewed',
        { content: '<p>Hi</p>' },
        { completionMode: 'AUTO', completionRules: { view: true } },
      )
    ).id;
    db = createDb({ url: t.tdb.url, max: 2, writeGuard: 'strict' });
  });
  afterAll(() => db?.$disconnect());

  it('records an activity viewed by an enrolled learner, which completes it', async () => {
    const userId = f.users.student1!;
    const at = new Date('2026-10-01T09:00:00Z');
    await touch(
      db,
      {
        kind: 'activity.view',
        userId,
        courseId: f.courseId,
        activityId: pageId,
        moduleKey: 'page',
        enrolled: true,
      },
      at,
    );
    const row = await db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: pageId, userId } },
    });
    expect(row.state).toBe('COMPLETE');
    expect(row.viewedAt).not.toBeNull();
    const access = await db.courseAccess.findUniqueOrThrow({
      where: { userId_courseId: { userId, courseId: f.courseId } },
    });
    expect(access.lastActivityId).toBe(pageId);
    expect(
      await db.eventLog.count({
        where: { name: 'activity.viewed', actorId: userId, objectId: pageId },
      }),
    ).toBe(1);
  });

  it('only logs the view of someone not enrolled', async () => {
    const { id: userId } = await t.db.user.findFirstOrThrow({
      where: { email: 'admin@test.local' },
    });
    await touch(db, {
      kind: 'activity.view',
      userId,
      courseId: f.courseId,
      activityId: pageId,
      moduleKey: 'page',
      enrolled: false,
    });
    expect(await db.activityCompletion.count({ where: { activityId: pageId, userId } })).toBe(0);
    expect(await db.eventLog.count({ where: { name: 'activity.viewed', actorId: userId } })).toBe(
      1,
    );
  });

  it('records the course opened and the last visit', async () => {
    const userId = f.users.student2!;
    await touch(db, { kind: 'course.access', userId, courseId: f.courseId });
    expect(await db.courseAccess.count({ where: { userId, courseId: f.courseId } })).toBe(1);
    const at = new Date('2026-10-01T10:00:00Z');
    await touch(db, { kind: 'user.access', userId, lastAccessAt: null }, at);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).lastAccessAt).toEqual(at);
  });

  it('records the use of an API token at most once a minute', async () => {
    const token = await t.db.apiToken.create({
      data: {
        userId: f.users.teacher!,
        name: 'touch',
        prefix: 'touch',
        tokenHash: 'touch-test',
        scopes: ['read'],
      },
    });
    const at = new Date('2026-10-01T11:00:00Z');
    const use = (lastUsedAt: Date | null, when: Date) =>
      touch(db, { kind: 'token.use', tokenId: token.id, lastUsedAt, ip: '10.0.0.1' }, when);
    await use(null, at);
    await use(at, new Date(at.getTime() + 30_000));
    let row = await db.apiToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row).toMatchObject({ lastUsedAt: at, lastUsedIp: '10.0.0.1' });
    const later = new Date(at.getTime() + 61_000);
    await use(at, later);
    row = await db.apiToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.lastUsedAt).toEqual(later);
  });

  it('logs an access', async () => {
    await touch(db, {
      kind: 'event',
      event: { name: 'privacy.exported', actorId: f.users.student3!, origin: 'WEB' },
    });
    expect(await db.eventLog.count({ where: { name: 'privacy.exported' } })).toBe(1);
  });
});
