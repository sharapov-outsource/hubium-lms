import { type Db, withWriteScope } from '@hubium/db';
import { Permissions } from '../access/permissions.ts';
import { markActivityViewed } from '../completion/completion.ts';
import type { RequestContext } from '../context.ts';
import { recordCourseAccess } from '../courses/courses.ts';
import { type LogEventInput, logEvent } from '../events/log.ts';
import { noteUserAccess } from '../users/last-access.ts';

// Side records of what people look at and use: their last visit, the course and activity
// they opened last, an activity viewed (which may complete it), the last use of an API
// token and the log of an access (a data export). Nobody asks for them, so they are not
// operations, yet others see them (mentors, teachers, administrators). Pages and the API
// record them through touch(), in the touch write scope; a local node will send them to
// the cloud instead of writing its read-only copy of the database (docs/PLAN.md).

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
  return withWriteScope('touch', t.kind, () => record(db, t, at), { now: at });
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
