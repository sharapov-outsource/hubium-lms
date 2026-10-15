import { canReadFile } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import { capturedJobs, ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportCourse, readBackup, restoreCourse } from '../src/hubium.ts';
import {
  BACKUP_JOB,
  BACKUPS_KEPT,
  courseBackups,
  deleteBackup,
  failLostTasks,
  IMPORT_JOB,
  INTERRUPTED,
  runBackupTask,
  runImportTask,
  startBackup,
  startImport,
} from '../src/tasks.ts';

describe('course backups and imports in the background', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let categoryId: string;
  beforeAll(async () => {
    f = await courseFixture(t.db, 'TASKS');
    ({ categoryId } = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } }));
  });

  const stored = async (key: string) => {
    const chunks: Buffer[] = [];
    for await (const c of await getStorage().getStream(key)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  /** A course as an import that was stopped halfway leaves it. */
  const halfMade = async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    return (await restoreCourse(admin, await exportCourse(admin, f.courseId), { categoryId }))
      .courseId;
  };

  it("backs a course up in the worker, into the course's backups", async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const taskId = await startBackup(teacher, f.courseId);
    // queued for as long as hours, with a heartbeat that notices a stopped worker
    expect(capturedJobs.at(-1)).toMatchObject({
      name: BACKUP_JOB,
      data: { taskId },
      opts: { heartbeatSeconds: 300, retryLimit: 1 },
    });
    // the one under way is the one asked for again
    expect(await startBackup(teacher, f.courseId)).toBe(taskId);

    const fileId = await runBackupTask(t.db, taskId);
    expect(await t.db.backgroundTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'SUCCEEDED',
      progress: 100,
      resultFileId: fileId,
    });
    const [backup] = await courseBackups(teacher, f.courseId);
    expect(backup).toMatchObject({
      id: fileId,
      name: expect.stringMatching(/^TASKS-\d{8}-\d{4}\.hubium$/),
    });
    const file = await t.db.file.findUniqueOrThrow({
      where: { id: fileId! },
      include: { blob: true },
    });
    expect(readBackup(await stored(file.blob.storageKey)).course.course.id).toBe(f.courseId);
    // those who may back the course up download it, learners do not
    const student = await ctxFor(t.db, f.users.student1!);
    expect(await canReadFile(teacher, file)).toBe(true);
    expect(await canReadFile(student, file)).toBe(false);
    await expect(startBackup(student, f.courseId)).rejects.toThrow();
    await expect(courseBackups(student, f.courseId)).rejects.toThrow();
  });

  it('keeps the latest backups, and deletes one on request', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const [first] = await courseBackups(teacher, f.courseId);
    for (let i = 0; i < BACKUPS_KEPT; i++)
      await runBackupTask(t.db, await startBackup(teacher, f.courseId));
    const kept = await courseBackups(teacher, f.courseId);
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.map((b) => b.id)).not.toContain(first!.id);
    await expect(
      deleteBackup(await ctxFor(t.db, f.users.student1!), kept[0]!.id),
    ).rejects.toThrow();
    await deleteBackup(teacher, kept[0]!.id);
    expect(await courseBackups(teacher, f.courseId)).toHaveLength(BACKUPS_KEPT - 1);
  });

  it('queues an import with its task', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const taskId = await startImport(t.db, admin.perm.userId!, {
      uploadId: crypto.randomUUID(),
      categoryId,
      kind: 'hubium',
    });
    expect(capturedJobs.at(-1)).toMatchObject({
      name: IMPORT_JOB,
      data: { taskId },
      opts: { heartbeatSeconds: 300, retryLimit: 1 },
    });
    await t.db.backgroundTask.delete({ where: { id: taskId } });
  });

  it('an import taken up again after its worker stopped deletes the course it was making', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const courseId = await halfMade();
    const task = await t.db.backgroundTask.create({
      data: {
        type: 'RESTORE',
        status: 'RUNNING',
        startedAt: new Date(),
        createdById: admin.perm.userId!,
        contextId: categoryId,
        result: { courseId },
      },
    });
    expect(await runImportTask(t.db, task.id)).toBeNull();
    expect(await t.db.course.findUnique({ where: { id: courseId } })).toBeNull();
    expect(await t.db.backgroundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: 'FAILED',
      error: INTERRUPTED,
    });
  });

  it('ends imports and backups whose job was lost', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const createdById = admin.perm.userId!;
    const courseId = await halfMade();
    const longAgo = new Date(Date.now() - 8 * 3600_000);
    const lost = await t.db.backgroundTask.create({
      data: {
        type: 'IMPORT_MBZ',
        status: 'RUNNING',
        startedAt: longAgo,
        createdById,
        contextId: categoryId,
        result: { courseId },
      },
    });
    const neverQueued = await t.db.backgroundTask.create({
      data: { type: 'BACKUP', createdAt: longAgo, createdById, contextId: f.courseId },
    });
    const recent = await t.db.backgroundTask.create({
      data: { type: 'RESTORE', status: 'RUNNING', startedAt: new Date(), createdById },
    });
    expect(await failLostTasks(t.db)).toEqual({ failed: 2 });
    expect(await t.db.course.findUnique({ where: { id: courseId } })).toBeNull();
    const status = async (id: string) =>
      (await t.db.backgroundTask.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(lost.id)).toBe('FAILED');
    expect(await status(neverQueued.id)).toBe('FAILED');
    expect(await status(recent.id)).toBe('RUNNING');
  });
});
