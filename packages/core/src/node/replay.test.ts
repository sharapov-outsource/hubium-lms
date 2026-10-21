import type { Db, Node } from '@hubium/db';
import { copyTestDatabase, createTestDatabase, type TestDatabase } from '@hubium/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor } from '../../test/helpers.ts';
import { invalidatePermissionCaches } from '../access/permissions.ts';
import { unenrolUser } from '../enrol/enrol.ts';
import { runModuleAction } from '../modules/actions.ts';
import { seed } from '../seed/seed.ts';
import { invalidateSettingsCache } from '../settings/settings.ts';
import { pruneReplayResults, replayBatch } from './replay.ts';
import { initialNodeState, setNodeState } from './runtime.ts';

// The cloud's replay of a node's journal, on two databases: the cloud's, and the node's copy
// of it, on which work is done as on a node without a connection (its journal kept in the
// same transactions). The replay must come to what the node came to (the double run), take
// each entry once, and leave as conflicts the entries the cloud's data or rules refuse now.

type Fixture = Awaited<ReturnType<typeof courseFixture>>;

/** Work done as on a node without a connection, on its own database. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const role = process.env.HUBIUM_ROLE;
  process.env.HUBIUM_ROLE = 'node';
  setNodeState({ ...initialNodeState(), mode: 'OFFLINE' });
  try {
    return await fn();
  } finally {
    setNodeState(initialNodeState());
    if (role === undefined) delete process.env.HUBIUM_ROLE;
    else process.env.HUBIUM_ROLE = role;
    invalidatePermissionCaches();
  }
}

/** The node's journal entries not yet taken, as the sync sends them. */
async function journal(db: Db, after = 0n) {
  const rows = await db.nodeOp.findMany({ where: { seq: { gt: after } }, orderBy: { seq: 'asc' } });
  return rows.map((r) => ({ ...r, seq: String(r.seq), at: r.at.toISOString() }));
}

/** The rows of a discussion, as people see them. */
async function discussionRows(db: Db, id: string) {
  const [discussion, posts] = await Promise.all([
    db.forumDiscussion.findUnique({ where: { id } }),
    db.forumPost.findMany({ where: { discussionId: id }, orderBy: { id: 'asc' } }),
  ]);
  const ids = posts.map((p) => p.id);
  const notifications = await db.notification.findMany({
    where: { url: { contains: id } },
    orderBy: { id: 'asc' },
  });
  return { discussion, posts, notifications, ids };
}

describe('the replay of a node’s journal', () => {
  let cloud: TestDatabase;
  let copy: TestDatabase;
  let f: Fixture;
  let forumId: string;
  let node: Node;
  let seen = 0n;

  /** The entries since the last call, replayed in the cloud. */
  const sync = async () => {
    const ops = await journal(copy.db, seen);
    seen = BigInt(ops.at(-1)?.seq ?? seen);
    const r = await replayBatch(cloud.db, node, { ops });
    if (r === 'busy') throw new Error('busy');
    return { ops, results: r.results };
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    invalidatePermissionCaches();
    invalidateSettingsCache();
    await seed(t.db, {
      profile: 'demo',
      courses: false,
      adminEmail: 'admin@test.local',
      adminPassword: 'Admin12345!',
    });
    f = await courseFixture(t.db, 'NODE1');
    ({ id: forumId } = await f.addActivity('forum', 'Форум филиала', {}));
    node = await t.db.node.create({ data: { name: 'Филиал', dbRole: 'hubium_node_test' } });
    // the line went down a minute ago
    await t.db.nodeOutage.create({
      data: { nodeId: node.id, startedAt: new Date(Date.now() - 60_000) },
    });
    ({ source: cloud, copy } = await copyTestDatabase(t));
  });

  afterAll(async () => {
    await copy?.drop();
    await cloud?.drop();
  });

  it('comes to the rows the node made, with the ids people saw there', async () => {
    const { discussionId } = await offline(async () => {
      const s1 = await ctxFor(copy.db, f.users.student1!);
      const s2 = await ctxFor(copy.db, f.users.student2!);
      const d = (await runModuleAction(s1, forumId, 'startDiscussion', {
        title: 'Без связи',
        message: '<p>Почему нет интернета?</p>',
      })) as { discussionId: string; postId: string };
      await runModuleAction(s2, forumId, 'reply', {
        postId: d.postId,
        message: '<p>Узел работает</p>',
      });
      return d;
    });
    const { ops, results } = await sync();
    expect(ops.map((o) => o.name)).toEqual(['forum.startDiscussion', 'forum.reply']);
    expect(results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    const onNode = await discussionRows(copy.db, discussionId);
    const inCloud = await discussionRows(cloud.db, discussionId);
    expect(onNode.posts).toHaveLength(2);
    expect(inCloud).toEqual(onNode);
  });

  it('takes each entry once when a batch comes again', async () => {
    const ops = await journal(copy.db);
    const before = await cloud.db.forumPost.count();
    const r = await replayBatch(cloud.db, node, { ops });
    if (r === 'busy') throw new Error('busy');
    expect(r.results.every((x) => x.repeated && x.status === 'APPLIED')).toBe(true);
    expect(await cloud.db.forumPost.count()).toBe(before);
    const outage = await cloud.db.nodeOutage.findFirstOrThrow({ where: { nodeId: node.id } });
    expect(outage.applied).toBe(2);
  });

  it('leaves a guarded change of rows the cloud changed too as a conflict', async () => {
    const post = await cloud.db.forumPost.findFirstOrThrow({
      where: { discussion: { activityId: forumId }, parentId: null },
    });
    await offline(async () => {
      const teacher = await ctxFor(copy.db, f.users.teacher!);
      await runModuleAction(teacher, forumId, 'editPost', {
        postId: post.id,
        message: '<p>Поправил преподаватель</p>',
      });
    });
    await cloud.db.forumPost.update({
      where: { id: post.id },
      data: { contentHtml: '<p>Поправили в облаке</p>' },
    });
    const { results } = await sync();
    expect(results).toMatchObject([{ status: 'CONFLICT', error: 'nodes.reason.changed' }]);
    const kept = await cloud.db.forumPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(kept.contentHtml).toBe('<p>Поправили в облаке</p>');
    const c = await cloud.db.nodeConflict.findFirstOrThrow({ where: { opId: results[0]!.id } });
    expect(c).toMatchObject({ actorId: f.users.teacher, activityId: forumId, status: 'OPEN' });
    const told = await cloud.db.notification.count({
      where: { userId: f.users.teacher, type: 'node.conflict' },
    });
    expect(told).toBe(1);
  });

  it('refuses what the cloud’s rules refuse now: a student no longer in the course', async () => {
    const post = await copy.db.forumPost.findFirstOrThrow({
      where: { discussion: { activityId: forumId }, parentId: null },
    });
    await offline(async () => {
      const s3 = await ctxFor(copy.db, f.users.student3!);
      await runModuleAction(s3, forumId, 'reply', { postId: post.id, message: '<p>Я тут</p>' });
    });
    const admin = await ctxFor(cloud.db, 'admin@test.local');
    await unenrolUser.run(admin, { courseId: f.courseId, userId: f.users.student3! });
    invalidatePermissionCaches();
    const { results } = await sync();
    expect(results).toMatchObject([{ status: 'CONFLICT' }]);
    expect(
      await cloud.db.forumPost.count({
        where: { authorId: f.users.student3, discussion: { activityId: forumId } },
      }),
    ).toBe(0);
  });

  it('refuses an entry from outside the node’s outages', async () => {
    const [op] = await journal(copy.db);
    const r = await replayBatch(cloud.db, node, {
      ops: [
        {
          ...op!,
          id: '01900000-0000-7000-8000-000000000001',
          at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    });
    if (r === 'busy') throw new Error('busy');
    expect(r.results).toMatchObject([{ status: 'CONFLICT', error: 'nodes.reason.time' }]);
  });
  it('forgets the results a node can no longer send again', async () => {
    const before = await cloud.db.nodeOpResult.count({ where: { nodeId: node.id } });
    expect(before).toBeGreaterThan(0);
    // still syncing: the results answer a batch sent again
    expect(await pruneReplayResults(cloud.db)).toBe(0);
    await cloud.db.nodeOutage.updateMany({
      where: { nodeId: node.id },
      data: { syncedAt: new Date(Date.now() + 2 * 86_400_000) },
    });
    expect(await pruneReplayResults(cloud.db)).toBe(before);
  });
});
