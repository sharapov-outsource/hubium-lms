import type { Db, EventOrigin, Prisma } from '@hubium/db';

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
      realActorId: e.realActorId ?? null,
      contextId: e.contextId ?? null,
      courseId: e.courseId ?? null,
      objectType: e.objectType,
      objectId: e.objectId,
      relatedUserId: e.relatedUserId ?? null,
      data: e.data ?? {},
      origin: e.origin ?? 'WEB',
      ip: e.ip ?? null,
    },
  });
}
