import 'server-only';
import { buildModuleCtx, listModules } from '@hubium/core';
import type { TodoItem } from '@hubium/module-sdk';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

/** Collects "to do" items from every module that implements the todo hook. */
export async function getTodo(userId: string): Promise<TodoItem[]> {
  const ctx = await getContext();
  const enrolments = await db.enrolment.findMany({
    where: { userId, status: 'ACTIVE', course: { deletedAt: null } },
    select: { courseId: true },
  });
  const courseIds = [...new Set(enrolments.map((e) => e.courseId))];
  if (!courseIds.length) return [];
  const mctx = buildModuleCtx(ctx);
  const lists = await Promise.all(
    listModules().map((m) => m.todo?.(mctx, userId, courseIds).catch(() => []) ?? []),
  );
  return lists
    .flat()
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 10);
}
