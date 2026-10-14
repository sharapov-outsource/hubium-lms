import {
  createManualItem,
  displayCalculations,
  importGift,
  runModuleAction,
  saveGradeCategory,
  saveLetters,
  saveScale,
  setGradeCalculation,
  updateGradeItem,
} from '@hubium/core';
import { enrolUsers } from '@hubium/core/enrol/enrol';
import { fileUrl, storeFile } from '@hubium/core/files/files';
import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { createUserRecord } from '@hubium/core/users/users';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMissingSections,
  duplicateCourse,
  exportCourse,
  importActivities,
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
    const essay = await f.addActivity(
      'assign',
      'Эссе',
      { gradeMax: 20, gradingMethod: 'rubric' },
      {
        availability: {
          op: '&',
          c: [{ type: 'completion', activityId: pageId, state: 'complete' }],
        },
      },
    );
    await t.db.gradingDefinition.create({
      data: {
        activityId: essay.id,
        method: 'RUBRIC',
        definition: {
          criteria: [
            {
              id: 'c1',
              description: 'Структура',
              levels: [
                { id: 'l0', score: 0, definition: 'Нет' },
                { id: 'l1', score: 2, definition: 'Есть' },
              ],
            },
          ],
          lockZeroPoints: true,
        },
      },
    });
    await importGift.run(sys, {
      courseId: f.courseId,
      gift: '::Q1:: 2+2? {=4 ~5}\n\n::Q2:: Небо синее {T}',
    });
    quizId = (await f.addActivity('quiz', 'Тест', { gradeMax: 10 })).id;
    const qs = await t.db.question.findMany({ where: { category: { contextId: f.courseId } } });
    await t.db.questionDataset.create({
      data: {
        categoryId: qs[0]!.categoryId,
        name: 'k',
        min: 1,
        max: 9,
        decimals: 0,
        items: [3, 5],
      },
    });
    await t.db.question.update({
      where: { id: qs[0]!.id },
      data: {
        penalty: 0.5,
        hints: [{ text: '<p>Подумайте</p>', clearWrong: true, showNumCorrect: false }],
      },
    });
    await runModuleAction(sys, quizId, 'addQuestions', { questionIds: qs.map((q) => q.id) });
    const group = await t.db.group.create({ data: { courseId: f.courseId, name: 'Группа А' } });
    const grouping = await t.db.grouping.create({
      data: { courseId: f.courseId, name: 'Поток 1', groups: { create: [{ groupId: group.id }] } },
    });
    await t.db.activity.updateMany({
      where: { courseId: f.courseId, name: 'Эссе' },
      data: { groupMode: 'SEPARATE', groupingId: grouping.id },
    });
    // gradebook setup: a weighted category holding the essay, a scale item, own letters
    const { id: catId } = await saveGradeCategory.run(sys, {
      courseId: f.courseId,
      name: 'Контрольные',
      aggregation: 'MEAN',
      weight: 2,
      idNumber: 'tests',
    });
    const essayItem = await t.db.gradeItem.findFirstOrThrow({
      where: { courseId: f.courseId, activity: { name: 'Эссе' } },
    });
    await updateGradeItem.run(sys, {
      id: essayItem.id,
      categoryId: catId,
      display: 'PERCENT',
      idNumber: 'essay',
    });
    // a calculated item over the essay and the category
    const { id: finalId } = await createManualItem.run(sys, {
      courseId: f.courseId,
      name: 'Итог',
      idNumber: 'final',
      gradeMax: 100,
    } as never);
    await setGradeCalculation.run(sys, {
      id: finalId,
      calculation: '=[[essay]] + [[tests]]',
    });
    const { id: scaleId } = await saveScale.run(sys, {
      courseId: f.courseId,
      name: 'Зачёт',
      items: ['Не зачтено', 'Зачтено'],
    });
    await createManualItem.run(sys, { courseId: f.courseId, name: 'Допуск', scaleId });
    await saveLetters.run(sys, {
      contextId: f.courseId,
      letters: [
        { lowerBound: 60, letter: 'P' },
        { lowerBound: 0, letter: 'F' },
      ],
    });
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
    // the datasets the categories share come along
    expect(
      await t.db.questionDataset.findMany({
        where: { categoryId: { in: cats.map((c) => c.id) } },
        select: { name: true, items: true },
      }),
    ).toEqual([{ name: 'k', items: [3, 5] }]);
    // the penalty and hints of the interactive behaviour come along
    expect(slots.map((s) => [Number(s.question!.penalty), s.question!.hints])).toContainEqual([
      0.5,
      [{ text: '<p>Подумайте</p>', clearWrong: true, showNumCorrect: false }],
    ]);
    // the rubric the essay is graded with comes along
    const rubric = await t.db.gradingDefinition.findFirstOrThrow({
      where: { activityId: assign.id },
    });
    expect(rubric.method).toBe('RUBRIC');
    expect(JSON.stringify(rubric.definition)).toContain('Структура');
    // grade items and groups exist
    expect(
      await t.db.gradeItem.count({ where: { activityId: { in: [assign.id, quiz.id] } } }),
    ).toBe(2);
    expect(await t.db.group.count({ where: { courseId: r.courseId, name: 'Группа А' } })).toBe(1);
    // the grouping comes along with its group, and the assignment stays limited to it
    const grouping = await t.db.grouping.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Поток 1' },
      include: { groups: { include: { group: true } } },
    });
    expect(grouping.groups.map((g) => g.group.name)).toEqual(['Группа А']);
    expect(assign).toMatchObject({ groupMode: 'SEPARATE', groupingId: grouping.id });
    // the gradebook setup comes along
    const cat = await t.db.gradeCategory.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Контрольные' },
    });
    expect([cat.aggregation, Number(cat.weight)]).toEqual(['MEAN', 2]);
    const essayItem = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: assign.id } });
    expect([essayItem.categoryId, essayItem.display, essayItem.idNumber]).toEqual([
      cat.id,
      'PERCENT',
      'essay',
    ]);
    // the formula follows the copied essay item and category
    expect(cat.idNumber).toBe('tests');
    const [copiedItems, copiedCats] = await Promise.all([
      t.db.gradeItem.findMany({ where: { courseId: r.courseId } }),
      t.db.gradeCategory.findMany({ where: { courseId: r.courseId } }),
    ]);
    const final = copiedItems.find((i) => i.name === 'Итог')!;
    expect(final.calculation).toBe(`=##gi${essayItem.id}## + ##gc${cat.id}##`);
    expect(displayCalculations(copiedItems, copiedCats).get(final.id)).toBe(
      '=[[essay]] + [[tests]]',
    );
    const scale = await t.db.scale.findFirstOrThrow({ where: { courseId: r.courseId } });
    expect(scale.items).toEqual(['Не зачтено', 'Зачтено']);
    const admission = await t.db.gradeItem.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Допуск' },
    });
    expect([admission.gradeType, admission.scaleId]).toEqual(['SCALE', scale.id]);
    const letters = await t.db.gradeLetter.findMany({
      where: { contextId: r.courseId },
      orderBy: { lowerBound: 'desc' },
    });
    expect(letters.map((l) => l.letter)).toEqual(['P', 'F']);
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

  it('sanitises HTML and settings from a tampered archive', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const entries = unzipSync(zip);
    const body = JSON.parse(strFromU8(entries['course.json']!));
    const evil = '<p>ok</p><script>alert(1)</script><img src="x" onerror="alert(2)">';
    body.course.summary = evil;
    body.sections[0].summary = evil;
    const page = body.activities.find((a: { name: string }) => a.name === 'Введение');
    page.intro = evil;
    page.settings = { content: evil, junk: 'x' };
    body.questions[0].text = evil;
    body.questions.push({ ...body.questions[1], id: crypto.randomUUID(), type: 'EVAL' });
    entries['course.json'] = strToU8(JSON.stringify(body));
    const r = await restoreCourse(admin, zipSync(entries), { categoryId: course.categoryId });
    expect(r.warnings).toHaveLength(1);

    const copy = await t.db.course.findUniqueOrThrow({
      where: { id: r.courseId },
      include: { sections: { orderBy: { rank: 'asc' } } },
    });
    const act = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Введение' },
    });
    const qs = await t.db.question.findMany({ where: { category: { contextId: r.courseId } } });
    expect(qs).toHaveLength(2);
    const html = [
      copy.summary,
      copy.sections[0]!.summary,
      act.intro,
      (act.settings as { content: string }).content,
      ...qs.map((q) => q.text),
    ];
    for (const h of html) {
      expect(h).not.toMatch(/<script|onerror/);
    }
    expect(act.settings).not.toHaveProperty('junk');
  });

  it('restores courses with more sections than a new course may have', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const entries = unzipSync(zip);
    const body = JSON.parse(strFromU8(entries['course.json']!));
    const extra = Array.from({ length: 60 }, (_, i) => ({
      id: crypto.randomUUID(),
      title: `Неделя ${i + 1}`,
      summary: '',
      visible: true,
      availability: null,
    }));
    body.sections.push(...extra);
    entries['course.json'] = strToU8(JSON.stringify(body));
    const r = await restoreCourse(admin, zipSync(entries), { categoryId: course.categoryId });
    const sections = await t.db.courseSection.findMany({
      where: { courseId: r.courseId },
      orderBy: { rank: 'asc' },
    });
    expect(sections).toHaveLength(body.sections.length);
    expect(sections.at(-1)!.title).toBe('Неделя 60');
  });

  it('imports chosen activities into another course', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const target = await courseFixture(t.db, 'IMPORT2');
    await saveScale.run(admin, { courseId: target.courseId, name: 'Зачёт', items: ['Нет', 'Да'] });
    const essayId = (await t.db.activity.findFirstOrThrow({
      where: { courseId: f.courseId, name: 'Эссе' },
    }))!.id;
    // a section of its own for the page, which the target course does not have
    await addMissingSections(admin, f.courseId, 2);
    const third = await t.db.courseSection.findFirstOrThrow({
      where: { courseId: f.courseId },
      orderBy: { rank: 'desc' },
    });
    await t.db.activity.update({ where: { id: pageId }, data: { sectionId: third.id } });

    const teacher = await ctxFor(t.db, target.users.teacher!);
    await expect(
      importActivities(teacher, {
        sourceCourseId: target.courseId,
        targetCourseId: target.courseId,
        activityIds: [essayId],
      }),
    ).rejects.toMatchObject({ fieldErrors: { sourceCourseId: ['Choose another course'] } });

    const r = await importActivities(admin, {
      sourceCourseId: f.courseId,
      targetCourseId: target.courseId,
      activityIds: [essayId, quizId, pageId],
    });
    expect(r).toMatchObject({ activities: 3, sections: 1, questions: 2 });
    const sections = await t.db.courseSection.findMany({
      where: { courseId: target.courseId },
      orderBy: { rank: 'asc' },
      include: { activities: { orderBy: { rank: 'asc' } } },
    });
    expect(sections.map((s) => s.activities.map((a) => a.name))).toEqual([
      [],
      ['Эссе', 'Тест'],
      ['Введение'],
    ]);
    const essay = sections[1]!.activities[0]!;
    // the page it waited for came along, the grouping did not
    expect(JSON.stringify(essay.availability)).toContain(sections[2]!.activities[0]!.id);
    expect(essay.groupingId).toBeNull();
    // the page shows its picture from the new course
    const page = sections[2]!.activities[0]!;
    const pic = await t.db.file.findFirstOrThrow({
      where: { contextId: target.courseId, name: 'pic.png' },
    });
    expect(JSON.stringify(page.settings)).toContain(pic.id);
    expect(JSON.stringify(page.settings)).not.toContain(imageId);
    // the bank comes under a name saying where from; the same-named scale is reused
    expect(
      await t.db.questionCategory.count({
        where: { contextId: target.courseId, name: { endsWith: '(BACKUP1)' } },
      }),
    ).toBeGreaterThan(0);
    expect(await t.db.scale.count({ where: { courseId: target.courseId } })).toBe(1);
    const essayItem = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: essay.id } });
    const root = await t.db.gradeCategory.findFirstOrThrow({
      where: { courseId: target.courseId, parentId: null },
    });
    expect(essayItem).toMatchObject({ categoryId: root.id, idNumber: 'essay' });
    // groups and course settings stay behind
    expect(await t.db.group.count({ where: { courseId: target.courseId } })).toBe(0);

    // a second import of the essay alone: its access rule names a page left behind
    const again = await importActivities(admin, {
      sourceCourseId: f.courseId,
      targetCourseId: target.courseId,
      activityIds: [essayId],
    });
    expect(again).toMatchObject({ activities: 1, sections: 0, questions: 0 });
    const copy = await t.db.activity.findFirstOrThrow({
      where: { courseId: target.courseId, name: 'Эссе', id: { not: essay.id } },
    });
    expect(copy.availability).toBeNull();
    const copyItem = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: copy.id } });
    expect(copyItem.idNumber).toBeNull();

    // a teacher of the target course alone has no rights over the source course
    const other = await createUserRecord(t.db, {
      username: 'import-teacher',
      firstName: 'Импорт',
      lastName: 'Учитель',
      password: 'Import-pass-1',
    });
    await enrolUsers.run(admin, {
      courseId: target.courseId,
      userIds: [other.id],
      roleId: target.roles.editingteacher!,
    });
    await expect(
      importActivities(await ctxFor(t.db, other.id), {
        sourceCourseId: f.courseId,
        targetCourseId: target.courseId,
        activityIds: [essayId],
      }),
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
