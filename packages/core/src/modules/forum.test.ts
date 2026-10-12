import {
  canSeeDiscussion,
  postStats,
  postVisible,
  qandaLocked,
  subscribers,
  subscriptionState,
} from '@hubium/mod-forum/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { getActivityAccess, updateActivity } from '../courses/activities.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx, toActivityRef } from './module-ctx.ts';

type Started = { discussionId: string; postId: string };

describe('mod-forum', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let forumId: string;
  let d1: Started;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'FORUM1');
    forumId = (
      await f.addActivity(
        'forum',
        'Обсуждения',
        { subscription: 'optional', editMinutes: 30 },
        { completionMode: 'AUTO', completionRules: { module: { posts: 2, replies: 1 } } },
      )
    ).id;
  });

  const as = (id: string) => ctxFor(t.db, id);
  const run = async <T>(user: string, action: string, input: unknown) =>
    runModuleAction(await as(user), forumId, action, input) as Promise<T>;
  const forumRef = async () => {
    const { activity } = await getActivityAccess(await as(f.users.teacher!), forumId);
    return toActivityRef(activity) as never;
  };
  const notified = (userId: string) =>
    t.db.notification.count({ where: { userId, type: 'forum.post' } });

  it('a student starts a discussion and follows it', async () => {
    d1 = await run<Started>(f.users.student1!, 'startDiscussion', {
      title: 'Вопрос по заданию',
      message: '<p>Как сдавать?</p><img src=x onerror=alert(1)>',
      files: [{ name: 'q.txt', mimeType: 'text/plain', data: Buffer.from('?') }],
    });
    const post = await t.db.forumPost.findUniqueOrThrow({ where: { id: d1.postId } });
    expect(post.contentHtml).not.toContain('onerror');
    expect(await t.db.file.count({ where: { contextId: forumId, itemId: d1.postId } })).toBe(1);
    const ctx = buildModuleCtx(await as(f.users.student1!));
    expect(
      await subscriptionState(ctx, await forumRef(), f.users.student1!, d1.discussionId),
    ).toEqual({ forum: false, discussion: true });
  });

  it('replies notify discussion followers and mark the replier as follower', async () => {
    const r = await run<{ postId: string }>(f.users.teacher!, 'reply', {
      postId: d1.postId,
      message: '<p>Через форму задания</p>',
    });
    expect(await notified(f.users.student1!)).toBe(1);
    expect(await notified(f.users.student2!)).toBe(0);
    const n = await t.db.notification.findFirstOrThrow({
      where: { userId: f.users.student1, type: 'forum.post' },
    });
    expect(n.url).toContain(`?d=${d1.discussionId}#p-${r.postId}`);
    expect(n.title).toContain('Вопрос по заданию');
    await run(f.users.student1!, 'reply', { postId: r.postId, message: '<p>Спасибо!</p>' });
    expect(await notified(f.users.teacher!)).toBe(1);
    const d = await t.db.forumDiscussion.findUniqueOrThrow({ where: { id: d1.discussionId } });
    expect(d.postCount).toBe(3);
  });

  it('completion counts posts and replies', async () => {
    expect(await postStats(t.db, forumId, f.users.student1!)).toEqual({
      discussions: 1,
      replies: 1,
      posts: 2,
    });
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: forumId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE');
  });

  it('forum subscription and unsubscribing from a discussion', async () => {
    await run(f.users.student2!, 'subscribe', { subscribed: true });
    await run(f.users.student1!, 'subscribe', {
      discussionId: d1.discussionId,
      subscribed: false,
    });
    const ctx = buildModuleCtx(await as(f.users.teacher!));
    const subs = await subscribers(ctx, await forumRef(), { id: d1.discussionId, groupId: null });
    expect(subs).toContain(f.users.student2);
    expect(subs).toContain(f.users.teacher);
    expect(subs).not.toContain(f.users.student1);
  });

  it('private replies are visible to the recipient and moderators only', async () => {
    const r = await run<{ postId: string }>(f.users.teacher!, 'reply', {
      postId: d1.postId,
      message: '<p>Лично вам</p>',
      private: true,
    });
    const post = await t.db.forumPost.findUniqueOrThrow({ where: { id: r.postId } });
    expect(post.privateToUserId).toBe(f.users.student1);
    expect(postVisible(post, f.users.student1!, false)).toBe(true);
    expect(postVisible(post, f.users.student2!, false)).toBe(false);
    expect(postVisible(post, f.users.student2!, true)).toBe(true);
    // only the recipient is notified
    expect(await notified(f.users.student2!)).toBe(0);
    await expect(
      run(f.users.student2!, 'reply', { postId: d1.postId, message: '<p>x</p>', private: true }),
    ).rejects.toThrow('Private replies are not allowed');
    await expect(
      run(f.users.student2!, 'reply', { postId: r.postId, message: '<p>x</p>' }),
    ).rejects.toThrow('Post not found');
  });

  it('locked discussions reject student replies; moderators pin and lock', async () => {
    await expect(
      run(f.users.student2!, 'moderate', { discussionId: d1.discussionId, locked: true }),
    ).rejects.toThrow();
    await run(f.users.teacher!, 'moderate', {
      discussionId: d1.discussionId,
      locked: true,
      pinned: true,
    });
    await expect(
      run(f.users.student2!, 'reply', { postId: d1.postId, message: '<p>Можно?</p>' }),
    ).rejects.toThrow('locked');
    await run(f.users.teacher!, 'moderate', { discussionId: d1.discussionId, locked: false });
  });

  it('authors edit within the time window; deleting the first post removes the discussion', async () => {
    const r = await run<{ postId: string }>(f.users.student2!, 'reply', {
      postId: d1.postId,
      message: '<p>Опечатка</p>',
    });
    await run(f.users.student2!, 'editPost', { postId: r.postId, message: '<p>Исправлено</p>' });
    await expect(
      run(f.users.student3!, 'editPost', { postId: r.postId, message: '<p>x</p>' }),
    ).rejects.toThrow();
    const late = await as(f.users.student2!);
    late.now = new Date(Date.now() + 31 * 60_000);
    await expect(
      runModuleAction(late, forumId, 'editPost', { postId: r.postId, message: '<p>x</p>' }),
    ).rejects.toThrow('no longer edit');
    await run(f.users.student2!, 'deletePost', { postId: r.postId });
    expect(
      (await t.db.forumPost.findUniqueOrThrow({ where: { id: r.postId } })).deletedAt,
    ).not.toBe(null);
    const d2 = await run<Started>(f.users.student3!, 'startDiscussion', {
      title: 'Удалю',
      message: '<p>Тест</p>',
    });
    await run(f.users.student3!, 'deletePost', { postId: d2.postId });
    expect(await t.db.forumDiscussion.count({ where: { id: d2.discussionId } })).toBe(0);
  });

  it('Q&A: only teachers ask; students see replies after answering', async () => {
    const { id } = await f.addActivity('forum', 'Вопрос-ответ', { type: 'qanda' });
    const q = await runModuleAction(await as(f.users.teacher!), id, 'startDiscussion', {
      title: 'Что такое список?',
      message: '<p>Объясните</p>',
    });
    await expect(
      runModuleAction(await as(f.users.student1!), id, 'startDiscussion', {
        title: 'x',
        message: '<p>x</p>',
      }),
    ).rejects.toThrow('Only teachers');
    const { postId, discussionId } = q as Started;
    await runModuleAction(await as(f.users.student1!), id, 'reply', {
      postId,
      message: '<p>Изменяемая последовательность</p>',
    });
    const { activity } = await getActivityAccess(await as(f.users.teacher!), id);
    const ref = toActivityRef(activity) as never;
    expect(
      await qandaLocked(
        buildModuleCtx(await as(f.users.student1!)),
        ref,
        discussionId,
        f.users.student1!,
      ),
    ).toBe(false);
    expect(
      await qandaLocked(
        buildModuleCtx(await as(f.users.student2!)),
        ref,
        discussionId,
        f.users.student2!,
      ),
    ).toBe(true);
    expect(
      await qandaLocked(
        buildModuleCtx(await as(f.users.teacher!)),
        ref,
        discussionId,
        f.users.teacher!,
      ),
    ).toBe(false);
  });

  it('separate groups hide other groups’ discussions', async () => {
    const sys = await ctxFor(t.db, 'system');
    const { id: g1 } = await createGroup.run(sys, { courseId: f.courseId, name: 'A' });
    const { id: g2 } = await createGroup.run(sys, { courseId: f.courseId, name: 'B' });
    await setGroupMembers.run(sys, { groupId: g1, add: [f.users.student1!] });
    await setGroupMembers.run(sys, { groupId: g2, add: [f.users.student2!] });
    const { id } = await f.addActivity('forum', 'Группы', {}, { groupMode: 'SEPARATE' });
    const d = (await runModuleAction(await as(f.users.student1!), id, 'startDiscussion', {
      title: 'Только для A',
      message: '<p>a</p>',
    })) as Started;
    const disc = await t.db.forumDiscussion.findUniqueOrThrow({ where: { id: d.discussionId } });
    expect(disc.groupId).toBe(g1);
    const { activity } = await getActivityAccess(await as(f.users.teacher!), id);
    const ref = toActivityRef(activity) as never;
    expect(
      await canSeeDiscussion(
        buildModuleCtx(await as(f.users.student2!)),
        ref,
        disc,
        f.users.student2!,
      ),
    ).toBe(false);
    expect(
      await canSeeDiscussion(
        buildModuleCtx(await as(f.users.teacher!)),
        ref,
        disc,
        f.users.teacher!,
      ),
    ).toBe(true);
    await expect(
      runModuleAction(await as(f.users.student2!), id, 'reply', {
        postId: d.postId,
        message: '<p>b</p>',
      }),
    ).rejects.toThrow('Discussion not found');
  });

  it('forced subscription notifies every participant', async () => {
    await updateActivity.run(await as(f.users.teacher!), {
      id: forumId,
      name: 'Обсуждения',
      settings: { subscription: 'forced' },
    });
    const before = await notified(f.users.student3!);
    await run(f.users.teacher!, 'startDiscussion', { title: 'Важно', message: '<p>Всем</p>' });
    expect(await notified(f.users.student3!)).toBe(before + 1);
  });
});
