import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { type AppError, ForbiddenError, NotFoundError } from '../errors.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import { importGift } from '../questions/bank.ts';
import { setSettings } from '../settings/settings.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

// Module queries (GET /api/v1/activities/{id}/queries/{name}) keep the rules of the web
// pages: private replies, Q&A locks, separate groups, quiz review settings, own data only.

const GIFT = `
::Q1:: 2 + 2 = ? {=4 ~3 ~5}

::Q2:: Земля круглая {T}
`;

type Posts = { posts: { id: string; contentHtml: string; privateToUserId: string | null }[] };

describe('module queries', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  const as = (id: string) => ctxFor(t.db, id);
  const query = async <T>(user: string, id: string, name: string, input: object = {}) =>
    (await runModuleQuery(await as(user), id, name, input)) as T;
  const act = async <T>(user: string, id: string, name: string, input: object) =>
    (await runModuleAction(await as(user), id, name, input)) as T;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'QUERIES');
  });

  it('forum: private replies stay private and reading marks nothing as read', async () => {
    const { id } = await f.addActivity('forum', 'Форум', {});
    const d = await act<{ discussionId: string; postId: string }>(
      f.users.student1!,
      id,
      'startDiscussion',
      { title: 'Вопрос', message: '<p>Как сдавать?</p>' },
    );
    await act(f.users.teacher!, id, 'reply', {
      postId: d.postId,
      message: '<p>Лично вам</p>',
      private: true,
    });
    const reads = await t.db.forumReadState.count();
    const of = (r: Posts) => r.posts.map((p) => p.contentHtml);
    const own = await query<Posts>(f.users.student1!, id, 'discussion', {
      discussionId: d.discussionId,
    });
    expect(of(own)).toEqual(['<p>Как сдавать?</p>', '<p>Лично вам</p>']);
    const other = await query<Posts>(f.users.student2!, id, 'discussion', {
      discussionId: d.discussionId,
    });
    expect(of(other)).toEqual(['<p>Как сдавать?</p>']);
    expect(
      (await query<Posts>(f.users.teacher!, id, 'discussion', { discussionId: d.discussionId }))
        .posts,
    ).toHaveLength(2);
    expect(await t.db.forumReadState.count()).toBe(reads);

    // the private reply is not unread for the other student
    const list = await query<{ total: number; items: { unread: number; replies: number }[] }>(
      f.users.student2!,
      id,
      'discussions',
      { page: '1', pageSize: '10' },
    );
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ unread: 1, replies: 1 });

    await expect(
      runModuleQuery(await as(f.users.student1!), id, 'discussion', {
        discussionId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      runModuleQuery(await as(f.users.student1!), id, 'nope', {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forum: Q&A hides other answers until the student answers', async () => {
    const { id } = await f.addActivity('forum', 'Вопрос-ответ', { type: 'qanda' });
    const q = await act<{ discussionId: string; postId: string }>(
      f.users.teacher!,
      id,
      'startDiscussion',
      { title: 'Что такое список?', message: '<p>Объясните</p>' },
    );
    await act(f.users.student1!, id, 'reply', { postId: q.postId, message: '<p>Ответ 1</p>' });
    const before = await query<Posts & { qandaLocked: boolean }>(
      f.users.student2!,
      id,
      'discussion',
      { discussionId: q.discussionId },
    );
    expect(before.qandaLocked).toBe(true);
    expect(before.posts.map((p) => p.contentHtml)).toEqual(['<p>Объясните</p>']);
    await act(f.users.student2!, id, 'reply', { postId: q.postId, message: '<p>Ответ 2</p>' });
    const after = await query<Posts & { qandaLocked: boolean }>(
      f.users.student2!,
      id,
      'discussion',
      { discussionId: q.discussionId },
    );
    expect(after.qandaLocked).toBe(false);
    expect(after.posts).toHaveLength(3);
  });

  it('forum: separate groups do not see each other’s discussions', async () => {
    const teacher = await as(f.users.teacher!);
    const { id: groupA } = await createGroup.run(teacher, { courseId: f.courseId, name: 'A' });
    const { id: groupB } = await createGroup.run(teacher, { courseId: f.courseId, name: 'B' });
    await setGroupMembers.run(teacher, { groupId: groupA, add: [f.users.student1!] });
    await setGroupMembers.run(teacher, { groupId: groupB, add: [f.users.student2!] });
    const { id } = await f.addActivity('forum', 'Группы', {}, { groupMode: 'SEPARATE' });
    const d = await act<{ discussionId: string }>(f.users.student1!, id, 'startDiscussion', {
      title: 'Только для A',
      message: '<p>a</p>',
      groupId: groupA,
    });
    const list = await query<{ total: number }>(f.users.student2!, id, 'discussions');
    expect(list.total).toBe(0);
    await expect(
      runModuleQuery(await as(f.users.student2!), id, 'discussion', {
        discussionId: d.discussionId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await query<{ total: number }>(f.users.teacher!, id, 'discussions')).total).toBe(1);
  });

  it('quiz: attempt questions carry no answers; review follows the quiz settings', async () => {
    const teacher = await as(f.users.teacher!);
    await importGift.run(teacher, { courseId: f.courseId, gift: GIFT });
    const qs = await t.db.question.findMany({ where: { category: { contextId: f.courseId } } });
    const { id } = await f.addActivity('quiz', 'Без ответов', {
      attempts: 0,
      gradeMax: 10,
      reviewAnswers: 'never',
      reviewMarks: false,
    });
    await act(f.users.teacher!, id, 'addQuestions', { questionIds: qs.map((q) => q.id) });

    const { attemptId } = await act<{ attemptId: string }>(f.users.student1!, id, 'start', {});
    const overview = await query<{ inProgressAttemptId: string; attemptsLeft: null }>(
      f.users.student1!,
      id,
      'overview',
    );
    expect(overview).toMatchObject({ inProgressAttemptId: attemptId, attemptsLeft: null });
    const attempt = await query<{ questions: { type: string }[] }>(
      f.users.student1!,
      id,
      'attempt',
      { attemptId },
    );
    expect(attempt.questions).toHaveLength(2);
    expect(JSON.stringify(attempt)).not.toMatch(/fraction|feedback/);
    // not someone else's attempt, and no review while it is open
    await expect(
      runModuleQuery(await as(f.users.student2!), id, 'attempt', { attemptId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      runModuleQuery(await as(f.users.student1!), id, 'review', { attemptId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await act(f.users.student1!, id, 'finish', { attemptId, answers: { 2: { value: true } } });
    await expect(
      runModuleQuery(await as(f.users.student1!), id, 'attempt', { attemptId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    type Review = {
      showAnswers: boolean;
      showMarks: boolean;
      grade: number | null;
      attempt: { userName: string | null };
      questions: {
        verdict: string | null;
        mark: number | null;
        correctResponse: unknown;
        generalFeedback: string | null;
      }[];
    };
    const mine = await query<Review>(f.users.student1!, id, 'review', { attemptId });
    expect(mine).toMatchObject({ showAnswers: false, showMarks: false, grade: null });
    expect(mine.attempt.userName).toBeNull();
    for (const q of mine.questions)
      expect(q).toMatchObject({ verdict: null, mark: null, correctResponse: null });
    const theirs = await query<Review>(f.users.teacher!, id, 'review', { attemptId });
    expect(theirs).toMatchObject({ showAnswers: true, showMarks: true });
    expect(theirs.attempt.userName).toBeTruthy();
    expect(theirs.questions.some((q) => q.correctResponse !== null)).toBe(true);
    await expect(
      runModuleQuery(await as(f.users.student2!), id, 'review', { attemptId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('assignment: the status shows the submission, the grade and what can be done next', async () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const { id } = await f.addActivity('assign', 'Эссе', { dueAt: due, gradeMax: 10 });
    type Status = {
      status: string;
      editable: boolean;
      canWithdraw: boolean;
      dates: { extended: boolean };
      submission: { onlineText: string; files: { size: number }[] } | null;
      grade: { value: number | null; feedback: string; graderName: string | null } | null;
    };
    expect(await query<Status>(f.users.student1!, id, 'status')).toMatchObject({
      status: 'NEW',
      editable: true,
      submission: null,
      grade: null,
    });
    await act(f.users.student1!, id, 'saveSubmission', {
      text: '<p>Моё эссе</p>',
      files: [{ name: 'essay.txt', mimeType: 'text/plain', data: Buffer.from('текст') }],
      submit: true,
    });
    const submitted = await query<Status>(f.users.student1!, id, 'status');
    expect(submitted).toMatchObject({ status: 'SUBMITTED', editable: false, canWithdraw: true });
    expect(submitted.submission?.onlineText).toBe('<p>Моё эссе</p>');
    expect(submitted.submission?.files).toHaveLength(1);
    await act(f.users.teacher!, id, 'grade', {
      userId: f.users.student1!,
      grade: 8,
      feedback: '<p>Хорошо</p>',
    });
    await act(f.users.teacher!, id, 'extend', {
      userId: f.users.student1!,
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const graded = await query<Status>(f.users.student1!, id, 'status');
    expect(graded).toMatchObject({ canWithdraw: false, dates: { extended: true } });
    expect(graded.grade).toMatchObject({ value: 8, feedback: '<p>Хорошо</p>' });
    expect(graded.grade?.graderName).toBeTruthy();
    // another student sees their own (empty) status, not this one
    expect((await query<Status>(f.users.student2!, id, 'status')).submission).toBeNull();
  });

  it('a turned-off activity type answers 403', async () => {
    const { id } = await f.addActivity('forum', 'Выключенный', {});
    await setSettings(t.db, { 'modules.disabled': ['forum'] });
    try {
      const err = await runModuleQuery(await as(f.users.student1!), id, 'discussions', {}).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as AppError).message).toMatch(/turned off/);
    } finally {
      await setSettings(t.db, { 'modules.disabled': [] });
    }
  });
});
