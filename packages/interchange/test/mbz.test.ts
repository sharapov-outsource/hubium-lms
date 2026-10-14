import { ctxFor, useTestDb } from '@hubium/core/testing';
import { courseFixture } from '@hubium/core/testing/course-fixture';
import { beforeAll, describe, expect, it } from 'vitest';
import { importMbz, type MbzReport, readMbz } from '../src/mbz.ts';
import { mbzFixture } from './mbz-fixture.ts';

describe('.mbz import', () => {
  const t = useTestDb();
  let report: MbzReport;

  beforeAll(async () => {
    const f = await courseFixture(t.db, 'MBZHOST');
    const course = await t.db.course.findUniqueOrThrow({ where: { id: f.courseId } });
    const admin = await ctxFor(t.db, 'admin@test.local');
    report = await importMbz(admin, await readMbz(await mbzFixture()), {
      categoryId: course.categoryId,
    });
  });

  it('reports what was imported and what was not', () => {
    expect(report).toMatchObject({
      moodleRelease: '4.5 (Build: 20241007)',
      sections: 2,
      activities: 7,
      questions: 5,
    });
    expect(report.warnings.join('\n')).toContain('Формула');
    expect(report.warnings.join('\n')).toContain('Новости');
    expect(report.warnings.join('\n')).toContain('"Вики" (wiki)');
  });

  it('recreates the course, sections and activities in order', async () => {
    const course = await t.db.course.findUniqueOrThrow({ where: { id: report.courseId } });
    expect(course).toMatchObject({ fullName: 'Python из Moodle', shortName: 'MOODLE-PY' });
    expect(course.summary).toMatch(/\/files\/[0-9a-f-]{36}\/logo\.png/);
    const sections = await t.db.courseSection.findMany({
      where: { courseId: course.id },
      orderBy: { rank: 'asc' },
    });
    expect(sections[1]).toMatchObject({ title: 'Тема 1', summary: '<p>Первая тема</p>' });
    const acts = await t.db.activity.findMany({
      where: { courseId: course.id },
      orderBy: { rank: 'asc' },
    });
    const bySection = (i: number) =>
      acts.filter((a) => a.sectionId === sections[i]!.id).map((a) => `${a.moduleKey}:${a.name}`);
    expect(bySection(0)).toEqual(['page:Введение', 'url:Документация']);
    expect(bySection(1)).toEqual([
      'quiz:Тест',
      'assign:Задание',
      'file:Методичка',
      'forum:Вопросы',
      'label:Вики',
    ]);
  });

  it('maps settings, embedded files and resources', async () => {
    const acts = await t.db.activity.findMany({ where: { courseId: report.courseId } });
    const get = (name: string) => acts.find((a) => a.name === name)!;
    expect((get('Введение').settings as { content: string }).content).toMatch(
      /\/files\/[0-9a-f-]{36}\/diagram\.png/,
    );
    expect(get('Документация').settings).toMatchObject({ url: 'https://docs.python.org/3/' });
    expect(get('Задание')).toMatchObject({ visibility: 'HIDDEN' });
    expect(get('Задание').settings).toMatchObject({
      gradeMax: 20,
      dueAt: '2026-01-01T00:00:00.000Z',
    });
    expect(get('Тест').settings).toMatchObject({
      timeLimitMin: 15,
      attempts: 2,
      gradeMax: 10,
      gradeMethod: 'HIGHEST',
    });
    expect(get('Вопросы').settings).toMatchObject({ type: 'qanda' });
    expect(
      await t.db.file.count({ where: { contextId: get('Методичка').id, name: 'guide.pdf' } }),
    ).toBe(1);
  });

  it('imports questions (latest version) and quiz slots', async () => {
    const quiz = await t.db.activity.findFirstOrThrow({
      where: { courseId: report.courseId, moduleKey: 'quiz' },
    });
    const slots = await t.db.quizSlot.findMany({
      where: { activityId: quiz.id },
      orderBy: { slot: 'asc' },
      include: { question: true },
    });
    expect(slots.map((s) => [s.kind, s.question?.name ?? null, Number(s.maxMark), s.page])).toEqual(
      [
        ['FIXED', 'Тип 3.14', 1, 1],
        ['FIXED', 'Комментарий', 2, 1],
        ['RANDOM', null, 1, 2],
      ],
    );
    expect(slots[1]!.question!.data).toMatchObject({ correct: true, feedbackTrue: 'Верно' });
    // access rules and navigation come along; an address Hubium cannot read is reported
    expect(quiz.settings).toMatchObject({
      perPage: 2,
      password: 'Секрет-1',
      subnet: '192.168.1.0/24',
      delay1Min: 10,
      delay2Min: 61,
      navMethod: 'sequential',
      // adaptive mode has no equal here: interactive, reported
      behaviour: 'interactive',
      duringFeedback: true,
      duringRightAnswer: false,
    });
    expect(report.warnings).toContainEqual(expect.stringContaining('office'));
    expect(report.warnings).toContainEqual(expect.stringContaining('adaptive'));
    expect(slots[0]!.question!.hints).toEqual([
      { text: '<p>Посмотрите на точку</p>', clearWrong: true, showNumCorrect: false },
    ]);
    const cat = await t.db.questionCategory.findFirstOrThrow({
      where: { contextId: report.courseId },
    });
    expect(cat.name).toBe('По умолчанию для курса');
    // ordering (items by their place) and drag and drop into text
    const byName = async (name: string) =>
      t.db.question.findFirstOrThrow({ where: { categoryId: cat.id, name } });
    expect((await byName('Порядок')).data).toMatchObject({
      items: [{ text: 'Написать' }, { text: 'Выполнить' }, { text: 'Проверить' }],
      grading: 'longestOrderedSubset',
      select: 'all',
      layout: 'horizontal',
      numbering: 'abc',
      showGrading: false,
      feedbackCorrect: 'Верно',
    });
    // a Cloze question rebuilt from its gaps; the gaps are not questions of their own
    const cloze = await byName('Вложенные');
    expect(cloze.text).toBe('<p>Столица — {1:SA:=Париж#Верно}, тип — {2:MCV:=list~tuple}</p>');
    expect(cloze.data).toMatchObject({
      parts: [
        { kind: 'shortanswer', weight: 1 },
        { kind: 'multichoice', weight: 2, display: 'vertical' },
      ],
    });
    expect(await t.db.question.count({ where: { name: { startsWith: 'Вложенные ' } } })).toBe(0);
    expect((await byName('Перетаскивание')).data).toMatchObject({
      shuffle: false,
      choices: [
        { text: 'list', group: 1, infinite: false },
        { text: 'tuple', group: 2, infinite: true },
      ],
    });
    expect(slots[2]!.categoryId).toBe(cat.id);
  });

  it('a failed import leaves no course or question bank behind', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const before = await t.db.course.count();
    const categoriesBefore = await t.db.questionCategory.count();
    // fail half-way: the course, its sections and question categories already exist
    const db = new Proxy(t.db, {
      get: (o, p) =>
        p === 'question'
          ? new Proxy(o.question, {
              get: (q, k) =>
                k === 'create'
                  ? async () => {
                      throw new Error('boom');
                    }
                  : Reflect.get(q, k),
            })
          : Reflect.get(o, p),
    });
    const category = await t.db.category.findFirstOrThrow();
    await expect(
      importMbz({ ...admin, db }, await readMbz(await mbzFixture()), { categoryId: category.id }),
    ).rejects.toThrow('boom');
    expect(await t.db.course.count()).toBe(before);
    expect(await t.db.questionCategory.count()).toBe(categoriesBefore);
  });

  it('rejects archives that are not Moodle backups', async () => {
    await expect(readMbz(Buffer.from('nope'))).rejects.toThrow();
  });
});
