import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { createManualItem, overrideGrade } from '../grades/gradebook.ts';
import { erasePersonalData } from '../privacy/privacy.ts';
import { createUser } from '../users/users.ts';
import { WEBHOOK_MAX_ATTEMPTS } from './events.ts';
import {
  createWebhook,
  deleteWebhook,
  deliverWebhook,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
  pruneWebhookDeliveries,
  redeliverWebhook,
  rotateWebhookSecret,
  updateWebhook,
  WEBHOOK_FAILURE_LIMIT,
  WebhookRetry,
} from './webhooks.ts';

/** A receiver that records requests and answers with the next queued status. */
function receiver() {
  const hits: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const answers: number[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body });
      const status = answers.shift() ?? 200;
      if (status === 302) res.writeHead(302, { location: '/elsewhere' }).end();
      else res.writeHead(status, { 'content-type': 'text/plain' }).end(`answer ${status}`);
    });
  });
  return {
    hits,
    answers,
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
  };
}

describe('webhooks', () => {
  const t = useTestDb();
  const rx = receiver();
  let admin: Awaited<ReturnType<typeof ctxFor>>;
  let f: Awaited<ReturnType<typeof courseFixture>>;

  beforeAll(async () => {
    await new Promise<void>((r) => rx.server.listen(0, '127.0.0.1', r));
    admin = await ctxFor(t.db, 'admin@test.local');
    f = await courseFixture(t.db, 'WH1');
  });
  afterAll(async () => {
    delete process.env.SSRF_ALLOW_HOSTS;
    await new Promise((r) => rx.server.close(r));
  });
  beforeEach(() => {
    capturedJobs.length = 0;
  });

  const deliveriesOf = (webhookId: string) =>
    t.db.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: 'asc' } });

  it('refuses internal addresses unless allowed, and only administrators manage webhooks', async () => {
    delete process.env.SSRF_ALLOW_HOSTS;
    await expect(
      createWebhook.run(admin, { name: 'LAN', url: rx.url(), events: ['user.created'] }),
    ).rejects.toMatchObject({ fieldErrors: { url: [expect.stringMatching(/SSRF_ALLOW_HOSTS/)] } });
    await expect(
      createWebhook.run(admin, {
        name: 'FTP',
        url: 'ftp://example.org/x',
        events: ['user.created'],
      }),
    ).rejects.toThrow();
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await expect(
      createWebhook.run(teacher, {
        name: 'Mine',
        url: 'https://example.org/hook',
        events: ['user.created'],
      }),
    ).rejects.toThrow();
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
  });

  it('queues signed deliveries for subscribed events with people and course details', async () => {
    const w = await createWebhook.run(admin, {
      name: 'HR',
      url: rx.url(),
      events: ['user.created', 'enrolment.created', 'grade.updated'],
    });
    expect(w.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(await listWebhooks(admin))).not.toContain(w.secret);

    const { id: userId } = await createUser.run(admin, {
      username: 'wh.user',
      email: 'wh.user@example.org',
      firstName: 'Вера',
      lastName: 'Хукова',
      password: 'Password123!',
    });
    // Not subscribed: no delivery for course updates.
    const [delivery] = await deliveriesOf(w.id);
    expect(delivery).toMatchObject({ event: 'user.created', status: 'PENDING', attempts: 0 });
    expect(delivery!.payload).toMatchObject({
      user: { id: userId, username: 'wh.user', email: 'wh.user@example.org', lastName: 'Хукова' },
      actorId: admin.perm.userId,
    });
    expect(capturedJobs).toEqual([
      expect.objectContaining({
        name: 'webhook.deliver',
        data: { deliveryId: delivery!.id },
        opts: expect.objectContaining({ retryLimit: WEBHOOK_MAX_ATTEMPTS - 1, retryBackoff: true }),
      }),
    ]);

    expect(await deliverWebhook(t.db, delivery!.id)).toEqual({ ok: true, status: 200 });
    const hit = rx.hits.at(-1)!;
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({
      id: delivery!.id,
      type: 'user.created',
      data: { user: { id: userId } },
    });
    expect(hit.headers['x-hubium-event']).toBe('user.created');
    expect(hit.headers['x-hubium-delivery']).toBe(delivery!.id);
    const [, ts, mac] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      String(hit.headers['x-hubium-signature']),
    )!;
    expect(mac).toBe(createHmac('sha256', w.secret).update(`${ts}.${hit.body}`).digest('hex'));
    expect(await t.db.webhookDelivery.findUnique({ where: { id: delivery!.id } })).toMatchObject({
      status: 'SUCCESS',
      attempts: 1,
      responseStatus: 200,
    });
    // Delivered once: a repeated job does nothing.
    expect(await deliverWebhook(t.db, delivery!.id)).toEqual({ skipped: true });
    await deleteWebhook.run(admin, { id: w.id });
  });

  it('covers enrolment, grades, completion and course completion', async () => {
    const w = await createWebhook.run(admin, {
      name: 'All',
      url: rx.url(),
      events: ['enrolment.created', 'grade.updated', 'activity.completed', 'course.completed'],
    });
    const g = await courseFixture(t.db, 'WH2');
    const page = await g.addActivity(
      'page',
      'Читать',
      { content: '<p>x</p>' },
      { completionMode: 'MANUAL' },
    );
    const student = await ctxFor(t.db, g.users.student1!);
    await toggleManualCompletion.run(student, { activityId: page.id, done: true });
    const teacher = await ctxFor(t.db, g.users.teacher!);
    const item = await createManualItem.run(teacher, {
      courseId: g.courseId,
      name: 'Устный ответ',
      gradeMax: 10,
    });
    await overrideGrade.run(teacher, { itemId: item.id, userId: g.users.student1!, value: 8 });
    // The same grade again is no change.
    await overrideGrade.run(teacher, { itemId: item.id, userId: g.users.student1!, value: 8 });

    const events = (await deliveriesOf(w.id)).map((d) => d.event);
    expect(events.filter((e) => e === 'enrolment.created')).toHaveLength(4);
    expect(events).toContain('activity.completed');
    expect(events).toContain('course.completed');
    const grades = (await deliveriesOf(w.id)).filter(
      (d) =>
        d.event === 'grade.updated' &&
        (d.payload as { gradeItem?: { id: string } }).gradeItem?.id === item.id,
    );
    expect(grades).toHaveLength(1);
    expect(grades[0]!.payload).toMatchObject({
      grade: 8,
      gradeItem: { name: 'Устный ответ', gradeMax: 10 },
      user: { id: g.users.student1 },
      course: { id: g.courseId, shortName: 'WH2' },
    });
    const done = (await deliveriesOf(w.id)).find((d) => d.event === 'activity.completed');
    expect(done!.payload).toMatchObject({
      activity: { id: page.id, module: 'page' },
      state: 'COMPLETE',
    });
    await deleteWebhook.run(admin, { id: w.id });
  });

  it('retries what may pass, gives up on the rest and never follows redirects', async () => {
    const w = await createWebhook.run(admin, {
      name: 'Flaky',
      url: rx.url(),
      events: ['user.updated'],
    });
    const make = async () =>
      (
        await t.db.webhookDelivery.create({
          data: { webhookId: w.id, event: 'user.updated', payload: { user: { id: 'x' } } },
        })
      ).id;

    const a = await make();
    rx.answers.push(503);
    await expect(deliverWebhook(t.db, a)).rejects.toBeInstanceOf(WebhookRetry);
    expect(await t.db.webhookDelivery.findUnique({ where: { id: a } })).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      responseStatus: 503,
      responseBody: 'answer 503',
    });
    await t.db.webhookDelivery.update({
      where: { id: a },
      data: { attempts: WEBHOOK_MAX_ATTEMPTS - 1 },
    });
    rx.answers.push(503);
    expect(await deliverWebhook(t.db, a)).toEqual({ ok: false, status: 503 });
    expect((await t.db.webhookDelivery.findUnique({ where: { id: a } }))?.status).toBe('FAILED');

    const b = await make();
    rx.answers.push(410);
    expect(await deliverWebhook(t.db, b)).toEqual({ ok: false, status: 410 });

    const c = await make();
    rx.answers.push(302);
    const before = rx.hits.length;
    expect(await deliverWebhook(t.db, c)).toEqual({ ok: false, status: 302 });
    expect(rx.hits.slice(before).map((h) => h.path)).toEqual(['/hook']);

    expect((await t.db.webhook.findUnique({ where: { id: w.id } }))?.consecutiveFailures).toBe(3);
    // A success resets the count.
    expect(await deliverWebhook(t.db, await make())).toMatchObject({ ok: true });
    expect((await t.db.webhook.findUnique({ where: { id: w.id } }))?.consecutiveFailures).toBe(0);
  });

  it('switches a failing webhook off and back on', async () => {
    const w = await createWebhook.run(admin, {
      name: 'Dead',
      url: rx.url(),
      events: ['user.updated'],
    });
    await t.db.webhook.update({
      where: { id: w.id },
      data: { consecutiveFailures: WEBHOOK_FAILURE_LIMIT - 1 },
    });
    const d = await t.db.webhookDelivery.create({
      data: { webhookId: w.id, event: 'user.updated', payload: {} },
    });
    rx.answers.push(404);
    await deliverWebhook(t.db, d.id);
    const off = await t.db.webhook.findUniqueOrThrow({ where: { id: w.id } });
    expect(off.enabled).toBe(false);
    expect(off.disabledReason).toMatch(/50 failed deliveries/);

    // Off: events no longer queue deliveries for it.
    const student = f.users.student2!;
    await t.db.$transaction(async (tx) => {
      const { emitWebhook } = await import('./events.ts');
      await emitWebhook(tx, 'user.updated', { userId: student });
    });
    expect(await deliveriesOf(w.id)).toHaveLength(1);

    const on = await updateWebhook.run(admin, { id: w.id, enabled: true });
    expect(on).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
  });

  it('pings, redelivers, rotates the secret and lists deliveries', async () => {
    const w = await createWebhook.run(admin, {
      name: 'Ops',
      url: rx.url(),
      events: ['course.updated'],
    });
    const { deliveryId } = await pingWebhook.run(admin, { id: w.id });
    expect(capturedJobs.at(-1)?.opts).toMatchObject({ retryLimit: 0 });
    rx.answers.push(500);
    expect(await deliverWebhook(t.db, deliveryId)).toEqual({ ok: false, status: 500 });
    expect(JSON.parse(rx.hits.at(-1)!.body)).toMatchObject({
      type: 'ping',
      data: { webhook: { id: w.id } },
    });

    const again = await redeliverWebhook.run(admin, { deliveryId });
    expect(again.deliveryId).not.toBe(deliveryId);

    const { secret } = await rotateWebhookSecret.run(admin, { id: w.id });
    expect(secret).not.toBe(w.secret);
    await deliverWebhook(t.db, again.deliveryId);
    const hit = rx.hits.at(-1)!;
    const [, ts, mac] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      String(hit.headers['x-hubium-signature']),
    )!;
    expect(mac).toBe(createHmac('sha256', secret).update(`${ts}.${hit.body}`).digest('hex'));

    const page = await listWebhookDeliveries(admin, w.id);
    expect(page.total).toBe(2);
    expect(page.items[0]!.id).toBe(again.deliveryId);
  });

  it('forgets deliveries after the retention period and when a person is erased', async () => {
    const w = await createWebhook.run(admin, {
      name: 'Keep',
      url: rx.url(),
      events: ['user.updated'],
    });
    const old = await t.db.webhookDelivery.create({
      data: {
        webhookId: w.id,
        event: 'user.updated',
        payload: {},
        createdAt: new Date(Date.now() - 31 * 86_400_000),
      },
    });
    expect(await pruneWebhookDeliveries(t.db)).toBeGreaterThanOrEqual(1);
    expect(await t.db.webhookDelivery.findUnique({ where: { id: old.id } })).toBeNull();

    const userId = f.users.student3!;
    await t.db.webhookDelivery.create({
      data: {
        webhookId: w.id,
        event: 'user.updated',
        payload: { user: { id: userId, email: 'a@b.c' } },
      },
    });
    await t.db.$transaction((tx) => erasePersonalData(admin, tx, userId));
    const left = await t.db.webhookDelivery.findMany({ where: { webhookId: w.id } });
    expect(left.some((d) => JSON.stringify(d.payload).includes(userId))).toBe(false);
  });
});
