import type { TodoItem } from '@hubium/module-sdk';
import { listUserEvents } from '../calendar/calendar.ts';
import type { RequestContext } from '../context.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { enabledModules } from '../settings/modules.ts';

/** How long an activity past its expected completion date stays to do, and how far ahead. */
const EXPECTED_PAST_DAYS = 30;
const EXPECTED_AHEAD_DAYS = 14;

/**
 * "To do" items from every enabled module with a todo hook (assignments to submit or grade,
 * quizzes to take) and the activities due for completion by their expected date, soonest
 * first. The hooks check permissions through `ctx`, so `ctx` must act as `userId` (a
 * mentor's view passes a read-only context of the mentee).
 */
export async function collectTodo(
  ctx: RequestContext,
  userId: string,
  opts: { limit?: number; kinds?: TodoItem['kind'][] } = {},
): Promise<TodoItem[]> {
  const enrolments = await ctx.db.enrolment.findMany({
    where: { userId, status: 'ACTIVE', course: { deletedAt: null } },
    select: { courseId: true },
  });
  const courseIds = [...new Set(enrolments.map((e) => e.courseId))];
  if (!courseIds.length) return [];
  const mctx = buildModuleCtx(ctx);
  const lists = await Promise.all(
    (await enabledModules(ctx.db)).map(
      (m) => m.todo?.(mctx, userId, courseIds).catch(() => []) ?? [],
    ),
  );
  // the calendar keeps these for learners who have not completed the activity yet
  const { now } = ctx;
  const expected = (
    await listUserEvents(ctx.db, userId, {
      from: new Date(now.getTime() - EXPECTED_PAST_DAYS * 86_400_000),
      to: new Date(now.getTime() + EXPECTED_AHEAD_DAYS * 86_400_000),
    })
  ).flatMap((e): TodoItem[] =>
    e.kind === 'EXPECTED' && e.activityId && e.courseId
      ? [
          {
            activityId: e.activityId,
            courseId: e.courseId,
            title: e.title,
            kind: 'complete',
            dueAt: e.startsAt,
            allDay: true,
          },
        ]
      : [],
  );
  return [...lists.flat(), ...expected]
    .filter((i) => !opts.kinds || opts.kinds.includes(i.kind))
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, opts.limit ?? 10);
}
