import { importGift, runModuleAction } from '@hubium/core';
import { fileUrl, storeFile } from '@hubium/core/files/files';
import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  duplicateCourse,
  exportCourse,
  readBackup,
  restoreCourse,
  rewriteIds,
} from '../src/hubium.ts';

describe('.hubium backup and restore', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let pageId: string;
  let quizId: string;
  let zip: Uint8Array;
  let imageId: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'BACKUP1');
    const sys = await ctxFor(t.db, 'system');
    const image = await storeFile(t.db, {
      contextId: f.courseId,
      component: 'course',
      area: 'editor',
      name: 'pic.png',
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    });
    imageId = image.id;
    pageId = (
      await f.addActivity(
        'page',
        'Введение',
        { content: `<p>Схема:</p><img src="${fileUrl(image)}" alt="схема">` },
        { completionMode: 'MANUAL' },
      )
    ).id;
    await f.addActivity(
      'assign',
      'Эссе',
      { gradeMax: 20 },
      {
        availability: {
          op: '&',
          c: [{ type: 'completion', activityId: pageId, state: 'complete' }],
        },
      },
    );
    await importGift.run(sys, {
      courseId: f.courseId,
      gift: '::Q1:: 2+2? {=4 ~5}\n\n::Q2:: Небо синее {T}',
    });
    quizId = (await f.addActivity('quiz', 'Тест', { gradeMax: 10 })).id;
    const qs = await t.db.question.findMany({ where: { category: { contextId: f.courseId } } });
    await runModuleAction(sys, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });
    await t.db.group.create({ data: { courseId: f.courseId, name: 'Группа А' } });
  });

  it('exports a self-describing archive without learners’ data', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    zip = await exportCourse(teacher, f.courseId);
    const entries = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!));
    expect(manifest).toMatchObject({ format: 'hubium-course', formatVersion: 1, userData: false });
    const b = readBackup(zip);
    expect(b.course.activities.map((a) => a.name)).toEqual(['Введение', 'Эссе', 'Тест']);
    expect(b.course.questions).toHaveLength(2);
    expect((b.course.activities[2]!.module as { slots: unknown[] }).slots).toHaveLength(2);
    expect(b.files.map((x) => x.name)).toContain('pic.png');
    const s1 = await ctxFor(t.db, f.users.student1!);
    await expect(exportCourse(s1, f.courseId)).rejects.toThrow();
  });

  it('restores into a new course with every reference remapped', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const r = await restoreCourse(admin, zip, { categoryId: course.categoryId });
    expect(r).toMatchObject({ activities: 3, questions: 2, files: 1, warnings: [] });
    const copy = await t.db.course.findUniqueOrThrow({ where: { id: r.courseId } });
    expect(copy.shortName).toBe('BACKUP1-1');
    const acts = await t.db.activity.findMany({
      where: { courseId: r.courseId },
      orderBy: { rank: 'asc' },
    });
    const page = acts.find((a) => a.name === 'Введение')!;
    const assign = acts.find((a) => a.name === 'Эссе')!;
    const quiz = acts.find((a) => a.name === 'Тест')!;
    // the embedded image points to the copied file
    const newImage = await t.db.file.findFirstOrThrow({
      where: { contextId: r.courseId, name: 'pic.png' },
    });
    const content = (page.settings as { content: string }).content;
    expect(content).toContain(newImage.id);
    expect(content).not.toContain(imageId);
    // availability refers to the new page
    expect(JSON.stringify(assign.availability)).toContain(page.id);
    expect(JSON.stringify(assign.availability)).not.toContain(pageId);
    // quiz slots use the copied questions
    const slots = await t.db.quizSlot.findMany({
      where: { activityId: quiz.id },
      include: { question: true },
    });
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.question?.categoryId && s.questionId)).toBe(true);
    const cats = await t.db.questionCategory.findMany({ where: { contextId: r.courseId } });
    expect(slots.every((s) => cats.some((c) => c.id === s.question!.categoryId))).toBe(true);
    // grade items and groups exist
    expect(
      await t.db.gradeItem.count({ where: { activityId: { in: [assign.id, quiz.id] } } }),
    ).toBe(2);
    expect(await t.db.group.count({ where: { courseId: r.courseId, name: 'Группа А' } })).toBe(1);
  });

  it('duplicates a course with a new name', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const r = await duplicateCourse(admin, f.courseId, {
      fullName: 'Копия',
      shortName: 'BACKUP1-COPY',
    });
    expect((await t.db.course.findUniqueOrThrow({ where: { id: r.courseId } })).fullName).toBe(
      'Копия',
    );
    await expect(
      duplicateCourse(admin, f.courseId, { fullName: 'Ещё', shortName: 'BACKUP1-COPY' }),
    ).rejects.toThrow();
  });

  it('rejects foreign archives', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    await expect(
      restoreCourse(admin, new Uint8Array([1, 2, 3]), { categoryId: course.categoryId }),
    ).rejects.toMatchObject({ fieldErrors: { file: ['Not a .hubium archive'] } });
  });

  it('rewrites only mapped ids', () => {
    const a = '0190a8f0-0000-7000-8000-000000000001';
    const b = '0190a8f0-0000-7000-8000-000000000002';
    expect(rewriteIds(`x ${a} y ${b}`, new Map([[a, 'NEW']]))).toBe(`x NEW y ${b}`);
  });
});
