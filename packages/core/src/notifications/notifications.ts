import { type Db, type EmailMode, modelUuidv7, type Prisma } from '@hubium/db';
import type { Locale } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';
import { log } from '@hubium/log';
import { z } from 'zod';
import { sign, verifySignature } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { enqueue } from '../jobs/jobs.ts';
import { zoneOr } from '../lib/zod.ts';
import { deliverMail, renderActionEmail, renderDigestEmail } from '../mail/mail.ts';
import { provideModuleServices, service } from '../modules/module-ctx.ts';
import { getModule, listModules } from '../modules/registry.ts';
import { defineOperation } from '../operation.ts';
import { publishRealtime } from '../realtime.ts';
import { isModuleEnabled } from '../settings/modules.ts';
import { getAllSettings, siteLocale, userLocale } from '../settings/settings.ts';
import { PUSH_JOB, pushConfig } from './push.ts';

const logger = log('notifications');

// Notifications: one row per recipient, rendered in the recipient's language. The in-app
// centre reads the rows; email goes out immediately (job) or in a daily digest (cron).
// Each type has default channels that users can override per type.

type Tx = Prisma.TransactionClient;

export interface NotificationTypeDef {
  email: EmailMode;
  inApp?: boolean;
  /** Push to devices even when not shown in the in-app centre (e.g. chat messages). */
  push?: boolean;
}

const coreTypes = new Map<string, NotificationTypeDef>([
  ['enrol.enrolled', { email: 'IMMEDIATE' }],
  ['announcement.course', { email: 'IMMEDIATE' }],
  ['announcement.site', { email: 'IMMEDIATE' }],
  ['message.new', { email: 'DIGEST', inApp: false, push: true }],
  ['calendar.reminder', { email: 'OFF' }],
  ['badge.awarded', { email: 'IMMEDIATE' }],
  ['certificate.issued', { email: 'IMMEDIATE' }],
  ['competency.plan', { email: 'IMMEDIATE' }],
  ['competency.comment', { email: 'IMMEDIATE' }],
  // work done on a local node without a connection that the cloud did not take
  ['node.conflict', { email: 'IMMEDIATE' }],
]);

export function registerNotificationType(type: string, def: NotificationTypeDef): void {
  coreTypes.set(type, def);
}

/** Core types by name; module types as `<moduleKey>.<name>` from `ActivityModule.notifications`. */
export function getNotificationType(type: string): NotificationTypeDef | undefined {
  const core = coreTypes.get(type);
  if (core) return core;
  const dot = type.indexOf('.');
  if (dot < 0) return undefined;
  return getModule(type.slice(0, dot))?.notifications?.[type.slice(dot + 1)];
}

export function listNotificationTypes(
  moduleKeys: string[],
): { type: string; def: NotificationTypeDef }[] {
  const out = [...coreTypes].map(([type, def]) => ({ type, def }));
  for (const key of moduleKeys) {
    for (const [name, def] of Object.entries(getModule(key)?.notifications ?? {})) {
      out.push({ type: `${key}.${name}`, def });
    }
  }
  return out;
}

/** i18n key of a type's label: `notifications.types.<a_b>` or `mod.<module>.notify.<name>`. */
export function notificationTypeLabelKey(type: string): string {
  if (coreTypes.has(type)) return `notifications.types.${type.replace('.', '_')}`;
  const dot = type.indexOf('.');
  return `mod.${type.slice(0, dot)}.notify.${type.slice(dot + 1)}`;
}

export type Text = string | { key: string; values?: Record<string, string | number> };

export interface NotifyInput {
  type: string;
  title: Text;
  body?: Text;
  url?: string;
  courseId?: string | null;
  contextId?: string | null;
  actorId?: string | null;
  data?: Record<string, unknown>;
}

const render = (t: ReturnType<typeof createTranslator>, x: Text | undefined) =>
  x === undefined ? '' : typeof x === 'string' ? x : t(x.key, x.values);

/** Notifications to a digest letter. */
const DIGEST_BATCH = 100;

/** Recipients per fan-out job for large audiences. */
export const FANOUT_CHUNK = 500;

/**
 * Notifies users inside the caller's transaction. Rows, realtime events and email jobs
 * become visible on commit. Large audiences are split into `notification.fanout` jobs.
 */
export async function notifyUsers(tx: Tx, userIds: string[], n: NotifyInput): Promise<number> {
  const ids = [...new Set(userIds)].filter((id) => id !== n.actorId);
  if (!ids.length) return 0;
  if (!getNotificationType(n.type)) throw new Error(`Unknown notification type ${n.type}`);
  if (ids.length > FANOUT_CHUNK) {
    for (let i = 0; i < ids.length; i += FANOUT_CHUNK) {
      await enqueue('notification.fanout', { userIds: ids.slice(i, i + FANOUT_CHUNK), n }, { tx });
    }
    return ids.length;
  }
  return deliverNotifications(tx, ids, n);
}

export async function deliverNotifications(
  tx: Tx,
  userIds: string[],
  n: NotifyInput,
): Promise<number> {
  const def = getNotificationType(n.type);
  if (!def) throw new Error(`Unknown notification type ${n.type}`);
  const [users, prefs, settings] = await Promise.all([
    tx.user.findMany({
      where: { id: { in: userIds }, status: 'ACTIVE', kind: 'PERSON' },
      select: { id: true, locale: true, emailPlaceholder: true },
    }),
    tx.notificationPreference.findMany({ where: { userId: { in: userIds }, type: n.type } }),
    getAllSettings(tx as unknown as Db),
  ]);
  const prefOf = new Map(prefs.map((p) => [p.userId, p]));
  const translators = new Map<Locale, ReturnType<typeof createTranslator>>();
  const rows: Prisma.NotificationCreateManyInput[] = [];
  for (const u of users) {
    const p = prefOf.get(u.id);
    const inApp = p?.inApp ?? def.inApp ?? true;
    const email: EmailMode = u.emailPlaceholder ? 'OFF' : (p?.email ?? def.email);
    if (!inApp && email === 'OFF') continue;
    const locale = userLocale(settings, u.locale);
    let t = translators.get(locale);
    if (!t) translators.set(locale, (t = createTranslator(locale, siteLocale(settings))));
    rows.push({
      id: modelUuidv7('Notification'),
      userId: u.id,
      type: n.type,
      actorId: n.actorId ?? null,
      courseId: n.courseId ?? null,
      contextId: n.contextId ?? null,
      title: render(t, n.title).slice(0, 500),
      body: render(t, n.body).slice(0, 5000),
      url: n.url ?? null,
      data: (n.data ?? {}) as Prisma.InputJsonValue,
      inApp,
      emailState: email === 'IMMEDIATE' ? 'PENDING' : email === 'DIGEST' ? 'DIGEST' : 'NONE',
    });
  }
  if (!rows.length) return 0;
  await tx.notification.createMany({ data: rows });
  const live = rows.filter((r) => r.inApp).map((r) => r.userId);
  if (live.length) await publishRealtime(tx, live, 'notification.new', { type: n.type });
  const pending = rows.filter((r) => r.emailState === 'PENDING').map((r) => r.id!);
  if (pending.length) await enqueue('notification.email', { ids: pending }, { tx });
  if (pushConfig()) {
    const pushOff = new Set(prefs.filter((p) => !p.push).map((p) => p.userId));
    const withDevices = new Set(
      (
        await tx.pushSubscription.findMany({
          where: { userId: { in: rows.map((r) => r.userId).filter((u) => !pushOff.has(u)) } },
          select: { userId: true },
        })
      ).map((s) => s.userId),
    );
    const push = rows
      .filter((r) => (r.inApp || def.push) && withDevices.has(r.userId))
      .map((r) => r.id!);
    if (push.length) await enqueue(PUSH_JOB, { ids: push }, { tx });
  }
  return rows.length;
}

provideModuleServices({
  notify: (ctx, tx) => async (userIds, n) => {
    // Module notifications are typed `<module>.<name>`: none from types that are turned off.
    const key = n.type.split('.')[0]!;
    if (getModule(key) && !isModuleEnabled(await getAllSettings(tx), key)) return;
    const { anonymous, ...rest } = n;
    const actorId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
    // the acting user is never notified; an anonymous notification just does not say who
    let to = userIds.filter((id) => id !== actorId);
    // about an activity: only those who may open it (hidden, restricted to some)
    if (n.contextId && (await tx.activity.count({ where: { id: n.contextId } })))
      to = await service('openableBy', ctx, tx)(n.contextId, to);
    await notifyUsers(tx, to, { ...rest, actorId: anonymous ? null : actorId });
  },
});

// ── in-app centre ─────────────────────────────────────────────────────────────

export async function unreadNotificationCount(db: Db, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, inApp: true, readAt: null } });
}

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { unreadOnly?: boolean; before?: string; limit?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const rows = await db.notification.findMany({
    where: {
      userId,
      inApp: true,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(opts.before ? { id: { lt: opts.before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    include: { actor: { select: { id: true, name: true, image: true } } },
  });
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export const markNotificationsRead = defineOperation({
  name: 'notification.read',
  offline: 'replay',
  mutation: true,
  input: z.object({
    ids: z.array(z.string().uuid()).max(500).optional(),
    all: z.boolean().optional(),
  }),
  authorize: (ctx) => {
    if (!ctx.perm.userId) throw new Error('Sign in required');
  },
  async handler(ctx, input) {
    const userId = ctx.perm.userId!;
    const r = await ctx.tx.notification.updateMany({
      where: { userId, readAt: null, ...(input.all ? {} : { id: { in: input.ids ?? [] } }) },
      data: { readAt: ctx.now },
    });
    if (r.count) await publishRealtime(ctx.tx, [userId], 'notification.read');
    return { count: r.count };
  },
});

// ── preferences ───────────────────────────────────────────────────────────────

export async function getNotificationPreferences(db: Db, userId: string, moduleKeys: string[]) {
  const [prefs, user] = await Promise.all([
    db.notificationPreference.findMany({ where: { userId } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { digestHour: true } }),
  ]);
  const byType = new Map(prefs.map((p) => [p.type, p]));
  return {
    digestHour: user.digestHour,
    types: listNotificationTypes(moduleKeys).map(({ type, def }) => ({
      type,
      labelKey: notificationTypeLabelKey(type),
      inApp: byType.get(type)?.inApp ?? def.inApp ?? true,
      email: byType.get(type)?.email ?? def.email,
      push: byType.get(type)?.push ?? true,
    })),
  };
}

export const updateNotificationPreferences = defineOperation({
  name: 'notification.preferences.update',
  offline: 'guarded',
  mutation: true,
  input: z.object({
    digestHour: z.coerce.number().int().min(0).max(23),
    prefs: z
      .array(
        z.object({
          type: z.string().min(1).max(100),
          inApp: z.boolean(),
          email: z.enum(['OFF', 'IMMEDIATE', 'DIGEST']),
          push: z.boolean().default(true),
        }),
      )
      .max(200),
  }),
  authorize: (ctx) => {
    if (!ctx.perm.userId) throw new Error('Sign in required');
  },
  async handler(ctx, input) {
    const userId = ctx.perm.userId!;
    await ctx.tx.user.update({ where: { id: userId }, data: { digestHour: input.digestHour } });
    for (const p of input.prefs) {
      if (!getNotificationType(p.type)) continue;
      await ctx.tx.notificationPreference.upsert({
        where: { userId_type: { userId, type: p.type } },
        create: { userId, type: p.type, inApp: p.inApp, email: p.email, push: p.push },
        update: { inApp: p.inApp, email: p.email, push: p.push },
      });
    }
    return { ok: true };
  },
});

// ── one-click unsubscribe ─────────────────────────────────────────────────────

const UNSUB = 'unsubscribe';

/** `type` is a notification type, or `*` for every email. */
export function unsubscribeToken(userId: string, type: string): string {
  const value = Buffer.from(`${userId}:${type}`).toString('base64url');
  return `${value}.${sign(value, getEnv().APP_SECRET, UNSUB)}`;
}

export function unsubscribeUrl(userId: string, type: string): string {
  return `${getEnv().APP_URL}/unsubscribe/${unsubscribeToken(userId, type)}`;
}

/** One-click endpoint for the List-Unsubscribe header (RFC 8058). */
export function unsubscribeHeaderUrl(userId: string, type: string): string {
  return `${getEnv().APP_URL}/api/unsubscribe/${unsubscribeToken(userId, type)}`;
}

export function parseUnsubscribeToken(token: string): { userId: string; type: string } | null {
  const [value, sig] = token.split('.');
  if (!value || !sig || !verifySignature(value, sig, getEnv().APP_SECRET, UNSUB)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { userId: decoded.slice(0, i), type: decoded.slice(i + 1) };
}

/** Turns email off for the token's type (or all types). Works without signing in. */
export async function applyUnsubscribe(
  db: Db | Prisma.TransactionClient,
  token: string,
  moduleKeys: string[],
): Promise<{ type: string } | null> {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return null;
  const user = await db.user.findUnique({ where: { id: parsed.userId }, select: { id: true } });
  if (!user) return null;
  const types =
    parsed.type === '*'
      ? listNotificationTypes(moduleKeys).map((x) => x.type)
      : getNotificationType(parsed.type)
        ? [parsed.type]
        : [];
  for (const type of types) {
    await db.notificationPreference.upsert({
      where: { userId_type: { userId: user.id, type } },
      create: { userId: user.id, type, email: 'OFF' },
      update: { email: 'OFF' },
    });
  }
  return { type: parsed.type };
}

/** The unsubscribe link of an email: its page and the one-click endpoint (RFC 8058). */
export const unsubscribeByToken = defineOperation({
  name: 'notification.unsubscribe',
  offline: 'online',
  input: z.object({ token: z.string().max(1000) }),
  handler: (ctx, { token }) =>
    applyUnsubscribe(
      ctx.tx,
      token,
      listModules().map((m) => m.key),
    ),
});

// ── email delivery (worker) ───────────────────────────────────────────────────

function absolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : `${getEnv().APP_URL}${url}`;
}

/** Sends the immediate emails for the given notification ids (job `notification.email`). */
export async function sendNotificationEmails(db: Db, ids: string[]): Promise<number> {
  const rows = await db.notification.findMany({
    where: { id: { in: ids }, emailState: 'PENDING' },
    include: { user: { select: { email: true, locale: true, emailPlaceholder: true } } },
  });
  const settings = await getAllSettings(db);
  let sent = 0;
  let failed = 0;
  for (const n of rows) {
    if (n.user.emailPlaceholder) {
      await db.notification.update({ where: { id: n.id }, data: { emailState: 'NONE' } });
      continue;
    }
    const locale = userLocale(settings, n.user.locale);
    const t = createTranslator(locale, siteLocale(settings));
    const unsub = unsubscribeUrl(n.userId, n.type);
    const header = unsubscribeHeaderUrl(n.userId, n.type);
    const { html, text } = renderActionEmail({
      locale,
      siteName: settings['site.name'],
      heading: n.title,
      intro: n.body || n.title,
      action: n.url ? { label: t('notifications.email.open'), url: absolute(n.url) } : undefined,
      footer: t('notifications.email.footer'),
      unsubscribe: { label: t('notifications.email.unsubscribe'), url: unsub },
    });
    try {
      await deliverMail({
        to: n.user.email,
        subject: n.title,
        html,
        text,
        headers: {
          'List-Unsubscribe': `<${header}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      await db.notification.update({ where: { id: n.id }, data: { emailState: 'SENT' } });
      sent++;
    } catch (e) {
      // Left PENDING: the job fails below and pg-boss retries it with backoff; mails
      // already sent are SENT and skipped on the retry.
      logger.error({ err: e, notificationId: n.id }, 'notification email failed');
      failed++;
    }
  }
  if (failed) throw new Error(`${failed} notification email(s) could not be sent`);
  return sent;
}

/** Hour (0-23) in a time zone; falls back to UTC for unknown zones. */
export function localHour(now: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone })
      .formatToParts(now)
      .find((p) => p.type === 'hour')?.value;
    return Number(h);
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Daily digests (cron hourly): users whose local hour equals their `digestHour` get one
 * email listing their queued notifications. `force` ignores the hour (tests, admin).
 */
export async function sendDigests(
  db: Db,
  now = new Date(),
  opts: { force?: boolean } = {},
): Promise<number> {
  const settings = await getAllSettings(db);
  const pending = await db.notification.groupBy({
    by: ['userId'],
    where: { emailState: 'DIGEST' },
  });
  let sent = 0;
  for (const { userId } of pending) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        locale: true,
        timezone: true,
        digestHour: true,
        emailPlaceholder: true,
        status: true,
      },
    });
    if (!user) continue;
    const tz = zoneOr(user.timezone, settings['site.defaultTimezone']);
    if (!opts.force && localHour(now, tz) !== user.digestHour) continue;
    if (user.status !== 'ACTIVE' || user.emailPlaceholder) {
      await db.notification.updateMany({
        where: { userId, emailState: 'DIGEST' },
        data: { emailState: 'NONE' },
      });
      continue;
    }
    const locale = userLocale(settings, user.locale);
    const t = createTranslator(locale, siteLocale(settings));
    const unsub = unsubscribeUrl(userId, '*');
    const header = unsubscribeHeaderUrl(userId, '*');
    // 100 to a letter, as many letters as it takes. Each batch is taken (marked sent) before
    // it goes, so a run started meanwhile ("Run now") does not send it again; a letter that
    // fails gives its batch back.
    for (;;) {
      const items = (
        await db.$queryRaw<{ id: string; title: string; body: string; url: string | null }[]>`
          UPDATE "Notification" SET "emailState" = 'SENT'
           WHERE id IN (SELECT id FROM "Notification"
                         WHERE "userId" = ${userId}::uuid AND "emailState" = 'DIGEST'
                         ORDER BY id LIMIT ${DIGEST_BATCH}
                           FOR UPDATE SKIP LOCKED)
          RETURNING id, title, body, url`
      ).sort((a, b) => a.id.localeCompare(b.id));
      if (!items.length) break;
      const { html, text } = renderDigestEmail({
        locale,
        siteName: settings['site.name'],
        heading: t('notifications.digest.heading', { n: items.length }),
        items: items.map((i) => ({
          title: i.title,
          body: i.body,
          url: i.url ? absolute(i.url) : undefined,
        })),
        footer: t('notifications.email.footer'),
        unsubscribe: { label: t('notifications.email.unsubscribeAll'), url: unsub },
      });
      try {
        await deliverMail({
          to: user.email,
          subject: t('notifications.digest.subject', { site: settings['site.name'] }),
          html,
          text,
          headers: {
            'List-Unsubscribe': `<${header}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        sent++;
      } catch (e) {
        logger.error({ err: e }, 'digest email failed');
        await db.notification.updateMany({
          where: { id: { in: items.map((i) => i.id) } },
          data: { emailState: 'DIGEST' },
        });
        break;
      }
      if (items.length < DIGEST_BATCH) break;
    }
  }
  return sent;
}

/**
 * Removes read notifications older than `days`, and unread ones older than `unreadDays`, so
 * what someone has not seen yet stays longer but the table does not grow for ever (cron
 * daily). Ones an email is still due for stay.
 */
export async function pruneNotifications(
  db: Db,
  now = new Date(),
  days = 180,
  unreadDays = 365,
): Promise<number> {
  const before = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const r = await db.notification.deleteMany({
    where: {
      emailState: { notIn: ['PENDING', 'DIGEST'] },
      OR: [
        { readAt: { not: null }, createdAt: { lt: before(days) } },
        { readAt: null, createdAt: { lt: before(unreadDays) } },
      ],
    },
  });
  return r.count;
}
