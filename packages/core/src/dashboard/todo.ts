import type { TodoItem } from '@hubium/module-sdk';
import type { RequestContext } from '../context.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { enabledModules } from '../settings/modules.ts';

/**
 * "To do" items from every enabled module with a todo hook (assignments to submit or grade,
 * quizzes to take), soonest first. The hooks check permissions through `ctx`, so `ctx` must
 * act as `userId` (a mentor's view passes a read-only context of the mentee).
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
  return lists
    .flat()
    .filter((i) => !opts.kinds || opts.kinds.includes(i.kind))
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, opts.limit ?? 10);
}
