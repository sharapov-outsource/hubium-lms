import { type Db, newOpRecord, withWriteScope } from '@hubium/db';
import { Permissions } from '../access/permissions.ts';
import { markActivityViewed } from '../completion/completion.ts';
import type { RequestContext } from '../context.ts';
import { recordCourseAccess } from '../courses/courses.ts';
import { type LogEventInput, logEvent } from '../events/log.ts';
import { isNode } from '../node/config.ts';
import { type JournalActor, journaling, writeJournal } from '../node/journal.ts';
import { nodeTouchesLocally, sendTouchToAgent } from '../node/runtime.ts';
import { noteUserAccess } from '../users/last-access.ts';

// Side records of what people look at and use: their last visit, the course and activity
// they opened last, an activity viewed (which may complete it), the last use of an API
// token and the log of an access (a data export). Nobody asks for them, so they are not
// operations, yet others see them (mentors, teachers, administrators). Pages and the API
// record them through touch(), in the touch write scope. A local node sends them to the
// cloud through its agent instead of writing its read-only replica, and records them
// itself only while it works without a connection (docs/architecture.md §1.7).

export type Touch =
  /** A visit of the signed-in person (at most once a minute: `lastAccessAt` tells). */
  | { kind: 'user.access'; userId: string; lastAccessAt: Date | null }
  /** A request with an API token (at most once a minute: `lastUsedAt` tells). */
  | { kind: 'token.use'; tokenId: string; lastUsedAt: Date | null; ip: string | null }
  /** The course page opened. */
  | { kind: 'course.access'; userId: string; courseId: string }
  /** An activity opened: viewed and the course's last activity when enrolled, and logged. */
  | {
      kind: 'activity.view';
      userId: string;
      courseId: string;
      activityId: string;
      moduleKey: string;
      enrolled: boolean;
    }
  /** An access worth an entry in the event log. */
  | { kind: 'event'; event: LogEventInput };

/** Records what someone looked at or used, at `at`. */
export function touch(db: Db, t: Touch, at = new Date()): Promise<void> {
  if (isNode() && !nodeTouchesLocally()) return sendTouchToAgent(t, at);
  // a node working alone records it in its journal too
  const rec = journaling() ? newOpRecord(false) : undefined;
  return withWriteScope(
    'touch',
    t.kind,
    async () => {
      await record(db, t, at);
      if (rec)
        await writeJournal(
          db,
          {
            kind: 'touch',
            name: t.kind,
            actor: touchActor(t),
            input: touchToWire(t, at),
            at,
            seed: '',
          },
          rec,
        );
    },
    { now: at, record: rec },
  );
}

function touchActor(t: Touch): JournalActor {
  const userId = 'userId' in t ? t.userId : t.kind === 'event' ? t.event.actorId : null;
  return userId ? { kind: 'user', userId } : { kind: 'system' };
}

const DATE_FIELDS = ['lastAccessAt', 'lastUsedAt'] as const;

/** A Touch as JSON (dates as strings), as it travels from a node to the cloud. */
export function touchToWire(t: Touch, at: Date) {
  return { at: at.toISOString(), touch: t };
}

export function touchFromWire(w: { touch: Record<string, unknown> }): Touch {
  const t = { ...w.touch };
  for (const f of DATE_FIELDS) if (typeof t[f] === 'string') t[f] = new Date(t[f] as string);
  return t as unknown as Touch;
}

async function record(db: Db, t: Touch, at: Date): Promise<void> {
  switch (t.kind) {
    case 'user.access':
      return noteUserAccess(db, { id: t.userId, lastAccessAt: t.lastAccessAt }, at);
    case 'token.use':
      // once a minute per token
      if (t.lastUsedAt && at.getTime() - t.lastUsedAt.getTime() <= 60_000) return;
      await db.apiToken.update({
        where: { id: t.tokenId },
        data: { lastUsedAt: at, lastUsedIp: t.ip },
      });
      return;
    case 'course.access':
      return recordCourseAccess(db, t.userId, t.courseId);
    case 'activity.view': {
      if (t.enrolled) {
        // completion follows the activity's rules, whoever evaluates them
        const ctx = systemCtx(db, at);
        await db.$transaction((tx) => markActivityViewed(ctx, tx, t.activityId, t.userId));
        await recordCourseAccess(db, t.userId, t.courseId, t.activityId);
      }
      await logEvent(db, {
        name: 'activity.viewed',
        actorId: t.userId,
        courseId: t.courseId,
        contextId: t.activityId,
        objectType: t.moduleKey,
        objectId: t.activityId,
        origin: 'WEB',
      });
      return;
    }
    case 'event':
      return logEvent(db, t.event);
  }
}

function systemCtx(db: Db, now: Date): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now,
    locale: 'en',
    origin: 'WEB',
  };
}
