import { createHmac, randomBytes } from 'node:crypto';
import type { Db, Prisma, Webhook } from '@hubium/db';
import { log } from '@hubium/log';
import { assertPublicUrl, checkUrlShape, UnsafeUrlError } from '@hubium/module-sdk/net';
import { z } from 'zod';
import { publishInvalidation } from '../cache-bus.ts';
import type { RequestContext } from '../context.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { NotFoundError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { enqueue } from '../jobs/jobs.ts';
import { defineOperation } from '../operation.ts';
import { WEBHOOK_EVENTS, WEBHOOK_JOB, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY } from './events.ts';

// Webhook subscriptions (administrators, in the admin area or over the REST API) and the
// worker that sends deliveries: a signed POST, retried with backoff, never redirected and
// never to internal addresses unless SSRF_ALLOW_HOSTS lists the host.

const logger = log('webhooks');

/** Failed deliveries in a row after which a webhook is switched off. */
export const WEBHOOK_FAILURE_LIMIT = 50;
/** Deliveries are kept this long for the log. */
export const WEBHOOK_RETENTION_DAYS = 30;
const TIMEOUT_MS = 10_000;
const BODY_KEPT = 2_000;

const seal = (s: string) => encryptSecret(s, getEnv().APP_SECRET);
const unseal = (s: string) => decryptSecret(s, getEnv().APP_SECRET);
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

const requireAdmin = async (ctx: RequestContext) => {
  await ctx.perm.require('site:config');
};

const UrlField = z
  .string()
  .trim()
  .max(2000)
  .superRefine((v, c) => {
    try {
      checkUrlShape(v);
    } catch (e) {
      c.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    }
  });
const EventsField = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Choose at least one event')
  .transform((list) => [...new Set(list)]);

const WebhookInput = z.object({
  name: z.string().trim().min(1).max(200),
  url: UrlField,
  events: EventsField,
  enabled: z.boolean().default(true),
});

/** A webhook as administrators and the API see it: no secret. */
export function webhookView(w: Webhook) {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    disabledReason: w.disabledReason,
    consecutiveFailures: w.consecutiveFailures,
    lastDeliveryAt: w.lastDeliveryAt,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

async function changed(
  ctx: RequestContext & { tx: Prisma.TransactionClient },
  name: string,
  id: string,
) {
  await publishInvalidation(ctx.tx, 'webhooks');
  await logEvent(ctx.tx, {
    name,
    actorId: ctx.perm.userId,
    objectType: 'webhook',
    objectId: id,
    origin: ctx.origin,
  });
}

export const createWebhook = defineOperation({
  name: 'webhook.create',
  input: WebhookInput,
  authorize: requireAdmin,
  async handler(ctx, input) {
    const secret = newSecret();
    const w = await ctx.tx.webhook.create({
      data: { ...input, secretEnc: seal(secret), createdById: ctx.perm.userId },
    });
    await changed(ctx, 'webhook.created', w.id);
    // The secret is shown once; afterwards it can only be replaced.
    return { ...webhookView(w), secret };
  },
});

export const updateWebhook = defineOperation({
  name: 'webhook.update',
  input: WebhookInput.partial().extend({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id, ...input }) {
    const before = await ctx.tx.webhook.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Webhook');
    const reenabled = input.enabled === true && !before.enabled;
    const w = await ctx.tx.webhook.update({
      where: { id },
      data: {
        ...input,
        // Switching a webhook back on gives it a clean slate.
        ...(reenabled ? { consecutiveFailures: 0, disabledReason: null } : {}),
      },
    });
    await changed(ctx, 'webhook.updated', w.id);
    return webhookView(w);
  },
});

export const deleteWebhook = defineOperation({
  name: 'webhook.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const r = await ctx.tx.webhook.deleteMany({ where: { id } });
    if (!r.count) throw new NotFoundError('Webhook');
    await changed(ctx, 'webhook.deleted', id);
    return { id };
  },
});

export const rotateWebhookSecret = defineOperation({
  name: 'webhook.rotateSecret',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const secret = newSecret();
    const r = await ctx.tx.webhook.updateMany({ where: { id }, data: { secretEnc: seal(secret) } });
    if (!r.count) throw new NotFoundError('Webhook');
    await changed(ctx, 'webhook.secret.rotated', id);
    return { id, secret };
  },
});

/** Sends a "ping" event now, whatever the webhook subscribes to. */
export const pingWebhook = defineOperation({
  name: 'webhook.ping',
  input: z.object({ id: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { id }) {
    const w = await ctx.tx.webhook.findUnique({ where: { id } });
    if (!w) throw new NotFoundError('Webhook');
    const d = await ctx.tx.webhookDelivery.create({
      data: {
        webhookId: id,
        event: 'ping',
        payload: { webhook: { id: w.id, name: w.name }, actorId: ctx.perm.userId },
      },
    });
    // A test is sent once: the administrator watches the result.
    await enqueue(WEBHOOK_JOB, { deliveryId: d.id }, { retryLimit: 0, tx: ctx.tx });
    return { deliveryId: d.id };
  },
});

/** Sends a past delivery's event again, as a new delivery. */
export const redeliverWebhook = defineOperation({
  name: 'webhook.redeliver',
  input: z.object({ deliveryId: z.string().uuid() }),
  authorize: requireAdmin,
  async handler(ctx, { deliveryId }) {
    const old = await ctx.tx.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!old) throw new NotFoundError('Delivery');
    const d = await ctx.tx.webhookDelivery.create({
      data: {
        webhookId: old.webhookId,
        event: old.event,
        payload: old.payload as Prisma.InputJsonValue,
      },
    });
    await enqueue(WEBHOOK_JOB, { deliveryId: d.id }, { ...WEBHOOK_RETRY, tx: ctx.tx });
    return { deliveryId: d.id };
  },
});

export async function listWebhooks(ctx: RequestContext) {
  await requireAdmin(ctx);
  const rows = await ctx.db.webhook.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(webhookView);
}

export async function getWebhook(ctx: RequestContext, id: string) {
  await requireAdmin(ctx);
  const w = await ctx.db.webhook.findUnique({ where: { id } });
  if (!w) throw new NotFoundError('Webhook');
  return webhookView(w);
}

export async function listWebhookDeliveries(
  ctx: RequestContext,
  webhookId: string,
  opts: { page?: number; pageSize?: number } = {},
) {
  await requireAdmin(ctx);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
  const where = { webhookId };
  const [items, total] = await Promise.all([
    ctx.db.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    ctx.db.webhookDelivery.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/** The JSON body a receiver gets. */
export function webhookBody(d: { id: string; event: string; createdAt: Date; payload: unknown }) {
  return JSON.stringify({
    id: d.id,
    type: d.event,
    occurredAt: d.createdAt.toISOString(),
    data: d.payload,
  });
}

/**
 * Signature header value: "t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">". A
 * receiver recomputes it with the shared secret and rejects old timestamps.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Thrown to let the job queue retry a delivery later (logged as a warning, not an error). */
export class WebhookRetry extends Error {
  readonly expected = true;
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetry';
  }
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * Worker job: sends one delivery. Success and permanent failures return; a failure that may
 * pass (network, timeout, 408/429/5xx) throws WebhookRetry until the attempts run out.
 */
export async function deliverWebhook(db: Db, deliveryId: string) {
  const d = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (d?.status !== 'PENDING') return { skipped: true };
  const w = d.webhook;
  if (!w.enabled && d.event !== 'ping') {
    await db.webhookDelivery.update({
      where: { id: d.id },
      data: { status: 'FAILED', responseBody: 'The webhook is switched off' },
    });
    return { skipped: true };
  }
  const body = webhookBody(d);
  const timestamp = Math.floor(Date.now() / 1000);
  const attempts = d.attempts + 1;
  let status: number | null = null;
  let answer = '';
  // An internal address will not become public by waiting: no retry.
  let refused = false;
  try {
    await assertPublicUrl(w.url);
    const res = await fetch(w.url, {
      method: 'POST',
      // A redirect would carry the signed event elsewhere: it counts as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HubiumLMS-Webhooks/1',
        'X-Hubium-Event': d.event,
        'X-Hubium-Delivery': d.id,
        'X-Hubium-Signature': signWebhook(unseal(w.secretEnc), body, timestamp),
      },
      body,
    });
    status = res.status;
    answer = (await res.text().catch(() => '')).slice(0, BODY_KEPT);
  } catch (e) {
    refused = e instanceof UnsafeUrlError;
    answer =
      e instanceof UnsafeUrlError
        ? e.message
        : e instanceof Error && e.name === 'TimeoutError'
          ? `No answer within ${TIMEOUT_MS / 1000} s`
          : e instanceof Error
            ? e.cause instanceof Error
              ? e.cause.message
              : e.message
            : String(e);
  }

  const ok = status !== null && status >= 200 && status < 300;
  const again =
    !ok &&
    !refused &&
    d.event !== 'ping' &&
    attempts < WEBHOOK_MAX_ATTEMPTS &&
    (status === null || retryable(status));
  await db.webhookDelivery.update({
    where: { id: d.id },
    data: {
      attempts,
      lastAttemptAt: new Date(),
      responseStatus: status,
      responseBody: answer || null,
      status: ok ? 'SUCCESS' : again ? 'PENDING' : 'FAILED',
    },
  });
  const fields = {
    webhookId: w.id,
    deliveryId: d.id,
    event: d.event,
    host: new URL(w.url).host,
    status,
    attempt: attempts,
  };
  if (again) throw new WebhookRetry(`Webhook answered ${status ?? answer}`);
  if (ok) logger.debug(fields, 'webhook delivered');
  else logger.warn({ ...fields, answer: answer.slice(0, 200) }, 'webhook delivery failed for good');
  if (d.event === 'ping') return { ok, status };

  if (ok) {
    await db.webhook.update({
      where: { id: w.id },
      data: { consecutiveFailures: 0, lastDeliveryAt: new Date() },
    });
  } else {
    const updated = await db.webhook.update({
      where: { id: w.id },
      data: { consecutiveFailures: { increment: 1 }, lastDeliveryAt: new Date() },
    });
    if (updated.enabled && updated.consecutiveFailures >= WEBHOOK_FAILURE_LIMIT) {
      await db.webhook.update({
        where: { id: w.id },
        data: {
          enabled: false,
          disabledReason: `Switched off after ${WEBHOOK_FAILURE_LIMIT} failed deliveries in a row`,
        },
      });
      await publishInvalidation(db, 'webhooks');
      logger.warn(
        { webhookId: w.id, host: fields.host },
        'webhook switched off after repeated failures',
      );
    }
  }
  return { ok, status };
}

/** Cron: drops deliveries past the retention period. */
export async function pruneWebhookDeliveries(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * 86_400_000);
  const r = await db.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return r.count;
}

export { WEBHOOK_EVENTS, WEBHOOK_JOB, type WebhookEvent } from './events.ts';
