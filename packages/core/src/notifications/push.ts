import type { Db } from '@hubium/db';
import webpush from 'web-push';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { getEnv } from '../env.ts';
import { ForbiddenError } from '../errors.ts';

// Web Push (PWA notifications). Notifications shown in the app are also pushed to the
// user's subscribed devices when VAPID keys are configured and the user has not turned
// push off for that type. Expired subscriptions (404/410) are removed.

export const PUSH_JOB = 'notification.push';

export function pushConfig(env = getEnv()) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? `mailto:admin@${new URL(env.APP_URL).hostname}`,
  };
}

const Subscription = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'Invalid endpoint'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

export async function savePushSubscription(
  ctx: RequestContext,
  raw: unknown,
  userAgent?: string | null,
) {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  const s = Subscription.parse(raw);
  const userId = ctx.actor.userId;
  await ctx.db.pushSubscription.upsert({
    where: { endpoint: s.endpoint },
    create: {
      userId,
      endpoint: s.endpoint,
      p256dh: s.keys.p256dh,
      auth: s.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
    // the same browser re-subscribing (or another user signing in on it) takes it over
    update: { userId, p256dh: s.keys.p256dh, auth: s.keys.auth },
  });
  return { ok: true };
}

export async function removePushSubscription(ctx: RequestContext, endpoint: string) {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  await ctx.db.pushSubscription.deleteMany({ where: { endpoint, userId: ctx.actor.userId } });
  return { ok: true };
}

/** Worker job: pushes the given notifications to their users' devices. */
export async function sendPushNotifications(
  db: Db,
  ids: string[],
  /** Tests: an HTTPS agent trusting the local stand-in push service. */
  opts: { agent?: import('node:https').Agent } = {},
) {
  const cfg = pushConfig();
  if (!cfg) return { sent: 0, removed: 0 };
  const rows = await db.notification.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true, title: true, body: true, url: true, type: true },
  });
  const subs = await db.pushSubscription.findMany({
    where: { userId: { in: [...new Set(rows.map((r) => r.userId))] } },
  });
  let sent = 0;
  let removed = 0;
  for (const n of rows) {
    const payload = JSON.stringify({
      title: n.title,
      body: n.body.slice(0, 300),
      url: n.url ?? '/notifications',
      tag: n.type,
      id: n.id,
    });
    for (const s of subs.filter((x) => x.userId === n.userId)) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          {
            vapidDetails: cfg,
            TTL: 24 * 3600,
            urgency: 'normal',
            timeout: 10_000,
            ...(opts.agent ? { agent: opts.agent } : {}),
          },
        );
        sent++;
        await db.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          removed++;
        } else console.warn('[push] delivery failed', status ?? (e as Error).message);
      }
    }
  }
  return { sent, removed };
}
