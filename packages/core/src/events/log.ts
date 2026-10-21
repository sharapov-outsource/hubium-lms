import type { Db, EventOrigin, Prisma } from '@hubium/db';
import { emitWebhook, webhookEventFor } from '../webhooks/events.ts';
import { currentNodeId, currentRealActorId } from './actor-scope.ts';

type Tx = Prisma.TransactionClient | Db;

export interface LogEventInput {
  name: string;
  actorId?: string | null;
  realActorId?: string | null;
  contextId?: string | null;
  courseId?: string | null;
  objectType?: string;
  objectId?: string;
  relatedUserId?: string | null;
  data?: Prisma.InputJsonValue;
  origin?: EventOrigin;
  ip?: string | null;
}

export async function logEvent(db: Tx, e: LogEventInput): Promise<void> {
  await db.eventLog.create({
    data: {
      name: e.name,
      actorId: e.actorId ?? null,
      realActorId: e.realActorId !== undefined ? e.realActorId : currentRealActorId(),
      contextId: e.contextId ?? null,
      courseId: e.courseId ?? null,
      objectType: e.objectType,
      objectId: e.objectId,
      relatedUserId: e.relatedUserId ?? null,
      data: e.data ?? {},
      origin: e.origin ?? 'WEB',
      ip: e.ip ?? null,
      nodeId: currentNodeId(),
    },
  });
  const data = (e.data ?? {}) as Record<string, unknown>;
  const event = webhookEventFor(e.name, data);
  if (!event) return;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  await emitWebhook(db, event, {
    // Module events name the user in their data; a submission is the actor's own.
    userId:
      e.relatedUserId ??
      str(data.userId) ??
      (event === 'submission.submitted' ? (e.actorId ?? null) : null),
    courseId: e.courseId ?? null,
    activityId: str(data.activityId),
    actorId: e.actorId ?? null,
    extra: Object.fromEntries(
      ['method', 'attemptId', 'sumGrades'].filter((k) => k in data).map((k) => [k, data[k]]),
    ),
  });
}
