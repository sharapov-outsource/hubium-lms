import { createApiToken, revokeApiToken, setActivityVisibility } from '@hubium/core';
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

  it('lists courses and contents without hidden activities', async () => {
    const list = (await (await call(tokens.student!, '/courses')).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((c) => c.id)).toContain(f.courseId);
    const r = await call(tokens.student!, `/courses/${f.courseId}/contents`);
    const { sections } = (await r.json()) as {
      sections: { activities: { id: string; url: string }[] }[];
    };
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
    };
    expect(a.settings).toEqual({});
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
        '/api/v1/courses/{id}/contents',
        '/api/v1/activities/{id}/actions/{name}',
      ]),
    );
    const docs = await api.request('/api/v1/docs');
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('/api/v1/openapi.json');
  });
});
