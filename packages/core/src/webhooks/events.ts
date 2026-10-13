import type { Db, Prisma } from '@hubium/db';
import { enqueue } from '../jobs/jobs.ts';

// Outgoing webhook events. Code that changes something an integration cares about calls
// `emitWebhook` inside its transaction (directly, or through the event log mapping below);
// each enabled subscriber gets a delivery row and a send job that commit with the change.

type Tx = Prisma.TransactionClient | Db;

export const WEBHOOK_EVENTS = [
  'user.created',
  'user.updated',
  'user.suspended',
  'user.unsuspended',
  'user.deleted',
  'course.created',
  'course.updated',
  'course.deleted',
  'enrolment.created',
  'enrolment.deleted',
  'grade.updated',
  'activity.completed',
  'course.completed',
  'submission.submitted',
  'quiz.attempt.finished',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_JOB = 'webhook.deliver';

/**
 * Sends a delivery up to this many times: the first try and 8 retries. pg-boss doubles the
 * pause from 5–10 minutes (with jitter) up to 6 hours, so the last try is about a day later.
 */
export const WEBHOOK_MAX_ATTEMPTS = 9;
export const WEBHOOK_RETRY = {
  retryLimit: WEBHOOK_MAX_ATTEMPTS - 1,
  retryDelay: 300,
  retryBackoff: true,
  retryDelayMax: 6 * 3600,
};

/** What an event refers to; the payload is filled in from the current records. */
export interface EventRefs {
  userId?: string | null;
  courseId?: string | null;
  activityId?: string | null;
  actorId?: string | null;
  /** Event-specific fields, copied into the payload as they are. */
  extra?: Record<string, unknown>;
}

// Enabled subscriptions, shared by every event in this process. Changes to webhooks
// publish the "webhooks" cache topic, which clears it here and in the other processes.
let subscriptions: Promise<{ id: string; events: string[] }[]> | undefined;

export function invalidateWebhookCache(): void {
  subscriptions = undefined;
}

function subscribers(db: Tx, event: WebhookEvent) {
  subscriptions ??= db.webhook
    .findMany({ where: { enabled: true }, select: { id: true, events: true } })
    .catch((e) => {
      subscriptions = undefined;
      throw e;
    });
  return subscriptions.then((all) => all.filter((w) => w.events.includes(event)));
}

const userRef = async (db: Tx, id: string) => {
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      email: true,
      emailPlaceholder: true,
      firstName: true,
      lastName: true,
      name: true,
      status: true,
      deletedAt: true,
    },
  });
  if (!u || u.deletedAt) return { id };
  return {
    id: u.id,
    username: u.username,
    email: u.emailPlaceholder ? null : u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    name: u.name,
    status: u.status,
  };
};

const courseRef = async (db: Tx, id: string) => {
  const c = await db.course.findUnique({
    where: { id },
    select: {
      id: true,
      shortName: true,
      fullName: true,
      idNumber: true,
      categoryId: true,
      visible: true,
      startDate: true,
      endDate: true,
    },
  });
  return c ?? { id };
};

const activityRef = async (db: Tx, id: string) => {
  const a = await db.activity.findUnique({
    where: { id },
    select: { id: true, name: true, moduleKey: true, courseId: true },
  });
  return a ? { id: a.id, name: a.name, module: a.moduleKey, courseId: a.courseId } : { id };
};

/** The event's `data`: the people, course and activity it is about, plus its own fields. */
async function payload(db: Tx, event: WebhookEvent, refs: EventRefs) {
  let courseId = refs.courseId ?? null;
  const out: Record<string, unknown> = {};
  if (refs.activityId) {
    const activity = await activityRef(db, refs.activityId);
    out.activity = activity;
    courseId ??= 'courseId' in activity ? (activity.courseId ?? null) : null;
  }
  if (refs.userId)
    out.user = event === 'user.deleted' ? { id: refs.userId } : await userRef(db, refs.userId);
  if (courseId) out.course = await courseRef(db, courseId);
  return { ...out, ...refs.extra, actorId: refs.actorId ?? null };
}

/** Queues a delivery of `event` to every enabled webhook subscribed to it. */
export async function emitWebhook(db: Tx, event: WebhookEvent, refs: EventRefs): Promise<void> {
  const hooks = await subscribers(db, event);
  if (!hooks.length) return;
  const data = (await payload(db, event, refs)) as Prisma.InputJsonValue;
  const tx = '$transaction' in db ? undefined : db;
  for (const h of hooks) {
    const d = await db.webhookDelivery.create({
      data: { webhookId: h.id, event, payload: data },
      select: { id: true },
    });
    await enqueue(WEBHOOK_JOB, { deliveryId: d.id }, { ...WEBHOOK_RETRY, tx });
  }
}

/** Event log entries that are also webhook events (some only with certain data). */
export function webhookEventFor(name: string, data: Record<string, unknown>): WebhookEvent | null {
  switch (name) {
    case 'user.created':
    case 'user.updated':
    case 'user.suspended':
    case 'user.unsuspended':
    case 'user.deleted':
    case 'course.created':
    case 'course.updated':
    case 'course.deleted':
      return name;
    case 'user.enrolled':
      return 'enrolment.created';
    case 'user.unenrolled':
      return 'enrolment.deleted';
    case 'assign.submission.saved':
      return data.status === 'SUBMITTED' ? 'submission.submitted' : null;
    case 'quiz.attempt.finished':
      return data.preview ? null : 'quiz.attempt.finished';
    default:
      return null;
  }
}
