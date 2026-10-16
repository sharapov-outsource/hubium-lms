import { randomUUID } from 'node:crypto';
import type { Db } from '@hubium/db';
import type { RequestContext } from '../context.ts';
import { createActivity } from '../courses/activities.ts';
import { addSection } from '../courses/courses.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { runModuleAction, runModuleQuery } from '../modules/actions.ts';
import { buildModuleCtx } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { enabled, systemCtx, userCtx } from './demo-ctx.ts';
import { demoH5pPackage, demoScormPackage } from './demo-packages.ts';

// The demo literature course: an activity of every kind the content course leaves out, and
// what learners did in them — answers, entries, essays assessed by peers — so the reports,
// the gradebook and the results pages have something to show.

type Act = (name: string, input: unknown) => Promise<unknown>;

/** Runs a module's actions as `ctx` on one activity. */
function on(ctx: RequestContext, activityId: string): Act {
  return (name, input) => runModuleAction(ctx, activityId, name, input);
}

/** Fills DEMO-LIT (idempotent: skipped once the course has subsections). */
export async function seedDemoLiterature(db: Db, courseId: string) {
  // the Chekhov subsections are made whatever modules are on
  if (await db.courseSection.findFirst({ where: { courseId, parentId: { not: null } } })) return;
  const ctx = systemCtx(db);
  const learners = await db.user.findMany({
    where: { username: { in: ['student1', 'student2', 'student3'] } },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
  const student = await db.role.findUniqueOrThrow({ where: { shortName: 'student' } });
  // student1 is enrolled already; enrolling again keeps the enrolment
  await enrolUsers.run(ctx, {
    courseId,
    userIds: learners.map((u) => u.id),
    roleId: student.id,
  });

  const sections = await db.courseSection.findMany({
    where: { courseId, parentId: null },
    orderBy: { rank: 'asc' },
  });
  const titles = [
    'А. С. Пушкин',
    'М. Ю. Лермонтов и Н. В. Гоголь',
    'Л. Н. Толстой и Ф. М. Достоевский',
    'А. П. Чехов',
  ];
  for (const [i, title] of titles.entries())
    if (sections[i + 1])
      await db.courseSection.update({ where: { id: sections[i + 1]!.id }, data: { title } });
  const [general, pushkin, lermontov, tolstoy, chekhov] = sections.map((s) => s.id);
  if (!general || !pushkin || !lermontov || !tolstoy || !chekhov) return;

  const teacher = await userCtx(db, 'teacher');
  const s = await Promise.all(learners.map((u) => userCtx(db, u.username!)));
  const add = (sectionId: string, moduleKey: string, fields: Record<string, unknown>) =>
    createActivity.run(ctx, { courseId, sectionId, moduleKey, ...fields });

  if (await enabled(db, 'choice')) {
    const { id } = await add(general, 'choice', {
      name: 'Опрос: любимый писатель XIX века',
      intro: '<p>Кого из писателей курса вы читаете с наибольшим удовольствием?</p>',
      showIntro: true,
      completionMode: 'AUTO',
      completionRules: { module: { submitted: true } },
      settings: {
        options: [
          { id: 'pushkin', text: 'А. С. Пушкин' },
          { id: 'lermontov', text: 'М. Ю. Лермонтов' },
          { id: 'gogol', text: 'Н. В. Гоголь' },
          { id: 'tolstoy', text: 'Л. Н. Толстой' },
          { id: 'dostoevsky', text: 'Ф. М. Достоевский' },
          { id: 'chekhov', text: 'А. П. Чехов' },
        ],
        showResults: 'always',
      },
    });
    for (const [i, optionId] of ['pushkin', 'chekhov', 'pushkin'].entries())
      await on(s[i]!, id)('answer', { optionIds: [optionId] });
  }

  if (await enabled(db, 'feedback')) {
    const { id } = await add(general, 'feedback', {
      name: 'Анкета: как вам курс?',
      intro: '<p>Анкета анонимная: преподаватель видит ответы, но не имена.</p>',
      showIntro: true,
      completionMode: 'AUTO',
      completionRules: { module: { submitted: true } },
      settings: { anonymous: true, showAnalysis: true, thankYou: 'Спасибо, ответы учтены!' },
    });
    const item = (input: Record<string, unknown>) =>
      on(ctx, id)('addItem', input) as Promise<{ id: string }>;
    await item({ type: 'info', label: 'Ответьте на четыре вопроса, это займёт пару минут.' });
    const useful = await item({
      type: 'choice',
      label: 'Насколько курс полезен вам?',
      required: true,
      choices: ['Очень полезен', 'Полезен', 'Не очень'],
    });
    const parts = await item({
      type: 'choice',
      label: 'Что понравилось больше всего?',
      multiple: true,
      choices: ['Книги и лекции', 'Опросы и тесты', 'Семинар', 'Вики и цитатник'],
    });
    const hours = await item({
      type: 'number',
      label: 'Сколько часов в неделю вы занимаетесь?',
      min: 0,
      max: 40,
    });
    const wish = await item({ type: 'textarea', label: 'Что улучшить в курсе?' });
    const answers = [
      ['Очень полезен', ['Книги и лекции', 'Семинар'], 6, 'Больше разборов поэзии.'],
      ['Полезен', ['Опросы и тесты'], 3, ''],
      ['Очень полезен', ['Семинар', 'Вики и цитатник'], 5, 'Добавить видео с чтением стихов.'],
    ] as const;
    for (const [i, [u, p, h, w]] of answers.entries())
      await on(s[i]!, id)('submit', {
        answers: { [useful.id]: u, [parts.id]: p, [hours.id]: h, [wish.id]: w },
      });
  }

  if (await enabled(db, 'glossary')) {
    const { id } = await add(general, 'glossary', {
      name: 'Словарь литературных терминов',
      intro: '<p>Термины курса. Они становятся ссылками в текстах курса.</p>',
      showIntro: true,
      settings: { autoLink: true, displayFormat: 'full' },
    });
    const terms = [
      [
        'Роман в стихах',
        'Крупное эпическое произведение, написанное стихами. Образец — «Евгений Онегин» А. С. Пушкина.',
        ['романа в стихах'],
      ],
      [
        'Лишний человек',
        'Тип героя русской литературы XIX века: одарённый дворянин, не нашедший себе места в обществе (Онегин, Печорин).',
        ['лишнего человека', 'лишние люди'],
      ],
      [
        'Онегинская строфа',
        'Строфа из 14 строк четырёхстопного ямба с особой рифмовкой, созданная Пушкиным для «Евгения Онегина».',
        ['онегинской строфой'],
      ],
      [
        'Реализм',
        'Направление в искусстве, стремящееся правдиво изображать жизнь в её типичных чертах.',
        [],
      ],
      [
        'Подтекст',
        'Скрытый смысл, не высказанный прямо. Им особенно богаты рассказы и пьесы Чехова.',
        [],
      ],
    ] as const;
    for (const [concept, definition, aliases] of terms)
      await on(teacher, id)('addEntry', {
        concept,
        definition: `<p>${definition}</p>`,
        aliases: [...aliases],
        autoLink: true,
      });
    await on(s[0]!, id)('addEntry', {
      concept: 'Эпиграф',
      definition: '<p>Цитата перед произведением или главой, подсказывающая её смысл.</p>',
    });
  }

  if (await enabled(db, 'book')) {
    const { id } = await add(pushkin, 'book', {
      name: 'Жизнь и творчество А. С. Пушкина',
      completionMode: 'AUTO',
      completionRules: { view: true },
      settings: { numbering: 'numbers' },
    });
    const chapter = (title: string, content: string, subchapter = false) =>
      on(ctx, id)('addChapter', { title, content: `<p>${content}</p>`, subchapter });
    await chapter(
      'Детство и Лицей',
      'Александр Сергеевич Пушкин родился в 1799 году в Москве. В 1811 году он поступил в Царскосельский лицей, где начал писать стихи.',
    );
    await chapter(
      'Южная ссылка',
      'В 1820 году за вольнолюбивые стихи Пушкина выслали на юг. Здесь написаны «южные поэмы» и начат роман в стихах «Евгений Онегин».',
    );
    await chapter(
      'Кишинёв',
      'В Кишинёве Пушкин служил при генерале Инзове и написал «Кавказского пленника».',
      true,
    );
    await chapter(
      'Одесса',
      'В Одессе продолжилась работа над «Онегиным»; ссылка закончилась высылкой в Михайловское.',
      true,
    );
    await chapter(
      'Болдинская осень',
      'Осенью 1830 года в Болдине Пушкин закончил «Онегина» и написал «Повести Белкина» и «Маленькие трагедии».',
    );
    await chapter(
      'Последние годы',
      'В 1830-е годы Пушкин издавал журнал «Современник» и написал «Капитанскую дочку». Он погиб после дуэли в 1837 году.',
    );
  }

  if (await enabled(db, 'lesson')) {
    const { id } = await add(pushkin, 'lesson', {
      name: '«Евгений Онегин»: проверьте себя',
      completionMode: 'AUTO',
      completionRules: { module: { endReached: true } },
      settings: { gradeMax: 10, gradePass: 6, progressBar: true, retake: true },
    });
    const a = { start: randomUUID(), genre: randomUUID(), belinsky: randomUUID() };
    const page = async (type: string, input: Record<string, unknown>, afterId?: string) =>
      (
        (await on(ctx, id)('addPage', { type, afterId: afterId ?? null, ...input })) as {
          id: string;
        }
      ).id;
    const intro = await page('content', {
      title: 'Роман в стихах',
      contents:
        '<p>«Евгений Онегин» писался больше семи лет, с 1823 по 1830 год. Ответьте на три вопроса о романе.</p>',
      answers: [{ id: a.start, text: 'Начать', jump: 'next' }],
    });
    const genre = await page(
      'truefalse',
      {
        title: 'Жанр',
        contents: '<p>«Евгений Онегин» — роман в стихах?</p>',
        answers: [
          {
            id: a.genre,
            text: 'Верно',
            jump: 'next',
            score: 1,
            response: 'Да, так его назвал сам Пушкин.',
          },
          { text: 'Неверно', jump: 'next', score: 0, response: 'Это роман в стихах.' },
        ],
      },
      intro,
    );
    const critic = await page(
      'multichoice',
      {
        title: 'Критик',
        contents: '<p>Кто назвал роман «энциклопедией русской жизни»?</p>',
        answers: [
          { id: a.belinsky, text: 'В. Г. Белинский', jump: 'next', score: 1 },
          { text: 'А. И. Герцен', jump: 'next', score: 0, response: 'Это сказал Белинский.' },
          { text: 'Н. А. Добролюбов', jump: 'next', score: 0, response: 'Это сказал Белинский.' },
        ],
      },
      genre,
    );
    const heroine = await page(
      'shortanswer',
      {
        title: 'Героиня',
        contents: '<p>Как зовут героиню, которая пишет письмо Онегину?</p>',
        answers: [
          { text: 'Татьяна', jump: 'end', score: 1, response: 'Верно, Татьяна Ларина.' },
          { text: '*', jump: 'end', score: 0, response: 'Это Татьяна Ларина.' },
        ],
      },
      critic,
    );
    // student1 answers everything right, student3 misses the critic
    for (const [learner, critics, name] of [
      [s[0]!, a.belinsky, 'Татьяна'],
      [s[2]!, null, 'Татьяна'],
    ] as const) {
      const play = on(learner, id);
      await play('start', {});
      await play('choose', { pageId: intro, answerId: a.start });
      await play('answer', { pageId: genre, choice: a.genre });
      const wrong = (await db.lessonPage.findUniqueOrThrow({ where: { id: critic } })).answers as {
        id: string;
      }[];
      await play('answer', { pageId: critic, choice: critics ?? wrong[1]!.id });
      await play('answer', { pageId: heroine, text: name });
    }
  }

  if (await enabled(db, 'wiki')) {
    const { id } = await add(lermontov, 'wiki', {
      name: 'Вики: конспекты семинаров',
      intro: '<p>Общие конспекты группы. Ссылка на страницу пишется так: [[Название]].</p>',
      showIntro: true,
      settings: { mode: 'collaborative', firstPageTitle: 'Главная' },
    });
    await on(s[0]!, id)('save', {
      title: 'Главная',
      content:
        '<p>Конспекты по героям: [[Печорин]] и [[Чичиков]]. Добавляйте свои страницы и исправляйте чужие.</p>',
    });
    await on(s[1]!, id)('save', {
      title: 'Печорин',
      content:
        '<p>Герой «Героя нашего времени» М. Ю. Лермонтова: умён, деятелен и разочарован, ещё один «лишний человек».</p>',
    });
    const chichikov = (await on(s[2]!, id)('save', {
      title: 'Чичиков',
      content: '<p>Герой «Мёртвых душ»: скупает умерших крестьян.</p>',
    })) as { pageId: string };
    await on(s[0]!, id)('save', {
      pageId: chichikov.pageId,
      baseVersion: 1,
      content:
        '<p>Герой «Мёртвых душ» Н. В. Гоголя: скупает «мёртвые души» — умерших крестьян, числящихся живыми по ревизии.</p>',
    });
  }

  if (await enabled(db, 'data')) {
    const { id } = await add(lermontov, 'data', {
      name: 'Цитатник',
      intro: '<p>Соберём любимые цитаты из произведений курса.</p>',
      showIntro: true,
      completionMode: 'AUTO',
      completionRules: { module: { entries: 1 } },
      settings: { entriesPerPage: 20 },
    });
    const field = async (type: string, name: string, extra: Record<string, unknown> = {}) =>
      ((await on(ctx, id)('addField', { type, name, ...extra })) as { id: string }).id;
    const quote = await field('textarea', 'Цитата', { required: true });
    const author = await field('menu', 'Автор', {
      required: true,
      choices: ['Пушкин', 'Лермонтов', 'Гоголь', 'Толстой', 'Достоевский', 'Чехов'],
    });
    const work = await field('text', 'Произведение');
    const year = await field('number', 'Год');
    const quotes = [
      [0, 'Мы все учились понемногу чему-нибудь и как-нибудь.', 'Пушкин', 'Евгений Онегин', '1833'],
      [1, 'И скучно и грустно, и некому руку подать…', 'Лермонтов', 'И скучно и грустно', '1840'],
      [2, 'Все счастливые семьи похожи друг на друга…', 'Толстой', 'Анна Каренина', '1877'],
      [0, 'В человеке должно быть всё прекрасно…', 'Чехов', 'Дядя Ваня', '1897'],
      [1, 'Красота спасёт мир.', 'Достоевский', 'Идиот', '1869'],
    ] as const;
    for (const [who, q, by, title, when] of quotes)
      await on(s[who]!, id)('saveEntry', {
        values: { [quote]: `<p>${q}</p>`, [author]: by, [work]: title, [year]: when },
      });
  }

  if (await enabled(db, 'workshop')) {
    const { id } = await add(tolstoy, 'workshop', {
      name: 'Семинар: эссе о «лишнем человеке»',
      intro:
        '<p>Напишите эссе о «лишнем человеке» в русской литературе и оцените работы двух однокурсников.</p>',
      showIntro: true,
      completionMode: 'AUTO',
      completionRules: { module: { submitted: true } },
      settings: {
        strategy: 'accumulative',
        gradeMax: 80,
        gradingGradeMax: 20,
        instructAuthors: '<p>Объём — до двух страниц. Опирайтесь на текст произведений.</p>',
        instructReviewers: '<p>Оценивайте по каждому критерию и оставьте отзыв автору.</p>',
        conclusion: '<p>Семинар завершён: оценки — в журнале, отзывы — у ваших работ.</p>',
        submissionFiles: 'off',
      },
    });
    const run = on(ctx, id);
    await run('saveForm', {
      dimensions: [
        { id: 'theme', description: '<p>Раскрытие темы</p>', maxGrade: 10, weight: 2 },
        { id: 'args', description: '<p>Аргументация и примеры из текста</p>', maxGrade: 10 },
        { id: 'style', description: '<p>Язык и грамотность</p>', maxGrade: 10 },
      ],
    });
    await run('switchPhase', { phase: 'submission' });
    const essays = [
      [
        'Онегин и Печорин: два портрета',
        'Онегин скучает, Печорин действует — но оба не находят дела по себе.',
      ],
      [
        'Почему Обломов не встаёт с дивана',
        'Гончаров показывает, как доброта без воли становится бездействием.',
      ],
      ['«Лишний человек» сегодня', 'Тип героя XIX века узнаётся и в современных романах.'],
    ] as const;
    for (const [i, [title, text]] of essays.entries())
      await on(s[i]!, id)('submit', { title, content: `<p>${text}</p>` });
    await run('randomAllocate', { count: 2 });
    await run('switchPhase', { phase: 'assessment' });
    const marks = [
      [9, 8, 9],
      [7, 6, 8],
      [8, 9, 7],
    ];
    for (const [i, learner] of s.entries()) {
      const o = (await runModuleQuery(learner, id, 'overview', {})) as {
        toReview: { assessmentId: string }[];
      };
      for (const r of o.toReview) {
        const [theme, args, style] = marks[i]!;
        await on(learner, id)('assess', {
          assessmentId: r.assessmentId,
          filling: { theme: { grade: theme }, args: { grade: args }, style: { grade: style } },
          feedbackAuthor: 'Интересная мысль, хорошо бы больше цитат.',
        });
      }
    }
    await run('switchPhase', { phase: 'evaluation' });
    await run('calculateGrades', {});
    await run('switchPhase', { phase: 'closed' });
  }

  // Чехов: stories and plays in subsections, with the demo's SCORM and H5P packages
  const sub = async (title: string) =>
    (await addSection.run(ctx, { courseId, parentId: chekhov, title })).id;
  const stories = await sub('Рассказы');
  const plays = await sub('Пьесы');
  for (const [sectionId, name, content] of [
    [
      stories,
      '«Человек в футляре»',
      'Учитель греческого языка Беликов боится всего, что «как бы чего не вышло». Рассказ полон подтекста.',
    ],
    [
      stories,
      '«Крыжовник»',
      'Николай Иваныч всю жизнь копит на усадьбу с крыжовником — и находит в ней сытое, но мелкое счастье.',
    ],
    [
      plays,
      '«Вишнёвый сад»',
      'Последняя пьеса Чехова (1903): имение Раневской продаётся за долги, сад покупает Лопахин.',
    ],
  ] as const)
    await add(sectionId, 'page', {
      name,
      completionMode: 'MANUAL',
      settings: { content: `<p>${content}</p>` },
    });
  if (await enabled(db, 'h5p')) {
    const { id } = await add(stories, 'h5p', {
      name: 'Самопроверка: рассказы Чехова',
      completionMode: 'AUTO',
      completionRules: { module: { completed: true } },
      settings: { gradeMax: 10 },
    });
    await attachPackage(ctx, id, 'h5p', 'chekhov-stories.h5p', demoH5pPackage());
  }
  if (await enabled(db, 'scorm')) {
    const { id } = await add(plays, 'scorm', {
      name: 'Интерактивный урок: «Вишнёвый сад»',
      completionMode: 'AUTO',
      completionRules: { module: { passed: true } },
      settings: { gradeMax: 10, gradePass: 7, maxAttempts: 3 },
    });
    await attachPackage(ctx, id, 'scorm', 'cherry-orchard.zip', demoScormPackage());
  }
}

/**
 * Stores a SCORM or H5P package for an activity and unpacks it now, as the worker would
 * after an upload: the demo is ready to open without the worker running.
 */
async function attachPackage(
  ctx: RequestContext,
  activityId: string,
  moduleKey: 'scorm' | 'h5p',
  name: string,
  data: Uint8Array,
) {
  const mctx = buildModuleCtx(ctx);
  const file = await mctx.files.store(activityId, 'package', {
    name,
    mimeType: 'application/zip',
    data: Buffer.from(data),
  });
  const pkg =
    moduleKey === 'scorm'
      ? await ctx.db.scormPackage.create({ data: { activityId, fileId: file.id } })
      : await ctx.db.h5pPackage.create({ data: { activityId, fileId: file.id } });
  const extract = getModule(moduleKey)?.jobs?.find((j) => j.name === `${moduleKey}.extract`);
  await extract?.handler(mctx, { packageId: pkg.id } as never);
}
