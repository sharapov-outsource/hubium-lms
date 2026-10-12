import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Agent, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { notifyUsers } from './notifications.ts';
import { pushConfig, savePushSubscription, sendPushNotifications } from './push.ts';

// A local HTTP server stands in for the browser vendor's push service.
describe('Web Push', () => {
  const t = useTestDb();
  const hits: { path: string; headers: IncomingMessage['headers']; size: number }[] = [];
  let base = '';
  // web-push only speaks HTTPS: a throwaway self-signed certificate for 127.0.0.1
  const dir = mkdtempSync(path.join(tmpdir(), 'push-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const tls = {
    key: readFileSync(path.join(dir, 'key.pem')),
    cert: readFileSync(path.join(dir, 'cert.pem')),
  };
  const agent = new Agent({ ca: tls.cert });
  const server = createServer(tls, async (req, res) => {
    let size = 0;
    for await (const c of req) size += (c as Buffer).length;
    hits.push({ path: req.url ?? '', headers: req.headers, size });
    res.writeHead(req.url?.startsWith('/gone') ? 410 : 201);
    res.end();
  });
  // A real P-256 key pair for the "browser", so web-push can encrypt the payload.
  const browser = webpush.generateVAPIDKeys();
  const keys = { p256dh: browser.publicKey, auth: Buffer.alloc(16, 7).toString('base64url') };

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const vapid = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  });
  afterAll(() => {
    server.close();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.SSRF_ALLOW_HOSTS;
  });

  it('refuses endpoints that are not public HTTPS addresses', async () => {
    const student = await t.db.user.findFirstOrThrow({ where: { username: 'student1' } });
    const ctx = await ctxFor(t.db, student.id);
    for (const endpoint of [
      `${base}/ok/1`,
      'http://push.example.com/x',
      'https://169.254.169.254/latest',
    ])
      await expect(savePushSubscription(ctx, { endpoint, keys })).rejects.toThrow();
    // the stand-in push service below runs on 127.0.0.1
    process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';
  });

  it('pushes in-app notifications to subscribed devices and drops expired ones', async () => {
    expect(pushConfig({ ...process.env, APP_URL: 'https://lms.test' } as never)).toMatchObject({
      subject: 'mailto:admin@lms.test',
    });
    const student = await t.db.user.findFirstOrThrow({ where: { username: 'student1' } });
    const ctx = await ctxFor(t.db, student.id);
    await savePushSubscription(ctx, { endpoint: `${base}/ok/1`, keys }, 'Test UA');
    await savePushSubscription(ctx, { endpoint: `${base}/gone/2`, keys });
    await expect(savePushSubscription(ctx, { endpoint: 'nope', keys })).rejects.toThrow();

    capturedJobs.length = 0;
    await t.db.$transaction((tx) =>
      notifyUsers(tx, [student.id], {
        type: 'calendar.reminder',
        title: 'Привет',
        body: 'Тест push',
      }),
    );
    const job = capturedJobs.find((j) => j.name === 'notification.push');
    expect(job).toBeDefined();
    const r = await sendPushNotifications(t.db, (job!.data as { ids: string[] }).ids, { agent });
    expect(r).toEqual({ sent: 1, removed: 1 });
    const ok = hits.find((h) => h.path === '/ok/1')!;
    expect(ok.headers['content-encoding']).toBe('aes128gcm');
    expect(ok.headers.authorization).toMatch(/^vapid t=/);
    expect(Number(ok.headers.ttl)).toBe(86400);
    expect(ok.size).toBeGreaterThan(0);
    expect(await t.db.pushSubscription.count({ where: { userId: student.id } })).toBe(1);

    // turning push off for the type stops it
    await t.db.notificationPreference.upsert({
      where: { userId_type: { userId: student.id, type: 'calendar.reminder' } },
      create: { userId: student.id, type: 'calendar.reminder', push: false },
      update: { push: false },
    });
    capturedJobs.length = 0;
    await t.db.$transaction((tx) =>
      notifyUsers(tx, [student.id], { type: 'calendar.reminder', title: 'Снова', body: '…' }),
    );
    expect(capturedJobs.some((j) => j.name === 'notification.push')).toBe(false);
  });
});
