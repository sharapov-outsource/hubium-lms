import {
  addUserRelation,
  createApiToken,
  createGroup,
  createGrouping,
  createManualItem,
  overrideGrade,
  revokeApiToken,
  saveCourseField,
  saveGradeCategory,
  saveProfileField,
  saveScale,
  setActivityVisibility,
  setGroupingGroups,
  setSettings,
} from '@hubium/core';
import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { validate } from '@scalar/openapi-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/index.ts';

describe('REST API v1', () => {
  const t = useTestDb();
  let api: ReturnType<typeof createApi>;
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let tokens: Record<string, string>;
  let pageId: string;
  let hiddenId: string;
  let assignId: string;

  const call = (token: string | null, path: string, init: RequestInit = {}) =>
    api.request(`/api/v1${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });

  const mint = async (
    who: string,
    scopes: ('read' | 'write')[] = ['read', 'write'],
    days: number | null = 30,
  ) =>
    (
      await createApiToken(await ctxFor(t.db, who), {
        name: `t-${who}`,
        scopes,
        expiresInDays: days,
      })
    ).token;

  beforeAll(async () => {
    api = createApi({ db: t.db, origin: 'https://lms.test' });
    f = await courseFixture(t.db, 'API1');
    pageId = (await f.addActivity('page', 'Введение', { content: '<p>Hi</p>' })).id;
    hiddenId = (await f.addActivity('page', 'Скрыто', { content: '<p>x</p>' })).id;
    assignId = (await f.addActivity('assign', 'Эссе', { gradeMax: 10, onlineText: true })).id;
    const sys = await ctxFor(t.db, 'system');
    await setActivityVisibility.run(sys, { id: hiddenId, visibility: 'HIDDEN' });
    tokens = {
      admin: await mint('admin@test.local'),
      teacher: await mint(f.users.teacher!),
      student: await mint(f.users.student1!),
      readonly: await mint(f.users.student2!, ['read']),
    };
  });

  it('rejects missing, unknown, revoked and expired tokens', async () => {
    // every documented route but the spec itself, whatever the method
    const spec = (await (await api.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const uuid = '00000000-0000-7000-8000-000000000000';
    for (const [path, ops] of Object.entries(spec.paths))
      for (const method of Object.keys(ops)) {
        const url = path.replace(/\{[^}]+\}/g, uuid);
        const r = await api.request(url, { method: method.toUpperCase() });
        expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 401`);
      }
    expect((await call(null, '/me')).status).toBe(401);
    expect((await call('hub_nope', '/me')).status).toBe(401);
    const ctx = await ctxFor(t.db, f.users.student3!);
    const temp = await createApiToken(ctx, { name: 'temp', scopes: ['read'] });
    expect((await call(temp.token, '/me')).status).toBe(200);
    await revokeApiToken(ctx, temp.id);
    expect((await call(temp.token, '/me')).status).toBe(401);
    const old = await createApiToken(ctx, { name: 'old', scopes: ['read'], expiresInDays: 1 });
    await t.db.apiToken.update({
      where: { id: old.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call(old.token, '/me')).status).toBe(401);
    // the secret is never stored
    const row = await t.db.apiToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.tokenHash).not.toContain(old.token.slice(4));
  });

  it('returns the token owner and records last use', async () => {
    const r = await call(tokens.student!, '/me');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: f.users.student1, isSiteAdmin: false });
    const row = await t.db.apiToken.findFirstOrThrow({ where: { userId: f.users.student1 } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('enforces scopes and capabilities', async () => {
    const send = { method: 'POST', body: JSON.stringify({ ids: [] }) };
    expect((await call(tokens.readonly!, '/notifications/read', send)).status).toBe(403);
    expect((await call(tokens.student!, '/notifications/read', send)).status).toBe(200);
    expect((await call(tokens.student!, '/users')).status).toBe(403);
    const users = await call(tokens.admin!, '/users?q=student');
    expect(users.status).toBe(200);
    const body = (await users.json()) as { items: { username: string }[]; total: number };
    expect(body.items.some((u) => u.username === 'student1')).toBe(true);
    expect(body.items[0]).not.toHaveProperty('passwordHash');
  });

  it('creates users with custom profile fields and returns them', async () => {
    await saveProfileField.run(await ctxFor(t.db, 'admin@test.local'), {
      shortName: 'employee_no',
      name: { ru: 'Табельный номер' },
      type: 'text',
    });
    const body = (customFields: Record<string, unknown>) => ({
      method: 'POST',
      body: JSON.stringify({
        username: `api${Object.keys(customFields).length}`,
        email: `api${Object.keys(customFields).length}@example.org`,
        firstName: 'Api',
        lastName: 'User',
        password: 'Secret12345!',
        customFields,
      }),
    });
    const created = await call(tokens.admin!, '/users', body({ employee_no: 'A-17' }));
    expect(created.status).toBe(201);
    const users = (await (await call(tokens.admin!, '/users?q=api1')).json()) as {
      items: { customFields: Record<string, unknown> }[];
    };
    expect(users.items[0]?.customFields).toEqual({ employee_no: 'A-17' });
    const me = (await (await call(tokens.student!, '/me')).json()) as Record<string, unknown>;
    expect(me.customFields).toEqual({});

    // an account without an email: the internal placeholder address is never shown
    const pupil = await call(tokens.admin!, '/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'pupil7',
        firstName: 'Pupil',
        lastName: 'Seven',
        password: 'Secret12345!',
        locale: 'en',
      }),
    });
    expect(pupil.status).toBe(201);
    const { id } = (await pupil.json()) as { id: string };
    const pupilMe = (await (await call(await mint(id), '/me')).json()) as Record<string, unknown>;
    expect(pupilMe).toMatchObject({ username: 'pupil7', email: null, locale: 'en' });
    const taken = await call(tokens.admin!, '/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'pupil7',
        firstName: 'P',
        lastName: 'S',
        password: 'x'.repeat(9),
      }),
    });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toMatchObject({ fieldErrors: { username: ['Username taken'] } });
  });

  it('lists courses and contents without hidden activities', async () => {
    const list = (await (await call(tokens.student!, '/courses')).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((c) => c.id)).toContain(f.courseId);
    const r = await call(tokens.student!, `/courses/${f.courseId}/contents`);
    const { sections } = (await r.json()) as {
      sections: { parentId: string | null; activities: { id: string; url: string }[] }[];
    };
    expect(sections.every((s) => s.parentId === null)).toBe(true);
    const ids = sections.flatMap((s) => s.activities.map((a) => a.id));
    expect(ids).toContain(pageId);
    expect(ids).not.toContain(hiddenId);
    expect(sections.flatMap((s) => s.activities)[0]!.url).toMatch(/^https:\/\/lms\.test\/course\//);
    const teacher = await call(tokens.teacher!, `/courses/${f.courseId}/contents`);
    expect(JSON.stringify(await teacher.json())).toContain(hiddenId);
    // activity details: hidden → 404 for students
    expect((await call(tokens.student!, `/activities/${hiddenId}`)).status).toBe(404);
    const a = (await (await call(tokens.student!, `/activities/${assignId}`)).json()) as {
      settings: object;
      available: boolean;
    };
    expect(a.settings).toEqual({});
    expect(a.available).toBe(true);
    // unknown course
    expect(
      (await call(tokens.student!, '/courses/00000000-0000-7000-8000-000000000000')).status,
    ).toBe(404);
  });

  it('enrols users, lists participants and groups', async () => {
    const u = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    const student = await t.db.role.findFirstOrThrow({ where: { shortName: 'student' } });
    const body = JSON.stringify({ userIds: [u.id], roleId: student.id });
    expect(
      (await call(tokens.student!, `/courses/${f.courseId}/enrolments`, { method: 'POST', body }))
        .status,
    ).toBe(403);
    const r = await call(tokens.teacher!, `/courses/${f.courseId}/enrolments`, {
      method: 'POST',
      body,
    });
    expect(r.status).toBe(200);
    const list = (await (
      await call(tokens.teacher!, `/courses/${f.courseId}/enrolments?q=manager`)
    ).json()) as {
      items: { userId: string; roles: string[] }[];
    };
    expect(list.items).toEqual([expect.objectContaining({ userId: u.id, roles: ['student'] })]);
    expect((await call(tokens.teacher!, `/courses/${f.courseId}/groups`)).status).toBe(200);
  });

  it('runs module actions and validates input', async () => {
    const r = await call(tokens.student!, `/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      body: JSON.stringify({ text: '<p>Моё эссе</p>', submit: true }),
    });
    expect(r.status).toBe(200);
    const sub = await t.db.assignSubmission.findFirstOrThrow({
      where: { activityId: assignId, userId: f.users.student1 },
    });
    expect(sub.status).toBe('SUBMITTED');
    // a module's own refusal is a bad request with its message, not an internal error
    const again = await call(tokens.student!, `/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      body: JSON.stringify({ text: '<p>Ещё</p>', submit: true }),
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'BAD_REQUEST', message: 'Already submitted' });
    // teacher can't submit (capability)
    const denied = await call(tokens.teacher!, `/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }),
    });
    expect(denied.status).toBe(403);
    const bad = await call(tokens.student!, '/calendar/events?from=yesterday&to=x');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      code: 'VALIDATION',
      fieldErrors: { from: expect.any(Array) },
    });
    const now = Date.now();
    const ev = await call(
      tokens.student!,
      `/calendar/events?from=${new Date(now - 86_400_000).toISOString()}&to=${new Date(now + 30 * 86_400_000).toISOString()}`,
    );
    expect(ev.status).toBe(200);
  });

  it('reads module data with a read-only token', async () => {
    const forumId = (await f.addActivity('forum', 'Обсуждения', {})).id;
    const start = await call(tokens.student!, `/activities/${forumId}/actions/startDiscussion`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Привет', message: '<p>Всем привет</p>' }),
    });
    expect(start.status).toBe(200);
    const list = await call(
      tokens.readonly!,
      `/activities/${forumId}/queries/discussions?pageSize=5`,
    );
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as {
      data: { total: number; pageSize: number; items: { id: string; lastPostAt: string }[] };
    };
    expect(data).toMatchObject({ total: 1, pageSize: 5 });
    expect(data.items[0]!.lastPostAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const one = await call(
      tokens.readonly!,
      `/activities/${forumId}/queries/discussion?discussionId=${data.items[0]!.id}`,
    );
    expect(((await one.json()) as { data: { posts: unknown[] } }).data.posts).toHaveLength(1);
    // the status of someone else's submission is never theirs to read, and errors keep shape
    const status = await call(tokens.readonly!, `/activities/${assignId}/queries/status`);
    expect(((await status.json()) as { data: { submission: null } }).data.submission).toBeNull();
    const missing = await call(
      tokens.readonly!,
      `/activities/${forumId}/queries/discussion?discussionId=00000000-0000-7000-8000-000000000000`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    const invalid = await call(
      tokens.readonly!,
      `/activities/${forumId}/queries/discussions?page=0`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'VALIDATION' });
    expect((await call(tokens.readonly!, `/activities/${forumId}/queries/nope`)).status).toBe(404);
    // a read-only token still cannot run actions
    const write = await call(tokens.readonly!, `/activities/${forumId}/actions/markRead`, {
      method: 'POST',
      body: JSON.stringify({ discussionId: data.items[0]!.id }),
    });
    expect(write.status).toBe(403);
  });

  it('returns action results with file sizes', async () => {
    const forumId = (await f.addActivity('forum', 'С файлами', {})).id;
    const form = new FormData();
    form.set('input', JSON.stringify({ title: 'Файл', message: '<p>См. вложение</p>' }));
    form.append('files', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    const r = await api.request(`/api/v1/activities/${forumId}/actions/startDiscussion`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.student!}` },
      body: form,
    });
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as { data: { discussionId: string } };
    const read = await call(
      tokens.student!,
      `/activities/${forumId}/queries/discussion?discussionId=${data.discussionId}`,
    );
    const post = (
      (await read.json()) as {
        data: { posts: { attachments: { name: string; size: number }[] }[] };
      }
    ).data.posts[0]!;
    expect(post.attachments).toEqual([expect.objectContaining({ name: 'hello.txt', size: 5 })]);
  });

  it('takes files as multipart parts and as resumable uploads', async () => {
    const token = await mint(f.users.student3!);
    const form = new FormData();
    form.set('input', JSON.stringify({ text: '<p>См. файл</p>', submit: true }));
    form.append('files', new File(['ответ'], 'answer.txt', { type: 'text/plain' }));
    const r = await api.request(`/api/v1/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(r.status).toBe(200);
    const sub = await t.db.assignSubmission.findFirstOrThrow({
      where: { activityId: assignId, userId: f.users.student3 },
    });
    expect(sub.status).toBe('SUBMITTED');
    const files = await t.db.file.findMany({ where: { area: 'submission', itemId: sub.id } });
    expect(files.map((x) => x.name)).toEqual(['answer.txt']);

    // broken bodies are the client's fault
    const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const broken = await api.request(`/api/v1/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      headers: json,
      body: '{"text":',
    });
    expect(broken.status).toBe(400);
    const plain = await api.request(`/api/v1/activities/${assignId}/actions/saveSubmission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(plain.status).toBe(415);

    // a large file goes in chunks; a wrong offset answers where to resume
    const started = await call(tokens.teacher!, '/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: 'lecture.mp4', size: 6, mimeType: 'video/mp4' }),
    });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    const chunk = (offset: number, bytes: string) =>
      api.request(`/api/v1/uploads/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${tokens.teacher}`,
          'Content-Type': 'application/octet-stream',
          'Upload-Offset': String(offset),
        },
        body: bytes,
      });
    expect(await (await chunk(0, 'abc')).json()).toEqual({ received: 3 });
    const wrong = await chunk(0, 'def');
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ received: 3 });
    expect((await chunk(3, 'def')).status).toBe(200);
    expect(await (await call(tokens.teacher!, `/uploads/${id}`)).json()).toMatchObject({
      size: 6,
      received: 6,
    });
    expect((await call(tokens.student!, `/uploads/${id}`)).status).toBe(403);
  });

  it('hides other courses, classmates\u2019 emails, and serialises grades', async () => {
    // a course the student is not enrolled in
    const other = await courseFixture(t.db, 'API2');
    await other.addActivity('page', 'Секрет', { content: '<p>x</p>' });
    const outsider = await mint(f.users.student3!);
    await t.db.enrolment.deleteMany({
      where: { courseId: other.courseId, userId: f.users.student3 },
    });
    expect((await call(outsider, `/courses/${other.courseId}/contents`)).status).toBe(404);

    // students see names but not emails, and cannot search by email
    const list = (await (
      await call(tokens.student!, `/courses/${f.courseId}/enrolments`)
    ).json()) as {
      items: { email: string | null }[];
    };
    expect(list.items.length).toBeGreaterThan(1);
    expect(list.items.every((p) => p.email === null)).toBe(true);
    const byEmail = (await (
      await call(tokens.student!, `/courses/${f.courseId}/enrolments?q=hubium.local`)
    ).json()) as { total: number };
    expect(byEmail.total).toBe(0);
    const teacherView = (await (
      await call(tokens.teacher!, `/courses/${f.courseId}/enrolments`)
    ).json()) as {
      items: { email: string | null }[];
    };
    expect(teacherView.items.some((p) => p.email?.includes('@'))).toBe(true);

    // grades come back as arrays, not empty Map objects
    const g = (await (
      await call(tokens.teacher!, `/courses/${f.courseId}/grades?all=1`)
    ).json()) as {
      items: unknown[];
      grades: unknown[];
    };
    expect(Array.isArray(g.items) && g.items.length > 0).toBe(true);
    expect(Array.isArray(g.grades)).toBe(true);
  });

  it('returns course keys and dates, the catalog, groupings and the gradebook tree', async () => {
    const admin = tokens.admin!;
    const sys = await ctxFor(t.db, 'system');
    await saveCourseField.run(sys, {
      shortName: 'hours',
      name: { ru: 'Часы' },
      type: 'text',
    });
    await saveCourseField.run(sys, {
      shortName: 'budget',
      name: { ru: 'Бюджет' },
      type: 'text',
      visible: false,
    });
    const made = await call(admin, '/courses', {
      method: 'POST',
      body: JSON.stringify({
        categoryId: (await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } })).categoryId,
        fullName: 'Термодинамика',
        shortName: 'THERMO-API',
        idNumber: 'HR-4711',
        startDate: '2026-09-01T00:00:00+03:00',
        customFields: { hours: '72', budget: '1000' },
      }),
    });
    expect(made.status).toBe(201);
    const { id: courseId } = (await made.json()) as { id: string };
    expect(await (await call(admin, `/courses/${courseId}`)).json()).toMatchObject({
      idNumber: 'HR-4711',
      startDate: '2026-08-31T21:00:00.000Z',
      endDate: null,
      customFields: { hours: '72', budget: '1000' },
    });
    const mine = (await (await call(tokens.student!, '/courses')).json()) as {
      items: Record<string, unknown>[];
    };
    expect(mine.items[0]).toHaveProperty('categoryId');

    // the catalog finds word forms and never shows enrolment keys
    const found = (await (await call(tokens.student!, '/catalog?q=термодинамики')).json()) as {
      items: { id: string; enrolmentMethods: string[] }[];
      total: number;
    };
    expect(found.items.map((x) => x.id)).toEqual([courseId]);
    expect(JSON.stringify(found)).not.toContain('"key"');
    // a field not marked visible stays with the course's editors
    expect(found.items[0]).toMatchObject({ customFields: { hours: '72' } });
    expect(JSON.stringify(found)).not.toContain('budget');

    // groupings with their groups
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const g = await createGroup.run(teacher, { courseId: f.courseId, name: 'Поток А' });
    const gr = await createGrouping.run(teacher, { courseId: f.courseId, name: 'Лекции' });
    await setGroupingGroups.run(teacher, { groupingId: gr.id, groupIds: [g.id] });
    const groupings = (await (
      await call(tokens.teacher!, `/courses/${f.courseId}/groupings`)
    ).json()) as { items: unknown[] };
    expect(groupings.items).toEqual([
      expect.objectContaining({ name: 'Лекции', groupIds: [g.id], activityCount: 0 }),
    ]);

    // a subcategory and a scale item: the report says how to read them
    const { id: labs } = await saveGradeCategory.run(teacher, {
      courseId: f.courseId,
      name: 'Лабораторные',
      aggregation: 'NATURAL',
    });
    const { id: scaleId } = await saveScale.run(teacher, {
      courseId: f.courseId,
      name: 'Зачёт',
      items: ['Не зачтено', 'Зачтено'],
    });
    const lab = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Лаба 1',
      gradeMax: 10,
      categoryId: labs,
    });
    const pass = await createManualItem.run(teacher, {
      courseId: f.courseId,
      name: 'Допуск',
      scaleId,
    });
    const s1 = f.users.student1!;
    await overrideGrade.run(teacher, { itemId: lab.id, userId: s1, value: 7 });
    await overrideGrade.run(teacher, { itemId: pass.id, userId: s1, value: 2 });
    type Report = {
      categories: { id: string; parentId: string | null }[];
      items: { id: string; gradeType: string; scale: string[] | null }[];
      grades: { userId: string; itemId: string; finalGrade: number | null }[];
      categoryTotals?: { userId: string; categoryId: string; percent: number | null }[];
    };
    const all = (await (
      await call(tokens.teacher!, `/courses/${f.courseId}/grades?all=1`)
    ).json()) as Report;
    expect(all.categories.find((k) => k.id === labs)?.parentId).toEqual(expect.any(String));
    expect(all.items.find((i) => i.id === pass.id)).toMatchObject({
      gradeType: 'SCALE',
      scale: ['Не зачтено', 'Зачтено'],
    });
    expect(all.categoryTotals).toContainEqual({ userId: s1, categoryId: labs, percent: 70 });
    const own = (await (
      await call(tokens.student!, `/courses/${f.courseId}/grades`)
    ).json()) as Report;
    expect(own.categoryTotals).toBeUndefined();
    expect(own.grades).toContainEqual(expect.objectContaining({ itemId: pass.id, finalGrade: 2 }));
  });

  it('lets parents follow their children while mentors are on', async () => {
    type Overview = {
      user: { id: string };
      courses: { id: string; progress: number | null }[];
      todo: { activityId: string; kind: string }[];
    };
    const parent = await mint(f.users.student3!, ['read']);
    const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const report = (await f.addActivity('assign', 'Доклад', { dueAt, onlineText: true })).id;
    await addUserRelation.run(await ctxFor(t.db, 'admin@test.local'), {
      mentorId: f.users.student3!,
      menteeId: f.users.student1!,
      kind: 'PARENT',
    });
    const overview = `/users/${f.users.student1}/overview`;
    expect(await (await call(parent, '/me/mentees')).json()).toEqual({ items: [] });
    expect((await call(parent, overview)).status).toBe(403);
    await setSettings(t.db, { 'mentors.enabled': true });
    try {
      const list = (await (await call(parent, '/me/mentees')).json()) as {
        items: { id: string; kind: string }[];
      };
      expect(list.items).toEqual([
        expect.objectContaining({ id: f.users.student1, kind: 'PARENT' }),
      ]);
      const r = await call(parent, overview);
      expect(r.status).toBe(200);
      const o = (await r.json()) as Overview & { user: { lastAccessAt: string | null } };
      expect(o.user.id).toBe(f.users.student1);
      // student1 has used the API, which counts as a visit
      expect(o.user.lastAccessAt).not.toBeNull();
      expect(o.courses.map((x) => x.id)).toContain(f.courseId);
      // the mentee's deadlines, not the parent's (student1 has already handed in the essay)
      expect(o.todo).toEqual([
        { activityId: report, courseId: f.courseId, title: 'Доклад', kind: 'submit', dueAt },
      ]);
      const grades = await call(parent, `/courses/${f.courseId}/grades?userId=${f.users.student1}`);
      expect(grades.status).toBe(200);
      // nobody else's: not a classmate's, and a teacher sees grades, not the overview
      expect((await call(parent, `/users/${f.users.student2}/overview`)).status).toBe(403);
      expect((await call(tokens.teacher!, overview)).status).toBe(403);
      expect((await call(tokens.student!, overview)).status).toBe(200);
    } finally {
      await setSettings(t.db, { 'mentors.enabled': false });
    }
  });

  it('stops honouring tokens once API access is prohibited', async () => {
    const token = await mint(f.users.student2!, ['read']);
    expect((await call(token, '/me')).status).toBe(200);
    const role = await t.db.role.findFirstOrThrow({ where: { shortName: 'user' } });
    const before = await t.db.roleCapability.findUnique({
      where: { roleId_capability: { roleId: role.id, capability: 'webservice:createtoken' } },
    });
    await t.db.roleCapability.upsert({
      where: { roleId_capability: { roleId: role.id, capability: 'webservice:createtoken' } },
      create: { roleId: role.id, capability: 'webservice:createtoken', permission: 'PROHIBIT' },
      update: { permission: 'PROHIBIT' },
    });
    const { invalidatePermissionCaches } = await import('@hubium/core');
    invalidatePermissionCaches('roles');
    try {
      expect((await call(token, '/me')).status).toBe(401);
    } finally {
      if (before)
        await t.db.roleCapability.update({
          where: { roleId_capability: { roleId: role.id, capability: 'webservice:createtoken' } },
          data: { permission: before.permission },
        });
      invalidatePermissionCaches('roles');
    }
  });

  it('serves no one who has a step to take first, as the site does', async () => {
    const token = await mint(f.users.student2!, ['read']);
    await t.db.user.update({
      where: { id: f.users.student2! },
      data: { mustChangePassword: true },
    });
    try {
      const r = await call(token, '/me');
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'GATE_PASSWORD' });
    } finally {
      await t.db.user.update({
        where: { id: f.users.student2! },
        data: { mustChangePassword: false },
      });
    }
    expect((await call(token, '/me')).status).toBe(200);
  });

  it('manages webhooks for administrators', async () => {
    type Hook = { id: string; secret?: string; enabled: boolean };
    const read = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
    const events = await read<{ items: string[] }>(call(tokens.admin!, '/webhook-events'));
    expect(events.items).toContain('enrolment.created');

    const body = JSON.stringify({
      name: 'HR',
      url: 'https://hr.example.org/hook',
      events: ['user.created', 'enrolment.created'],
    });
    expect((await call(tokens.teacher!, '/webhooks', { method: 'POST', body })).status).toBe(403);
    expect((await call(tokens.readonly!, '/webhooks', { method: 'POST', body })).status).toBe(403);
    const created = await call(tokens.admin!, '/webhooks', { method: 'POST', body });
    expect(created.status).toBe(201);
    const w = await read<Hook>(created);
    expect(w).toMatchObject({
      name: 'HR',
      enabled: true,
      events: ['user.created', 'enrolment.created'],
    });
    expect(w.secret).toMatch(/^whsec_/);

    const one = await read<Hook>(call(tokens.admin!, `/webhooks/${w.id}`));
    expect(one.secret).toBeUndefined();
    const bad = await call(tokens.admin!, `/webhooks/${w.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ url: 'http://10.0.0.5/hook' }),
    });
    expect(bad.status).toBe(400);
    const patched = await call(tokens.admin!, `/webhooks/${w.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(await patched.json()).toMatchObject({ enabled: false });

    const rotated = await read<{ secret: string }>(
      call(tokens.admin!, `/webhooks/${w.id}/rotate-secret`, { method: 'POST' }),
    );
    expect(rotated.secret).not.toBe(w.secret);
    const ping = await read<{ deliveryId: string }>(
      call(tokens.admin!, `/webhooks/${w.id}/ping`, { method: 'POST' }),
    );
    const log = await read<unknown>(call(tokens.admin!, `/webhooks/${w.id}/deliveries`));
    expect(log).toMatchObject({
      total: 1,
      items: [{ id: ping.deliveryId, event: 'ping', status: 'PENDING' }],
    });
    const again = await call(tokens.admin!, `/webhooks/deliveries/${ping.deliveryId}/redeliver`, {
      method: 'POST',
    });
    expect(again.status).toBe(200);

    expect((await call(tokens.admin!, `/webhooks/${w.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(tokens.admin!, `/webhooks/${w.id}`)).status).toBe(404);
  });

  it('rate-limits per token', async () => {
    const small = createApi({ db: t.db, rateLimitPerMinute: 2 });
    const go = () =>
      small.request('/api/v1/me', { headers: { Authorization: `Bearer ${tokens.teacher}` } });
    expect((await go()).status).toBe(200);
    expect((await go()).headers.get('X-RateLimit-Remaining')).toBe('0');
    const third = await go();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('publishes a valid OpenAPI 3.1 document and docs page', async () => {
    const spec = (await (await api.request('/api/v1/openapi.json')).json()) as Record<
      string,
      unknown
    >;
    const r = await validate(spec);
    expect(r.errors ?? []).toEqual([]);
    expect(r.valid).toBe(true);
    expect(Object.keys((spec as { paths: object }).paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/me',
        '/api/v1/me/mentees',
        '/api/v1/users/{id}/overview',
        '/api/v1/courses/{id}/contents',
        '/api/v1/activities/{id}/actions/{name}',
      ]),
    );
    // every module action is documented from its input schema
    const schemas = (spec as { components: { schemas: Record<string, Record<string, unknown>> } })
      .components.schemas;
    expect(schemas['Action.assign.saveSubmission']).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' }, files: { items: { format: 'binary' } } },
    });
    expect(schemas['Action.quiz.setOverride']?.properties).toHaveProperty('attempts');
    const run = (spec as { paths: Record<string, { post: Record<string, unknown> }> }).paths[
      '/api/v1/activities/{id}/actions/{name}'
    ]!.post;
    expect(run.description).toContain('| quiz | `regrade` | `mod.quiz:grade` |');
    // and every module query from its parameters and result schema
    expect(schemas['Query.quiz.review']).toMatchObject({
      type: 'object',
      properties: { showAnswers: { type: 'boolean' }, questions: { type: 'array' } },
    });
    expect(schemas['Query.forum.discussions']?.properties).toHaveProperty('items');
    const read = (spec as { paths: Record<string, { get: Record<string, unknown> }> }).paths[
      '/api/v1/activities/{id}/queries/{name}'
    ]!.get;
    expect(read.description).toContain('| assign | `status` |');
    expect((read.parameters as { name: string }[]).map((p) => p.name)).toEqual(
      expect.arrayContaining(['id', 'name', 'discussionId', 'attemptId', 'page']),
    );
    // the reference page runs only Scalar's bundle from this origin, under a strict CSP
    const docs = await api.request('/api/v1/docs');
    expect(docs.status).toBe(200);
    expect(docs.headers.get('content-security-policy')).toContain("script-src 'self';");
    const html = await docs.text();
    expect(html).toContain('data-url="/api/v1/openapi.json"');
    expect(html).not.toMatch(/https?:\/\//);
    const src = html.match(/<script src="([^"]+)"/)?.[1];
    expect(src).toMatch(/^\/api\/v1\/docs\/scalar\.js\?v=[0-9a-f]{12}$/);
    const js = await api.request(src!);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await js.text()).length).toBeGreaterThan(100_000);
  });
});
