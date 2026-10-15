import { displayCalculations, saveCourseField } from '@hubium/core';
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
    for (const [shortName, type, choices] of [
      ['level', 'menu', ['Начальный', 'Средний']],
      ['starts', 'date', []],
      ['about', 'textarea', []],
    ] as const)
      await saveCourseField.run(admin, { shortName, name: { ru: shortName }, type, choices });
    report = await importMbz(admin, await readMbz(await mbzFixture()), {
      categoryId: course.categoryId,
    });
  });

  it('reports what was imported and what was not', () => {
    expect(report).toMatchObject({
      moodleRelease: '4.5 (Build: 20241007)',
      sections: 2,
      activities: 14,
      questions: 6,
    });
    expect(report.warnings.join('\n')).toContain('Формула');
    expect(report.warnings.join('\n')).toContain('Новости');
    expect(report.warnings.join('\n')).toContain('"Пакет" (imscp)');
    expect(report.warnings.join('\n')).toContain(
      `"Каталог": left out entries, which are users' data (1); fields of type latlong`,
    );
    expect(report.warnings.join('\n')).toContain(
      `"Вики": pages are users' data and were left out (1)`,
    );
    expect(report.warnings.join('\n')).toContain(
      '"Отзыв": questions of type captcha were left out',
    );
    expect(report.warnings.join('\n')).toContain(
      `"Словарь": entries are users' data and were left out (1)`,
    );
    expect(report.warnings.join('\n')).toContain(
      '"Маршрут": left out the password (Moodle keeps only its hash)',
    );
  });

  it('recreates the course, sections and activities in order', async () => {
    const course = await t.db.course.findUniqueOrThrow({ where: { id: report.courseId } });
    expect(course).toMatchObject({ fullName: 'Python из Moodle', shortName: 'MOODLE-PY' });
    // custom fields this site has: the menu option by number, the day, the text of the HTML
    expect(course.customFields).toEqual({
      level: 'Средний',
      starts: '2026-01-01',
      about: 'Для всех',
    });
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
      'wiki:Вики',
      'book:Учебник',
      'choice:Тема проекта',
      'feedback:Отзыв',
      'glossary:Словарь',
      'lesson:Маршрут',
      'label:Пакет',
      'data:Каталог',
    ]);
    const catalog = acts.find((a) => a.moduleKey === 'data')!;
    expect(catalog.settings).toMatchObject({
      approvalRequired: true,
      maxEntries: 3,
      requiredEntriesToView: 1,
      defaultSort: 'Год',
      defaultOrder: 'desc',
      listTemplate: '<p>[[Книга]] ([[Год]]) ##more## ##delete##</p>',
      singleTemplate: '<h3>[[Книга]]</h3><p>[[Жанр]]</p>',
      ratingAggregate: 'average',
      ratingMax: 10,
    });
    const dataFields = await t.db.dataField.findMany({
      where: { activityId: catalog.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(dataFields.map((x) => [x.type, x.name, x.required, x.options])).toEqual([
      ['text', 'Книга', true, {}],
      ['number', 'Год', false, {}],
      ['radio', 'Жанр', false, { choices: ['Роман', 'Повесть'] }],
      ['image', 'Обложка', false, {}],
      ['url', 'Сайт', false, { linkText: 'Открыть' }],
    ]);
    expect(await t.db.dataRecord.count({ where: { activityId: catalog.id } })).toBe(0);
    expect(acts.find((a) => a.moduleKey === 'wiki')!.settings).toEqual({
      mode: 'individual',
      firstPageTitle: 'Начало',
    });
    const lesson = acts.find((a) => a.moduleKey === 'lesson')!;
    expect(lesson.settings).toMatchObject({
      gradeMax: 20,
      customScoring: true,
      retake: true,
      useMaxGrade: true,
      maxAttempts: 3,
      review: true,
      ongoing: true,
      progressBar: true,
      displayMenu: true,
      timeLimitMin: 20,
      password: '',
    });
    const pages = await t.db.lessonPage.findMany({
      where: { activityId: lesson.id },
      orderBy: { sortOrder: 'asc' },
    });
    // in reading order, jumps to pages pointing at the new pages
    expect(pages.map((p) => `${p.type}:${p.title}`)).toEqual([
      'content:Начало',
      'truefalse:Истина',
      'matching:Пары',
      'essay:Эссе',
    ]);
    const jumps = (i: number) => (pages[i]!.answers as { jump: string }[]).map((a) => a.jump);
    expect(jumps(0)).toEqual(['next', pages[2]!.id]);
    expect(jumps(3)).toEqual(['end']);
    expect(pages[0]!.contents).toMatch(/\/files\/[0-9a-f-]{36}\/map\.png/);
    expect(pages[0]!.options).toMatchObject({ horizontal: true, inMenu: true });
    expect(pages[1]!.answers).toMatchObject([
      { text: 'Верно', response: 'Да', score: 1 },
      { text: 'Неверно', jump: 'this' },
    ]);
    expect(pages[2]!.options).toEqual({
      pairs: [
        { left: 'H2O', right: 'вода' },
        { left: 'NaCl', right: 'соль' },
      ],
    });
    expect(pages[2]!.answers).toMatchObject([
      { response: 'Отлично', score: 2, jump: 'next' },
      { response: 'Ошибка', jump: 'this' },
    ]);
    const glossary = acts.find((a) => a.moduleKey === 'glossary')!;
    expect(glossary.settings).toMatchObject({
      approvalRequired: true,
      autoLink: true,
      displayFormat: 'full',
      entriesPerPage: 15,
      ratingAggregate: 'average',
      ratingMax: 5,
    });
    expect(await t.db.glossaryEntry.count({ where: { activityId: glossary.id } })).toBe(0);
    const feedback = acts.find((a) => a.moduleKey === 'feedback')!;
    expect(feedback.settings).toMatchObject({
      anonymous: false,
      showAnalysis: true,
      thankYou: 'Спасибо!',
    });
    const items = await t.db.feedbackItem.findMany({
      where: { activityId: feedback.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(items.map((i) => [i.type, i.label, i.required, i.options])).toEqual([
      [
        'choice',
        'Как вам курс?',
        true,
        { choices: ['Отлично', 'Хорошо', 'Плохо'], multiple: false, display: 'radio' },
      ],
      ['pagebreak', '', false, {}],
      ['number', 'Оценка', false, { min: 1, max: 10 }],
      ['textarea', 'Что улучшить?', false, {}],
    ]);
    const choice = acts.find((a) => a.moduleKey === 'choice')!;
    expect(choice.settings).toMatchObject({
      options: [
        { text: 'Чат-бот', limit: 3 },
        { text: 'Игра', limit: 0 },
      ],
      limitAnswers: true,
      allowUpdate: true,
      showResults: 'afterClose',
      publish: 'names',
      closesAt: '2026-01-01T00:00:00.000Z',
    });
    // the book's chapters in page order, with the chapter's picture stored in the course
    const book = acts.find((a) => a.moduleKey === 'book')!;
    expect(book.settings).toMatchObject({ numbering: 'indented', customTitles: false });
    const chapters = await t.db.bookChapter.findMany({
      where: { activityId: book.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(chapters.map((c) => [c.title, c.subchapter, c.hidden])).toEqual([
      ['Глава 1', false, false],
      ['Подробности', true, true],
    ]);
    expect(chapters[0]!.content).toMatch(/\/files\/[0-9a-f-]{36}\/fig\.png/);
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

  it('maps groups, assignment marking, forum ratings and the gradebook', async () => {
    const courseId = report.courseId;
    expect(report.warnings.join('\n')).toContain('2 groups were created without their members');
    expect(report.warnings.join('\n')).toContain('"Заметка": only items graded by points');
    const groups = await t.db.group.findMany({ where: { courseId }, orderBy: { name: 'asc' } });
    expect(groups.map((g) => [g.name, g.idNumber])).toEqual([
      ['Команда А', 'A'],
      ['Команда Б', null],
    ]);
    const grouping = await t.db.grouping.findFirstOrThrow({
      where: { courseId },
      include: { groups: true },
    });
    expect([grouping.name, grouping.groups.length]).toEqual(['Команды', 2]);
    const scale = await t.db.scale.findFirstOrThrow({ where: { courseId } });
    expect(scale.items).toEqual(['Слабо', 'Хорошо', 'Отлично']);

    // the assignment: what can be handed in, teams, marking, blind marking, its rubric
    const assign = await t.db.activity.findFirstOrThrow({ where: { courseId, name: 'Задание' } });
    expect(assign).toMatchObject({
      groupMode: 'SEPARATE',
      groupingId: grouping.id,
      idNumber: 'essay',
    });
    expect(assign.settings).toMatchObject({
      allowText: false,
      allowFiles: true,
      maxFiles: 2,
      maxFileMB: 3,
      reopen: 'manual',
      maxAttempts: 3,
      requireStatement: true,
      teamSubmission: true,
      preventSubmissionNotInGroup: true,
      markingWorkflow: true,
      markingAllocation: true,
      blindMarking: true,
      gradingMethod: 'rubric',
    });
    const rubric = await t.db.gradingDefinition.findFirstOrThrow({
      where: { activityId: assign.id },
    });
    expect(rubric.definition).toMatchObject({
      lockZeroPoints: false,
      criteria: [
        { id: 'c21', description: 'Верность', levels: [{ id: 'l211', score: 1 }, { score: 4 }] },
        { id: 'c22', description: 'Стиль кода' },
      ],
    });
    // the group's dates come; a student's own are user data and do not
    const overrides = await t.db.assignOverride.findMany({ where: { activityId: assign.id } });
    expect(overrides.map((o) => [o.groupId, o.dueAt?.toISOString()])).toEqual([
      [groups[0]!.id, '2026-01-02T00:00:00.000Z'],
    ]);

    // the forum's ratings on the scale, and its whole-forum grade
    const forum = await t.db.activity.findFirstOrThrow({ where: { courseId, name: 'Вопросы' } });
    expect(forum.settings).toMatchObject({
      ratingAggregate: 'average',
      ratingScaleId: scale.id,
      ratingFrom: '2025-01-01T00:00:00.000Z',
      wholeForumGrading: true,
      gradeMax: 20,
    });
    expect(await t.db.gradeItem.count({ where: { activityId: forum.id } })).toBe(2);

    // the gradebook: categories, items, ID numbers, the formula and letters
    const [categories, items] = await Promise.all([
      t.db.gradeCategory.findMany({ where: { courseId } }),
      t.db.gradeItem.findMany({ where: { courseId } }),
    ]);
    const works = categories.find((c) => c.name === 'Работы')!;
    expect(categories.find((c) => !c.parentId)!.aggregation).toBe('NATURAL');
    expect(works).toMatchObject({ aggregation: 'WEIGHTED_MEAN', dropLowest: 1, idNumber: 'works' });
    const essay = items.find((i) => i.activityId === assign.id)!;
    expect([essay.categoryId, essay.idNumber, Number(essay.weight)]).toEqual([
      works.id,
      'essay',
      3,
    ]);
    const oral = items.find((i) => i.name === 'Устный ответ')!;
    expect(oral).toMatchObject({ categoryId: works.id, idNumber: 'oral', display: 'PERCENT' });
    expect([Number(oral.gradeMax), Number(oral.gradePass)]).toEqual([10, 6]);
    const final = items.find((i) => i.name === 'Итог')!;
    expect(final.calculation).toBe(`=##gi${essay.id}## + ##gi${oral.id}## * 2 + ##gc${works.id}##`);
    expect(displayCalculations(items, categories).get(final.id)).toBe(
      '=[[essay]] + [[oral]] * 2 + [[works]]',
    );
    expect(items.some((i) => i.name === 'Заметка')).toBe(false);
    const letters = await t.db.gradeLetter.findMany({
      where: { contextId: courseId },
      orderBy: { lowerBound: 'desc' },
    });
    expect(letters.map((l) => l.letter)).toEqual(['A', 'F']);
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
    // a calculated question: its own dataset in its data, the shared one in the category
    expect((await byName('Скорость')).data).toMatchObject({
      answers: [{ formula: '{s} / {t}', tolerance: 0.1, toleranceType: 'relative', length: 1 }],
      datasets: [{ name: 's', min: 100, max: 500, decimals: 0, items: [120, 300] }],
      shared: ['t'],
    });
    expect(
      await t.db.questionDataset.findFirst({ where: { categoryId: cat.id, name: 't' } }),
    ).toMatchObject({ items: [2, 3] });
    expect(report.warnings).toContainEqual(expect.stringContaining('"Скорость": units'));
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
