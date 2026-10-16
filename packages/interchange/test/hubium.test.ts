import {
  addCourseCompetencies,
  addSection,
  compareRank,
  createActivity,
  createManualItem,
  defaultFields,
  displayCalculations,
  getCourseOutline,
  importGift,
  issueCertificate,
  markBadge,
  runModuleAction,
  saveBadge,
  saveCertificate,
  saveCompetency,
  saveCourseField,
  saveFramework,
  saveGradeCategory,
  saveLetters,
  saveScale,
  setActivityCompetency,
  setBadgeImage,
  setBadgeStatus,
  setCertificateBackground,
  setCertificateStatus,
  setCourseCompetency,
  setGradeCalculation,
  updateGradeItem,
  updateSection,
} from '@hubium/core';
import { enrolUsers } from '@hubium/core/enrol/enrol';
import { fileUrl, storeFile } from '@hubium/core/files/files';
import { getStorage, setStorage } from '@hubium/core/files/storage';
import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { createUserRecord } from '@hubium/core/users/users';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { withArchive } from '../src/archive.ts';
import {
  addMissingSections,
  duplicateActivity,
  duplicateCourse,
  exportCourse,
  freeShortName,
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
    // a custom field value, and one of a field that will be gone by the restore
    const { id: goneId } = await saveCourseField.run(sys, {
      shortName: 'gone',
      name: { ru: 'Удалённое' },
      type: 'text',
    });
    await saveCourseField.run(sys, { shortName: 'hours', name: { ru: 'Часы' }, type: 'text' });
    await t.db.course.update({
      where: { id: f.courseId },
      data: { customFields: { hours: '72', gone: 'x' } },
    });
    await t.db.courseField.delete({ where: { id: goneId } });
  });

  it('exports a self-describing archive without learners’ data', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    zip = await exportCourse(teacher, f.courseId);
    const entries = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!));
    expect(manifest).toMatchObject({ format: 'hubium-course', formatVersion: 1, userData: false });
    const b = await withArchive(zip, readBackup);
    expect(b.course.activities.map((a) => a.name)).toEqual(['Введение', 'Эссе', 'Тест']);
    expect(b.course.questions).toHaveLength(2);
    expect((b.course.activities[2]!.module as { slots: unknown[] }).slots).toHaveLength(2);
    expect(b.files.map((x) => x.name)).toContain('pic.png');
    // pictures go in as they are, the course's description is compressed
    const methods: Record<string, number> = {};
    unzipSync(zip, {
      filter: (e) => {
        methods[e.name] = e.compression;
        return false;
      },
    });
    const pic = b.files.find((x) => x.name === 'pic.png')!;
    expect(methods[`files/${pic.blobId}`]).toBe(0);
    expect(methods['course.json']).toBe(8);
    const s1 = await ctxFor(t.db, f.users.student1!);
    await expect(exportCourse(s1, f.courseId)).rejects.toThrow();
  });

  it('restores into a new course with every reference remapped', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    // the course is hidden while it is being made, and named to whoever waits for it
    const made: { id: string; visible: boolean }[] = [];
    const r = await restoreCourse(admin, zip, {
      categoryId: course.categoryId,
      onCreated: async (id) =>
        made.push(
          await t.db.course.findUniqueOrThrow({
            where: { id },
            select: { id: true, visible: true },
          }),
        ),
    });
    expect(r).toMatchObject({ activities: 3, questions: 2, files: 1, warnings: [] });
    expect(made).toEqual([{ id: r.courseId, visible: false }]);
    const copy = await t.db.course.findUniqueOrThrow({ where: { id: r.courseId } });
    expect(copy.visible).toBe(true);
    expect(copy.shortName).toBe('BACKUP1-1');
    expect(copy.customFields).toEqual({ hours: '72' });
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

  it('carries course badges as drafts with their image and criteria, without awards', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await saveBadge.run(teacher, {
      courseId: f.courseId,
      name: 'Читатель',
      criteria: {
        method: 'any',
        rules: [
          { kind: 'activities', activityIds: [pageId], method: 'all' },
          { kind: 'manual', roleIds: [f.roles.editingteacher!], method: 'all' },
        ],
      },
      expiry: 'days',
      expiresAfterDays: 90,
    });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    await setBadgeImage.run(teacher, { id, name: 'reader.svg', data: strToU8(svg) });
    await setBadgeStatus.run(teacher, { id, status: 'ACTIVE' });
    await markBadge.run(teacher, { badgeId: id, userId: f.users.student1! });
    expect(await t.db.badgeAward.count({ where: { badgeId: id } })).toBe(1);

    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const r = await restoreCourse(admin, await exportCourse(teacher, f.courseId), {
      categoryId: course.categoryId,
    });
    const copy = await t.db.badge.findFirstOrThrow({ where: { courseId: r.courseId } });
    expect(copy).toMatchObject({ name: 'Читатель', status: 'DRAFT', expiresAfterDays: 90 });
    const page = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Введение' },
    });
    expect(copy.criteria).toMatchObject({
      method: 'any',
      rules: expect.arrayContaining([
        expect.objectContaining({ kind: 'activities', activityIds: [page.id] }),
        expect.objectContaining({ kind: 'manual', roleIds: [f.roles.editingteacher!] }),
      ]),
    });
    const image = await t.db.file.findUniqueOrThrow({ where: { id: copy.imageFileId! } });
    expect([image.contextId, image.component, image.itemId]).toEqual([
      r.courseId,
      'badge',
      copy.id,
    ]);
    expect(await t.db.badgeAward.count({ where: { badgeId: copy.id } })).toBe(0);
    await t.db.badge.delete({ where: { id } });
  });

  it('carries certificates as drafts with their layout and background, without issues', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const admin = await ctxFor(t.db, 'admin@test.local');
    const fields = defaultFields('portrait', 'ru');
    const { id } = await saveCertificate.run(teacher, {
      courseId: f.courseId,
      name: 'Слушатель',
      orientation: 'portrait',
      fields,
      onCompletion: false,
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await setCertificateBackground.run(teacher, { id, name: 'bg.jpg', data: jpeg });
    await setCertificateStatus.run(teacher, { id, status: 'ACTIVE' });
    await issueCertificate.run(teacher, { certificateId: id, userId: f.users.student1! });

    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const r = await restoreCourse(admin, await exportCourse(teacher, f.courseId), {
      categoryId: course.categoryId,
    });
    const copy = await t.db.certificate.findFirstOrThrow({ where: { courseId: r.courseId } });
    expect(copy).toMatchObject({
      name: 'Слушатель',
      orientation: 'portrait',
      onCompletion: false,
      status: 'DRAFT',
    });
    expect(copy.fields).toEqual(fields);
    const bg = await t.db.file.findUniqueOrThrow({ where: { id: copy.backgroundFileId! } });
    expect([bg.contextId, bg.component, bg.itemId]).toEqual([r.courseId, 'certificate', copy.id]);
    expect(await t.db.certificateIssue.count({ where: { certificateId: copy.id } })).toBe(0);
    await t.db.certificate.delete({ where: { id } });
  });

  it("carries the course's and activities' competencies by their ID numbers", async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const scale = await saveScale.run(admin, { name: 'Да/нет', items: ['Нет', 'Да'] });
    const fw = await saveFramework.run(admin, {
      shortName: 'Бэкап',
      idNumber: 'BKP',
      scaleId: scale.id,
      scaleConfig: { default: 2, proficient: [2] },
    });
    const c = await saveCompetency.run(admin, {
      frameworkId: fw.id,
      shortName: 'K',
      idNumber: 'K1',
    });
    await addCourseCompetencies.run(admin, { courseId: f.courseId, competencyIds: [c.id] });
    await setCourseCompetency.run(admin, {
      courseId: f.courseId,
      competencyId: c.id,
      ruleOutcome: 'COMPLETE',
    });
    await setActivityCompetency.run(admin, {
      activityId: pageId,
      competencyId: c.id,
      ruleOutcome: 'EVIDENCE',
    });
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, f.courseId), {
      categoryId: course.categoryId,
    });
    expect(
      await t.db.courseCompetency.findMany({
        where: { courseId: r.courseId },
        select: { competencyId: true, ruleOutcome: true },
      }),
    ).toEqual([{ competencyId: c.id, ruleOutcome: 'COMPLETE' }]);
    const page = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, name: 'Введение' },
      include: { competencies: true },
    });
    expect(page.competencies.map((x) => [x.competencyId, x.ruleOutcome])).toEqual([
      [c.id, 'EVIDENCE'],
    ]);
    await t.db.courseCompetency.deleteMany({ where: { competencyId: c.id } });
    await t.db.activityCompetency.deleteMany({ where: { competencyId: c.id } });
  });

  it('duplicates a course with a new name, its files on the same stored content', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const real = getStorage();
    let reads = 0;
    setStorage(
      new Proxy(real, {
        get(o, p) {
          if (p === 'getStream') reads++;
          const v = Reflect.get(o, p);
          return typeof v === 'function' ? v.bind(o) : v;
        },
      }),
    );
    const blobs = await t.db.fileBlob.count();
    let r: Awaited<ReturnType<typeof duplicateCourse>>;
    try {
      r = await duplicateCourse(admin, f.courseId, {
        fullName: 'Копия',
        shortName: 'BACKUP1-COPY',
      });
    } finally {
      setStorage(real);
    }
    expect((await t.db.course.findUniqueOrThrow({ where: { id: r.courseId } })).fullName).toBe(
      'Копия',
    );
    // nothing read or stored again: the copy's picture is a new row on the same content
    expect(reads).toBe(0);
    expect(await t.db.fileBlob.count()).toBe(blobs);
    const [original, copied] = await Promise.all(
      [f.courseId, r.courseId].map((contextId) =>
        t.db.file.findFirstOrThrow({ where: { contextId, name: 'pic.png' } }),
      ),
    );
    expect(copied!.id).not.toBe(original!.id);
    expect(copied!.blobId).toBe(original!.blobId);
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

  it('carries a book with its chapters and their pictures', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'BOOKBK');
    const pic = await storeFile(t.db, {
      contextId: src.courseId,
      component: 'course',
      area: 'editor',
      name: 'fig.png',
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]),
    });
    const { id } = await src.addActivity('book', 'Учебник', { numbering: 'bullets' });
    const teacher = await ctxFor(t.db, src.users.teacher!);
    const first = (await runModuleAction(teacher, id, 'addChapter', {
      title: 'Глава',
      content: `<p><img src="${fileUrl(pic)}" alt="f"></p>`,
    })) as { id: string };
    await runModuleAction(teacher, id, 'addChapter', {
      title: 'Подглава',
      subchapter: true,
      afterId: first.id,
    });
    const course = await t.db.course.findUniqueOrThrow({ where: { id: src.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, src.courseId), {
      categoryId: course.categoryId,
    });
    const copy = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, moduleKey: 'book' },
      include: { bookChapters: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(copy.settings).toMatchObject({ numbering: 'bullets' });
    expect(copy.bookChapters.map((c) => [c.title, c.subchapter])).toEqual([
      ['Глава', false],
      ['Подглава', true],
    ]);
    const newPic = await t.db.file.findFirstOrThrow({
      where: { contextId: r.courseId, name: 'fig.png' },
    });
    expect(copy.bookChapters[0]!.content).toContain(newPic.id);
    expect(copy.bookChapters[0]!.content).not.toContain(pic.id);
  });

  it("carries a video's captions, and says when it has no source to rebuild it from", async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'VIDEOBK');
    const store = (activityId: string, area: string, name: string, data: string) =>
      storeFile(t.db, {
        contextId: activityId,
        component: 'mod.video',
        area,
        name,
        mimeType: area === 'source' ? 'video/mp4' : 'text/vtt',
        data: Buffer.from(data),
      });
    const { id: withSource } = await src.addActivity('video', 'С исходником', {});
    const source = await store(withSource, 'source', 'clip.mp4', 'not really a video');
    const vtt = await store(
      withSource,
      'captions',
      'ru.vtt',
      'WEBVTT\n\n00:00.000 --> 00:01.000\nПривет',
    );
    const asset = await t.db.videoAsset.create({
      data: { activityId: withSource, sourceFileId: source.id, status: 'READY' },
    });
    await t.db.videoCaption.create({
      data: { assetId: asset.id, lang: 'ru', label: 'Русский', fileId: vtt.id },
    });
    // processed with the source deleted afterwards
    const { id: noSource } = await src.addActivity('video', 'Без исходника', {
      deleteSource: true,
    });
    await t.db.videoAsset.create({ data: { activityId: noSource, status: 'READY' } });

    const course = await t.db.course.findUniqueOrThrow({ where: { id: src.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, src.courseId), {
      categoryId: course.categoryId,
    });
    const copyOf = (name: string) =>
      t.db.activity.findFirstOrThrow({
        where: { courseId: r.courseId, name },
        include: { videoAsset: { include: { captions: true } } },
      });
    const copy = await copyOf('С исходником');
    const newVtt = await t.db.file.findFirstOrThrow({
      where: { contextId: copy.id, area: 'captions' },
    });
    expect(copy.videoAsset?.captions).toMatchObject([
      { lang: 'ru', label: 'Русский', fileId: newVtt.id },
    ]);
    expect((await copyOf('Без исходника')).videoAsset).toMatchObject({
      status: 'FAILED',
      error: expect.stringMatching(/no source file/),
    });
    // and the report of the restore says so
    expect(r.warnings).toContainEqual(expect.stringMatching(/^"Без исходника": .*no source file/));
  });

  it('duplicates an activity with what its module keeps, in its own course', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'DUPACT');
    const teacher = await ctxFor(t.db, src.users.teacher!);
    const pic = await storeFile(t.db, {
      contextId: src.courseId,
      component: 'course',
      area: 'editor',
      name: 'fig.png',
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]),
    });
    const { id: book } = await src.addActivity(
      'book',
      'Учебник',
      { numbering: 'bullets' },
      { idNumber: 'BOOK1' },
    );
    await runModuleAction(teacher, book, 'addChapter', {
      title: 'Глава',
      content: `<p><img src="${fileUrl(pic)}" alt="f"></p>`,
    });
    const { id: after } = await src.addActivity('page', 'Следом', { content: '<p>x</p>' });
    const copyName = (n: string) => `${n} (копия)`;

    const { id } = await duplicateActivity(teacher, book, copyName);
    const copy = await t.db.activity.findUniqueOrThrow({
      where: { id },
      include: { bookChapters: true },
    });
    expect(copy).toMatchObject({
      name: 'Учебник (копия)',
      visibility: 'HIDDEN',
      idNumber: null,
      settings: expect.objectContaining({ numbering: 'bullets' }),
    });
    // the module's own data comes along, the course's picture is the same file
    expect(copy.bookChapters.map((c) => c.title)).toEqual(['Глава']);
    expect(copy.bookChapters[0]!.content).toContain(pic.id);
    expect(await t.db.file.count({ where: { contextId: src.courseId, name: 'fig.png' } })).toBe(1);
    // right after the original
    const order = await t.db.activity.findMany({
      where: { courseId: src.courseId, deletedAt: null },
      orderBy: { rank: 'asc' },
      select: { id: true },
    });
    expect(order.map((a) => a.id)).toEqual([book, id, after]);
    // a second copy makes no clash on the course's files
    await duplicateActivity(teacher, book, copyName);

    // an assignment's copy has its settings, its grade item, not the learners' work
    const { id: essay } = await src.addActivity('assign', 'Эссе', { gradeMax: 20 });
    const sub = await t.db.assignSubmission.create({
      data: { activityId: essay, userId: src.users.student1!, status: 'SUBMITTED' },
    });
    await storeFile(t.db, {
      contextId: essay,
      component: 'mod.assign',
      area: 'submission',
      itemId: sub.id,
      name: 'work.txt',
      mimeType: 'text/plain',
      data: Buffer.from('чужая работа'),
    });
    const { id: essayCopy } = await duplicateActivity(teacher, essay, copyName);
    expect(await t.db.file.count({ where: { contextId: essayCopy } })).toBe(0);
    expect(await t.db.gradeItem.findFirst({ where: { activityId: essayCopy } })).toMatchObject({
      gradeMax: expect.anything(),
    });
    expect(await t.db.assignSubmission.count({ where: { activityId: essayCopy } })).toBe(0);
    // learners do not copy
    await expect(
      duplicateActivity(await ctxFor(t.db, src.users.student1!), book, copyName),
    ).rejects.toThrow();

    // a quiz's copy uses the course's questions, not a second bank
    const questions = await t.db.question.count({
      where: { category: { contextId: f.courseId } },
    });
    const { id: quizCopy } = await duplicateActivity(admin, quizId, copyName);
    const slots = (id: string) =>
      t.db.quizSlot.findMany({ where: { activityId: id }, orderBy: { slot: 'asc' } });
    expect((await slots(quizCopy)).map((x) => x.questionId)).toEqual(
      (await slots(quizId)).map((x) => x.questionId),
    );
    expect(await t.db.question.count({ where: { category: { contextId: f.courseId } } })).toBe(
      questions,
    );
  });

  it('carries subsections in their places among the activities; an import flattens them', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'SUBBK');
    const teacher = await ctxFor(t.db, src.users.teacher!);
    const a = await src.addActivity('page', 'A', { content: '<p>A</p>' });
    const section = (await t.db.activity.findUniqueOrThrow({ where: { id: a.id } })).sectionId;
    const { id: sub } = await addSection.run(teacher, {
      courseId: src.courseId,
      parentId: section,
      title: 'Практика',
    });
    await updateSection.run(teacher, {
      id: sub,
      title: 'Практика',
      summary: '<p>Задачи</p>',
      visible: false,
      availability: { op: '&', c: [{ type: 'completion', activityId: a.id, state: 'complete' }] },
    });
    const page = (sectionId: string, name: string) =>
      createActivity.run(teacher, {
        courseId: src.courseId,
        sectionId,
        moduleKey: 'page',
        name,
        settings: { content: `<p>${name}</p>` },
      });
    const b = await page(sub, 'B');
    await page(section, 'C');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: src.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, src.courseId), {
      categoryId: course.categoryId,
    });
    expect(r.sections).toBe(2);
    const outline = await getCourseOutline(admin, r.courseId);
    const copySub = outline.find((s) => s.parentId)!;
    expect(copySub).toMatchObject({ title: 'Практика', summary: '<p>Задачи</p>', visible: false });
    expect(copySub.activities.map((x) => x.activity.name)).toEqual(['B']);
    const copyA = outline.flatMap((s) => s.activities).find((x) => x.activity.name === 'A')!;
    const row = await t.db.courseSection.findUniqueOrThrow({ where: { id: copySub.id } });
    expect(row.availability).toMatchObject({ c: [{ activityId: copyA.activity.id }] });
    // between A and C, as it was
    const items = [
      ...outline.find((s) => s.id === copySub.parentId)!.activities.map((x) => x.activity),
      row,
    ]
      .sort(compareRank)
      .map((x) => ('name' in x ? x.name : x.title));
    expect(items).toEqual(['A', 'Практика', 'C']);

    // an import into another course puts B in the section with the same number
    const target = await courseFixture(t.db, 'SUBBK2');
    await importActivities(admin, {
      sourceCourseId: src.courseId,
      targetCourseId: target.courseId,
      activityIds: [b.id],
    });
    const imported = await t.db.activity.findFirstOrThrow({
      where: { courseId: target.courseId, name: 'B' },
      include: { section: true },
    });
    expect(imported.section.parentId).toBeNull();
    expect(await t.db.courseSection.count({ where: { courseId: target.courseId } })).toBe(2);
  });

  it('carries the questions of a feedback, without its responses', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'FBBK');
    const { id } = await src.addActivity('feedback', 'Отзыв', { anonymous: false });
    const teacher = await ctxFor(t.db, src.users.teacher!);
    const q = (await runModuleAction(teacher, id, 'addItem', {
      type: 'choice',
      label: 'Формат',
      choices: ['Очно', 'Онлайн'],
      required: true,
    })) as { id: string };
    await runModuleAction(teacher, id, 'addItem', { type: 'pagebreak' });
    await runModuleAction(teacher, id, 'addItem', {
      type: 'number',
      label: 'Оценка',
      min: 1,
      max: 5,
    });
    await runModuleAction(await ctxFor(t.db, src.users.student1!), id, 'submit', {
      answers: { [q.id]: 'Очно' },
    });
    const course = await t.db.course.findUniqueOrThrow({ where: { id: src.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, src.courseId), {
      categoryId: course.categoryId,
    });
    const copy = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, moduleKey: 'feedback' },
      include: { feedbackItems: { orderBy: { sortOrder: 'asc' } }, feedbackResponses: true },
    });
    expect(copy.settings).toMatchObject({ anonymous: false });
    expect(copy.feedbackItems.map((i) => [i.type, i.label, i.required, i.options])).toEqual([
      [
        'choice',
        'Формат',
        true,
        { choices: ['Очно', 'Онлайн'], multiple: false, display: 'radio' },
      ],
      ['pagebreak', '', false, {}],
      ['number', 'Оценка', false, { min: 1, max: 5 }],
    ]);
    expect(copy.feedbackResponses).toEqual([]);
  });

  it("carries the teachers' entries of a glossary, without learners' entries or ratings", async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const src = await courseFixture(t.db, 'GLBK');
    const { id } = await src.addActivity('glossary', 'Термины', {
      autoLink: true,
      ratingAggregate: 'sum',
    });
    const teacher = await ctxFor(t.db, src.users.teacher!);
    await runModuleAction(teacher, id, 'addEntry', {
      concept: 'Энтропия',
      definition: '<p>Мера беспорядка</p>',
      aliases: 'энтропии',
      categories: 'Физика',
      autoLink: true,
    });
    const own = (await runModuleAction(await ctxFor(t.db, src.users.student1!), id, 'addEntry', {
      concept: 'Ион',
    })) as { id: string };
    await runModuleAction(teacher, id, 'rate', { entryId: own.id, value: 5 });
    const course = await t.db.course.findUniqueOrThrow({ where: { id: src.courseId } });
    const r = await restoreCourse(admin, await exportCourse(admin, src.courseId), {
      categoryId: course.categoryId,
    });
    const copy = await t.db.activity.findFirstOrThrow({
      where: { courseId: r.courseId, moduleKey: 'glossary' },
      include: { glossaryEntries: { include: { ratings: true } } },
    });
    expect(copy.settings).toMatchObject({ autoLink: true, ratingAggregate: 'sum' });
    expect(copy.glossaryEntries).toMatchObject([
      {
        concept: 'Энтропия',
        definition: '<p>Мера беспорядка</p>',
        aliases: ['энтропии'],
        categories: ['Физика'],
        approved: true,
        autoLink: true,
        authorId: null,
        ratings: [],
      },
    ]);
  });

  it('gives a course from an archive a free short name that fits', async () => {
    expect(await freeShortName(t.db, 'BRAND-NEW')).toBe('BRAND-NEW');
    expect(await freeShortName(t.db, 'BACKUP1')).toMatch(/^BACKUP1-\d+$/);
    // a Moodle course's name may be 255 characters long
    const long = 'L'.repeat(150);
    expect(await freeShortName(t.db, long)).toBe('L'.repeat(100));
    const f = await courseFixture(t.db, 'L'.repeat(100));
    expect(f.courseId).toBeTruthy();
    expect(await freeShortName(t.db, long)).toBe(`${'L'.repeat(98)}-1`);
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
  it("leaves out learners' workshop work and database entries' files", async () => {
    const src = await courseFixture(t.db, 'USERFILES');
    const store = (activityId: string, component: string, area: string, name: string) =>
      storeFile(t.db, {
        contextId: activityId,
        component,
        area,
        name,
        mimeType: 'text/plain',
        data: Buffer.from(name),
        uploadedById: src.users.student1!,
      });
    const workshop = await src.addActivity('workshop', 'Семинар', {});
    await store(workshop.id, 'mod.workshop', 'submission', 'my-essay.txt');
    const data = await src.addActivity('data', 'База', {});
    await store(data.id, 'mod.data', 'content', 'my-entry.txt');
    const b = await withArchive(
      await exportCourse(await ctxFor(t.db, src.users.teacher!), src.courseId),
      readBackup,
    );
    expect(b.files.map((x) => x.name)).not.toContain('my-essay.txt');
    expect(b.files.map((x) => x.name)).not.toContain('my-entry.txt');
  });
});
