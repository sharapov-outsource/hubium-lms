import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Forum ratings: who may rate which post, the aggregate on the post and in the gradebook,
// and the grade following deleted posts and new settings. And grading the whole forum.

type Started = { discussionId: string; postId: string };
type Post = {
  id: string;
  rating: {
    aggregate: number | null;
    count: number;
    mine: number | null;
    canRate: boolean;
    raters: { name: string; value: number }[];
  } | null;
};

describe('forum: ratings and whole-forum grading', () => {
  const t = useTestDb();

  async function setup(code: string, settings: Record<string, unknown>) {
    const f = await courseFixture(t.db, code);
    const { id } = await f.addActivity('forum', 'Обсуждения', settings);
    const [teacher, s1, s2] = await Promise.all(
      [f.users.teacher!, f.users.student1!, f.users.student2!].map((u) => ctxFor(t.db, u)),
    );
    const d = (await runModuleAction(s1!, id, 'startDiscussion', {
      title: 'Тема',
      message: '<p>Первый пост</p>',
    })) as Started;
    const reply = (await runModuleAction(s1!, id, 'reply', {
      postId: d.postId,
      message: '<p>Ещё мысль</p>',
    })) as { postId: string };
    return { f, id, teacher: teacher!, s1: s1!, s2: s2!, d, reply };
  }
  const gradeOf = async (activityId: string, itemNumber: number, userId: string) => {
    const item = await t.db.gradeItem.findFirst({ where: { activityId, itemNumber } });
    if (!item) return 'no item';
    const g = await t.db.grade.findUnique({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId } },
    });
    return g?.finalGrade === null || g?.finalGrade === undefined ? null : Number(g.finalGrade);
  };
  const posts = async (ctx: Awaited<ReturnType<typeof ctxFor>>, id: string, discussionId: string) =>
    ((await runModuleQuery(ctx, id, 'discussion', { discussionId })) as { posts: Post[] }).posts;

  it('teachers rate posts; the average of a student’s ratings is the grade', async () => {
    const { f, id, teacher, s1, s2, d, reply } = await setup('FRT1', {
      ratingAggregate: 'average',
      ratingMax: 10,
    });
    const student = f.users.student1!;
    await runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 6 });
    await runModuleAction(teacher, id, 'rate', { postId: reply.postId, value: 9 });
    expect(await gradeOf(id, 0, student)).toBe(7.5);
    // the post shows its aggregate; the teacher sees who rated what
    const [first] = await posts(teacher, id, d.discussionId);
    expect(first!.rating).toMatchObject({ aggregate: 6, count: 1, mine: 6, canRate: true });
    expect(first!.rating!.raters).toHaveLength(1);
    // the author sees the aggregate of their posts but cannot rate them; nor who rated
    const [own] = await posts(s1, id, d.discussionId);
    expect(own!.rating).toMatchObject({ aggregate: 6, canRate: false, raters: [] });
    await expect(
      runModuleAction(s1, id, 'rate', { postId: d.postId, value: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // without peer rating students do not rate
    await expect(
      runModuleAction(s2, id, 'rate', { postId: d.postId, value: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ratings stay within 0..max
    await expect(
      runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 11 }),
    ).rejects.toThrow(/0 to 10/);
    // a deleted post's ratings no longer count
    await runModuleAction(teacher, id, 'deletePost', { postId: reply.postId });
    expect(await gradeOf(id, 0, student)).toBe(6);
    // a rating taken back: no ratings, no grade
    await runModuleAction(teacher, id, 'rate', { postId: d.postId, value: null });
    expect(await gradeOf(id, 0, student)).toBeNull();
  });

  it('peer rating, the rating window and new settings', async () => {
    const { f, id, teacher, s2, d, reply } = await setup('FRT2', {
      ratingAggregate: 'sum',
      ratingMax: 5,
      allowPeerRating: true,
    });
    const student = f.users.student1!;
    await runModuleAction(s2, id, 'rate', { postId: d.postId, value: 4 });
    await runModuleAction(teacher, id, 'rate', { postId: reply.postId, value: 3 });
    // the sum (7) stops at the maximum
    expect(await gradeOf(id, 0, student)).toBe(5);
    // the count instead: two ratings
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const settings = act.settings as Record<string, unknown>;
    await updateActivity.run(teacher, {
      id,
      name: act.name,
      settings: { ...settings, ratingAggregate: 'count' },
    });
    expect(await gradeOf(id, 0, student)).toBe(2);
    // a window that ended before the posts: they cannot be rated, and do not count
    await updateActivity.run(teacher, {
      id,
      name: act.name,
      settings: {
        ...settings,
        ratingAggregate: 'count',
        ratingFrom: '2020-01-01T00:00:00.000Z',
        ratingTo: '2020-12-31T00:00:00.000Z',
      },
    });
    expect(await gradeOf(id, 0, student)).toBeNull();
    await expect(
      runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ratings off: their gradebook item goes
    await updateActivity.run(teacher, {
      id,
      name: act.name,
      settings: { ...settings, ratingAggregate: 'none' },
    });
    expect(await gradeOf(id, 0, student)).toBe('no item');
    await expect(
      runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('ratings on a scale', async () => {
    const scale = await t.db.scale.create({
      data: { courseId: null, name: 'Качество поста', items: ['Слабо', 'Хорошо', 'Отлично'] },
    });
    const { f, id, teacher, d, reply } = await setup('FRT3', {
      ratingAggregate: 'average',
      ratingScaleId: scale.id,
    });
    await runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 2 });
    await runModuleAction(teacher, id, 'rate', { postId: reply.postId, value: 3 });
    // 2.5 rounds to the third grade of the scale
    expect(await gradeOf(id, 0, f.users.student1!)).toBe(3);
    await expect(
      runModuleAction(teacher, id, 'rate', { postId: d.postId, value: 0 }),
    ).rejects.toThrow(/1 to 3/);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: id } });
    expect(item).toMatchObject({ gradeType: 'SCALE', scaleId: scale.id });
  });

  it('teachers grade the whole forum; the student sees the grade and feedback', async () => {
    const { f, id, teacher, s1, s2 } = await setup('FRT4', {
      wholeForumGrading: true,
      gradeMax: 20,
      ratingAggregate: 'average',
    });
    const student = f.users.student1!;
    // both items, named for what they hold
    const items = await t.db.gradeItem.findMany({
      where: { activityId: id },
      orderBy: { itemNumber: 'asc' },
    });
    expect(items.map((i) => i.name)).toEqual(['Обсуждения: Рейтинги', 'Обсуждения: Весь форум']);
    const { posts: list } = (await runModuleQuery(teacher, id, 'userPosts', {
      userId: student,
    })) as { posts: { contentHtml: string }[] };
    expect(list).toHaveLength(2);
    await runModuleAction(teacher, id, 'gradeUser', {
      userId: student,
      grade: 17,
      feedback: '<p>Активно участвовали</p><script>x</script>',
    });
    expect(await gradeOf(id, 1, student)).toBe(17);
    const mine = (await runModuleQuery(s1, id, 'discussions', {})) as {
      myGrade: { grade: number; feedback: string } | null;
      canGrade: boolean;
    };
    expect(mine.myGrade).toMatchObject({ grade: 17 });
    expect(mine.myGrade!.feedback).not.toContain('script');
    expect(mine.canGrade).toBe(false);
    expect(
      await t.db.notification.count({
        where: { userId: student, type: 'forum.graded', contextId: id },
      }),
    ).toBe(1);
    // students neither grade nor see others' posts listed for grading
    await expect(
      runModuleAction(s2, id, 'gradeUser', { userId: student, grade: 20 }),
    ).rejects.toThrow();
    await expect(runModuleQuery(s2, id, 'userPosts', { userId: student })).rejects.toThrow();
    await expect(
      runModuleAction(teacher, id, 'gradeUser', { userId: student, grade: 21 }),
    ).rejects.toThrow(/between 0 and 20/);
    // whole-forum grading off: its item goes, ratings stay
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    await updateActivity.run(teacher, {
      id,
      name: act.name,
      settings: { ...(act.settings as object), wholeForumGrading: false },
    });
    expect(await gradeOf(id, 1, student)).toBe('no item');
    expect(await t.db.gradeItem.count({ where: { activityId: id } })).toBe(1);
  });
});
