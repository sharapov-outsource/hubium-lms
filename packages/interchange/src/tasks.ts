import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForbiddenError,
  getAllSettings,
  loadUserAccess,
  NotFoundError,
  Permissions,
  type RequestContext,
  userLocale,
} from '@hubium/core';
import { fileUrl, storeFileFromPath } from '@hubium/core/files/files';
import { consumeUpload } from '@hubium/core/files/uploads';
import { enqueue } from '@hubium/core/jobs/jobs';
import type { BackgroundTask, Db, Prisma } from '@hubium/db';
import { discardCourse, restoreCourse, writeCourseArchive } from './hubium.ts';
import { importMbz, readMbz } from './mbz.ts';

// Course imports and backups run as background tasks. An import: the browser uploads the
// archive (resumable), the worker restores it on behalf of the user and stores the report on
// the task. A backup: the worker writes the archive to the course's backup area, where those
// who may back the course up download it.

export const IMPORT_JOB = 'interchange.import';
export const BACKUP_JOB = 'interchange.backup';

/**
 * Imports and backups may run for hours, with a heartbeat: a worker that stops halfway (a
 * crash, a restart) is noticed within minutes and the job is taken up once more, which finds
 * its task RUNNING and cleans up after it.
 */
const LONG_JOB = { expireInSeconds: 6 * 3600, heartbeatSeconds: 300, retryLimit: 1 };
/** A task QUEUED or RUNNING this long has lost its job (see failLostTasks). */
const LOST_AFTER_MS = 7 * 3600_000;
export const INTERRUPTED = 'The task was interrupted when the server stopped; start it again';

/** Where a course's backups are kept, and how many: a new one replaces the oldest. */
export const BACKUP_AREA = { component: 'backup', area: 'course' } as const;
export const BACKUPS_KEPT = 3;

export async function startImport(
  db: Db,
  userId: string,
  input: { uploadId: string; categoryId: string; kind: 'hubium' | 'mbz' },
): Promise<string> {
  // the job is queued with the task, or neither is
  return db.$transaction(async (tx) => {
    const task = await tx.backgroundTask.create({
      data: {
        type: input.kind === 'mbz' ? 'IMPORT_MBZ' : 'RESTORE',
        createdById: userId,
        contextId: input.categoryId,
        input: input as unknown as Prisma.InputJsonValue,
      },
    });
    await enqueue(IMPORT_JOB, { taskId: task.id }, { tx, ...LONG_JOB });
    return task.id;
  });
}

async function userCtx(db: Db, userId: string): Promise<RequestContext> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    db,
    actor: { kind: 'user', userId, isSiteAdmin: user.isSiteAdmin },
    perm: new Permissions(db, await loadUserAccess(db, user)),
    now: new Date(),
    locale: userLocale(await getAllSettings(db), user.locale),
    origin: 'WORKER',
  };
}

function systemCtx(db: Db): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: 'en',
    origin: 'WORKER',
  };
}

const errorMessage = (e: unknown) => {
  const fieldErrors = (e as { fieldErrors?: Record<string, string[]> }).fieldErrors;
  const message = fieldErrors
    ? Object.values(fieldErrors).flat().join('; ')
    : e instanceof Error
      ? e.message
      : String(e);
  return message.slice(0, 2000);
};

/** Ends a task its worker left halfway: the course an import was making is deleted. */
async function abandonTask(db: Db, task: BackgroundTask) {
  const courseId = (task.result as { courseId?: string } | null)?.courseId;
  if (courseId && (task.type === 'RESTORE' || task.type === 'IMPORT_MBZ'))
    await discardCourse(systemCtx(db), courseId);
  await db.backgroundTask.updateMany({
    where: { id: task.id, status: task.status },
    data: { status: 'FAILED', finishedAt: new Date(), error: INTERRUPTED },
  });
}

/** Worker job: restores a .hubium or imports a .mbz and records the report. */
export async function runImportTask(db: Db, taskId: string) {
  const task = await db.backgroundTask.findUnique({ where: { id: taskId } });
  if (!task?.createdById) return null;
  // taken up again after the worker stopped: the uploaded archive is gone with that attempt
  if (task.status === 'RUNNING') {
    await abandonTask(db, task);
    return null;
  }
  const claimed = await db.backgroundTask.updateMany({
    where: { id: taskId, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date(), progress: 5 },
  });
  if (!claimed.count) return null;
  const input = task.input as { uploadId: string; categoryId: string; kind: 'hubium' | 'mbz' };
  try {
    const ctx = await userCtx(db, task.createdById);
    const buf = await consumeUpload(db, task.createdById, input.uploadId, (f) => readFile(f.path));
    await db.backgroundTask.update({ where: { id: taskId }, data: { progress: 20 } });
    // the course is named on the task as soon as it exists: should the worker stop, the
    // course goes with the task (above, or failLostTasks)
    const target = {
      categoryId: input.categoryId,
      onCreated: (courseId: string) =>
        db.backgroundTask.update({ where: { id: taskId }, data: { result: { courseId } } }),
    };
    const report =
      input.kind === 'mbz'
        ? await importMbz(ctx, await readMbz(buf), target)
        : await restoreCourse(ctx, new Uint8Array(buf), target);
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
    await db.backgroundTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', finishedAt: new Date(), error: errorMessage(e) },
    });
    return null;
  }
}

/** Starts a backup of a course; one this user already has under way is that one. */
export async function startBackup(ctx: RequestContext, courseId: string): Promise<string> {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  await ctx.perm.require('backup:create', courseId);
  const userId = ctx.actor.userId;
  const running = await ctx.db.backgroundTask.findFirst({
    where: {
      type: 'BACKUP',
      contextId: courseId,
      createdById: userId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
    select: { id: true },
  });
  if (running) return running.id;
  return ctx.db.$transaction(async (tx) => {
    const task = await tx.backgroundTask.create({
      data: { type: 'BACKUP', createdById: userId, contextId: courseId },
    });
    await enqueue(BACKUP_JOB, { taskId: task.id }, { tx, ...LONG_JOB });
    return task.id;
  });
}

/** The name of a backup file: the course's short name and when it was made (UTC). */
export function backupName(shortName: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${shortName.replace(/[^\w.-]+/g, '_') || 'course'}-${stamp}.hubium`;
}

/**
 * Worker job: writes a course's archive to a temporary file a little at a time, then stores
 * it in the course's backup area; the oldest beyond those kept go. A backup taken up again
 * after its worker stopped starts over: nothing of the first attempt was kept.
 */
export async function runBackupTask(db: Db, taskId: string) {
  const task = await db.backgroundTask.findUnique({ where: { id: taskId } });
  if (task?.type !== 'BACKUP' || !task.createdById || !task.contextId) return null;
  const claimed = await db.backgroundTask.updateMany({
    where: { id: taskId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'RUNNING', startedAt: new Date(), progress: 5 },
  });
  if (!claimed.count) return null;
  const courseId = task.contextId;
  const dir = await mkdtemp(join(tmpdir(), 'hubium-backup-'));
  try {
    const ctx = await userCtx(db, task.createdById);
    const course = await db.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { shortName: true },
    });
    const path = join(dir, 'course.hubium');
    let shown = 5;
    await writeCourseArchive(ctx, courseId, path, async (done, total) => {
      const progress = Math.floor(5 + (85 * done) / Math.max(1, total));
      if (progress < shown + 5) return;
      shown = progress;
      await db.backgroundTask.update({ where: { id: taskId }, data: { progress } });
    });
    const file = await storeFileFromPath(db, {
      contextId: courseId,
      ...BACKUP_AREA,
      itemId: taskId,
      name: backupName(course.shortName, ctx.now),
      mimeType: 'application/zip',
      filePath: path,
      uploadedById: task.createdById,
      // made of the course's files, each scanned when it was uploaded
      scan: false,
    });
    const older = await db.file.findMany({
      where: { contextId: courseId, ...BACKUP_AREA },
      orderBy: { createdAt: 'desc' },
      skip: BACKUPS_KEPT,
      select: { id: true },
    });
    if (older.length) await db.file.deleteMany({ where: { id: { in: older.map((f) => f.id) } } });
    await db.backgroundTask.update({
      where: { id: taskId },
      data: {
        status: 'SUCCEEDED',
        progress: 100,
        finishedAt: new Date(),
        resultFileId: file.id,
        result: { fileId: file.id, name: file.name, size: Number(file.size) },
      },
    });
    return file.id;
  } catch (e) {
    await db.backgroundTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', finishedAt: new Date(), error: errorMessage(e) },
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface CourseBackupFile {
  id: string;
  name: string;
  size: number;
  createdAt: Date;
  url: string;
}

/** A course's backups, newest first. */
export async function courseBackups(
  ctx: RequestContext,
  courseId: string,
): Promise<CourseBackupFile[]> {
  await ctx.perm.require('backup:create', courseId);
  const files = await ctx.db.file.findMany({
    where: { contextId: courseId, ...BACKUP_AREA },
    orderBy: { createdAt: 'desc' },
  });
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    size: Number(f.size),
    createdAt: f.createdAt,
    url: fileUrl(f),
  }));
}

export async function deleteBackup(ctx: RequestContext, fileId: string): Promise<void> {
  const file = await ctx.db.file.findUnique({ where: { id: fileId } });
  if (file?.component !== BACKUP_AREA.component || file.area !== BACKUP_AREA.area)
    throw new NotFoundError('File');
  await ctx.perm.require('backup:create', file.contextId);
  await ctx.db.file.delete({ where: { id: file.id } });
}

/**
 * Cron: imports and backups whose job is gone (lost with a worker that stopped after its
 * last try, or never queued) end as failed, and a course an import was making is deleted.
 */
export async function failLostTasks(db: Db, now = new Date()): Promise<{ failed: number }> {
  const before = new Date(now.getTime() - LOST_AFTER_MS);
  const lost = await db.backgroundTask.findMany({
    where: {
      type: { in: ['BACKUP', 'RESTORE', 'IMPORT_MBZ'] },
      OR: [
        { status: 'RUNNING', startedAt: { lt: before } },
        { status: 'QUEUED', createdAt: { lt: before } },
      ],
    },
  });
  for (const task of lost) await abandonTask(db, task);
  return { failed: lost.length };
}
