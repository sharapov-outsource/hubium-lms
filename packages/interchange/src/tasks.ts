import { readFile } from 'node:fs/promises';
import { loadUserAccess, Permissions, type RequestContext } from '@hubium/core';
import { consumeUpload } from '@hubium/core/files/uploads';
import { enqueue } from '@hubium/core/jobs/jobs';
import type { Db, Prisma } from '@hubium/db';
import { restoreCourse } from './hubium.ts';
import { importMbz, readMbz } from './mbz.ts';

// Course imports run as background tasks: the browser uploads the archive (resumable),
// the worker restores it on behalf of the user and stores the report on the task.

export const IMPORT_JOB = 'interchange.import';

export async function startImport(
  db: Db,
  userId: string,
  input: { uploadId: string; categoryId: string; kind: 'hubium' | 'mbz' },
): Promise<string> {
  const task = await db.backgroundTask.create({
    data: {
      type: input.kind === 'mbz' ? 'IMPORT_MBZ' : 'RESTORE',
      createdById: userId,
      contextId: input.categoryId,
      input: input as unknown as Prisma.InputJsonValue,
    },
  });
  await enqueue(IMPORT_JOB, { taskId: task.id });
  return task.id;
}

async function userCtx(db: Db, userId: string): Promise<RequestContext> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    db,
    actor: { kind: 'user', userId, isSiteAdmin: user.isSiteAdmin },
    perm: new Permissions(db, await loadUserAccess(db, user)),
    now: new Date(),
    locale: user.locale === 'en' ? 'en' : 'ru',
    origin: 'WORKER',
  };
}

/** Worker job: restores a .hubium or imports a .mbz and records the report. */
export async function runImportTask(db: Db, taskId: string) {
  const task = await db.backgroundTask.findUnique({ where: { id: taskId } });
  if (task?.status !== 'QUEUED' || !task.createdById) return null;
  const input = task.input as { uploadId: string; categoryId: string; kind: 'hubium' | 'mbz' };
  await db.backgroundTask.update({
    where: { id: taskId },
    data: { status: 'RUNNING', startedAt: new Date(), progress: 5 },
  });
  try {
    const ctx = await userCtx(db, task.createdById);
    const buf = await consumeUpload(db, task.createdById, input.uploadId, (f) => readFile(f.path));
    await db.backgroundTask.update({ where: { id: taskId }, data: { progress: 20 } });
    const report =
      input.kind === 'mbz'
        ? await importMbz(ctx, await readMbz(buf), { categoryId: input.categoryId })
        : await restoreCourse(ctx, new Uint8Array(buf), { categoryId: input.categoryId });
    await db.backgroundTask.update({
      where: { id: taskId },
      data: {
        status: 'SUCCEEDED',
        progress: 100,
        finishedAt: new Date(),
        result: report as unknown as Prisma.InputJsonValue,
      },
    });
    return report;
  } catch (e) {
    const fieldErrors = (e as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    const message = fieldErrors
      ? Object.values(fieldErrors).flat().join('; ')
      : e instanceof Error
        ? e.message
        : String(e);
    await db.backgroundTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) },
    });
    return null;
  }
}
