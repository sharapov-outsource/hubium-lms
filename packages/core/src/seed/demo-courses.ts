import type { Db } from '@hubium/db';
import { Permissions } from '../access/permissions.ts';
import { createEvent } from '../calendar/calendar.ts';
import type { RequestContext } from '../context.ts';
import { createActivity } from '../courses/activities.ts';
import { createCategory } from '../courses/categories.ts';
import { createCourse } from '../courses/courses.ts';
import { enrolUsers, updateSelfEnrolment } from '../enrol/enrol.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';

function systemCtx(db: Db): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: 'ru',
    origin: 'CLI',
  };
}

/** Demo categories, courses, materials and enrolments (idempotent by course short name). */
export async function seedDemoCourses(db: Db, users: Record<string, string>) {
  const existing = await db.course.findUnique({ where: { shortName: 'DEMO-PY' } });
  if (existing) {
    await seedDemoAssessment(db, existing.id);
    await seedDemoComms(db, existing.id);
    return { created: false };
  }
  const ctx = systemCtx(db);
  const roles = Object.fromEntries((await db.role.findMany()).map((r) => [r.shortName, r.id]));

  const { id: school } = await createCategory.run(ctx, {
    name: 'Онлайн-школа',
    description: 'Демонстрационные курсы',
  });
  const { id: it } = await createCategory.run(ctx, { name: 'Программирование', parentId: school });
  const { id: hum } = await createCategory.run(ctx, {
    name: 'Гуманитарные науки',
    parentId: school,
  });

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 7);
  const { id: py } = await createCourse.run(ctx, {
    categoryId: it,
    fullName: 'Python для начинающих',
    shortName: 'DEMO-PY',
    summary:
      '<p>Практический курс по основам Python: переменные, условия, циклы, функции и работа с файлами. Подходит тем, кто никогда не программировал.</p>',
    format: 'TOPICS',
    sections: 3,
    startDate: start,
  });
  const { id: hist } = await createCourse.run(ctx, {
    categoryId: hum,
    fullName: 'История русской литературы XIX века',
    shortName: 'DEMO-LIT',
    summary: '<p>От Пушкина до Чехова: ключевые произведения, контекст эпохи и обсуждения.</p>',
    format: 'WEEKS',
    sections: 4,
    startDate: start,
  });

  const sections = await db.courseSection.findMany({
    where: { courseId: py },
    orderBy: { rank: 'asc' },
  });
  await db.courseSection.update({
    where: { id: sections[1]!.id },
    data: { title: 'Знакомство с Python' },
  });
  await db.courseSection.update({
    where: { id: sections[2]!.id },
    data: { title: 'Условия и циклы' },
  });
  await db.courseSection.update({ where: { id: sections[3]!.id }, data: { title: 'Функции' } });

  await createActivity.run(ctx, {
    courseId: py,
    sectionId: sections[0]!.id,
    moduleKey: 'label',
    name: 'Приветствие',
    settings: {
      content:
        '<p><strong>Добро пожаловать!</strong> Начните с раздела «Знакомство с Python». Вопросы задавайте преподавателю.</p>',
    },
  });
  const intro = await createActivity.run(ctx, {
    courseId: py,
    sectionId: sections[1]!.id,
    moduleKey: 'page',
    name: 'Что такое Python',
    completionMode: 'AUTO',
    completionRules: { view: true },
    settings: {
      content:
        '<h2>Почему Python</h2><p>Python — язык с простым синтаксисом, на котором пишут веб-сервисы, анализируют данные и обучают нейросети.</p><pre><code>print("Привет, мир!")</code></pre><ul><li>Читаемый код</li><li>Огромная экосистема библиотек</li><li>Подходит для первых шагов</li></ul>',
    },
  });
  await createActivity.run(ctx, {
    courseId: py,
    sectionId: sections[1]!.id,
    moduleKey: 'url',
    name: 'Документация Python',
    completionMode: 'MANUAL',
    settings: { url: 'https://docs.python.org/3/', display: 'newtab' },
  });
  await createActivity.run(ctx, {
    courseId: py,
    sectionId: sections[2]!.id,
    moduleKey: 'page',
    name: 'Условия: if, elif, else',
    completionMode: 'MANUAL',
    availability: { op: '&', c: [{ type: 'completion', activityId: intro.id, state: 'complete' }] },
    settings: {
      content:
        '<p>Условный оператор выполняет код только при истинном условии:</p><pre><code>age = 17\nif age >= 18:\n    print("Взрослый")\nelse:\n    print("Подросток")</code></pre>',
    },
  });
  await createActivity.run(ctx, {
    courseId: py,
    sectionId: sections[3]!.id,
    moduleKey: 'page',
    name: 'Функции и аргументы',
    completionMode: 'MANUAL',
    settings: {
      content:
        '<p>Функция объявляется словом <code>def</code>:</p><pre><code>def greet(name):\n    return f"Привет, {name}!"</code></pre>',
    },
  });

  const litSections = await db.courseSection.findMany({
    where: { courseId: hist },
    orderBy: { rank: 'asc' },
  });
  await createActivity.run(ctx, {
    courseId: hist,
    sectionId: litSections[1]!.id,
    moduleKey: 'page',
    name: 'А. С. Пушкин: «Евгений Онегин»',
    completionMode: 'MANUAL',
    settings: { content: '<p>Роман в стихах, «энциклопедия русской жизни» (В. Г. Белинский).</p>' },
  });

  await enrolUsers.run(ctx, {
    courseId: py,
    userIds: [users.teacher!],
    roleId: roles.editingteacher!,
  });
  await enrolUsers.run(ctx, { courseId: py, userIds: [users.assistant!], roleId: roles.teacher! });
  await enrolUsers.run(ctx, {
    courseId: py,
    userIds: [users.student1!, users.student2!, users.student3!],
    roleId: roles.student!,
  });
  await enrolUsers.run(ctx, {
    courseId: hist,
    userIds: [users.teacher!],
    roleId: roles.editingteacher!,
  });
  await enrolUsers.run(ctx, { courseId: hist, userIds: [users.student1!], roleId: roles.student! });
  await updateSelfEnrolment.run(ctx, {
    courseId: hist,
    enabled: true,
    key: 'pushkin',
    useGroupKeys: false,
  });

  const { id: g1 } = await createGroup.run(ctx, { courseId: py, name: 'Поток А' });
  await setGroupMembers.run(ctx, { groupId: g1, add: [users.student1!, users.student2!] });

  const lesson = new Date();
  lesson.setUTCDate(lesson.getUTCDate() + 3);
  lesson.setUTCHours(15, 0, 0, 0);
  await createEvent.run(ctx, {
    scope: 'COURSE',
    courseId: py,
    title: 'Онлайн-разбор домашних заданий',
    startsAt: lesson,
  });
  await createEvent.run(ctx, {
    scope: 'SITE',
    title: 'День открытых дверей',
    startsAt: new Date(lesson.getTime() + 2 * 86_400_000),
    allDay: true,
  });
  await seedDemoAssessment(db, py);
  await seedDemoComms(db, py);
  return { created: true, courses: [py, hist] };
}

const DEMO_GIFT = `
::Тип данных:: Какой тип у значения 3.14 в Python? {=float ~int ~str ~bool}

::Комментарий:: Комментарий в Python начинается с символа «#». {T}

::Вывод:: Какая функция выводит текст на экран? {=print =print()}

::Деление:: Чему равно 7 // 2 в Python? {#3}

::Соответствие:: Сопоставьте значение и тип {
  =42 -> int
  ="42" -> str
  =True -> bool
}

::Списки:: Какие из этих типов изменяемые? {~%50%list ~%50%dict ~%-100%tuple ~%-100%str}
`;

/** Demo assignment, question bank and quiz (idempotent: skipped if the course has a quiz). */
export async function seedDemoAssessment(db: Db, courseId: string) {
  if (await db.activity.findFirst({ where: { courseId, moduleKey: { in: ['quiz', 'assign'] } } }))
    return;
  const ctx = systemCtx(db);
  const { importGift } = await import('../questions/bank.ts');
  const { runModuleAction } = await import('../modules/actions.ts');
  await importGift.run(ctx, { courseId, gift: DEMO_GIFT });
  const sections = await db.courseSection.findMany({
    where: { courseId },
    orderBy: { rank: 'asc' },
  });
  const target = sections[2] ?? sections.at(-1)!;
  const due = new Date(Date.now() + 5 * 86_400_000);
  due.setUTCHours(20, 59, 0, 0);
  await createActivity.run(ctx, {
    courseId,
    sectionId: target.id,
    moduleKey: 'assign',
    name: 'Домашнее задание: калькулятор',
    intro:
      '<p>Напишите программу, которая читает два числа и выводит их сумму, разность и произведение. Прикрепите файл <code>.py</code> или вставьте код в ответ.</p>',
    showIntro: true,
    completionMode: 'AUTO',
    completionRules: { module: { submit: true } },
    settings: { dueAt: due.toISOString(), gradeMax: 10, gradePass: 6, maxFiles: 3 },
  });
  const { id: quizId } = await createActivity.run(ctx, {
    courseId,
    sectionId: target.id,
    moduleKey: 'quiz',
    name: 'Тест по основам Python',
    completionMode: 'AUTO',
    completionRules: { module: { pass: true } },
    settings: { attempts: 3, timeLimitMin: 15, gradeMax: 10, gradePass: 6, perPage: 3 },
  });
  const questions = await db.question.findMany({
    where: { category: { contextId: courseId } },
    orderBy: { createdAt: 'asc' },
  });
  await runModuleAction(ctx, quizId, 'addQuestions', { questionIds: questions.map((q) => q.id) });
}

/** Demo forum with a discussion and a course announcement (idempotent). */
export async function seedDemoComms(db: Db, courseId: string) {
  if (await db.activity.findFirst({ where: { courseId, moduleKey: 'forum' } })) return;
  const ctx = systemCtx(db);
  const people = Object.fromEntries(
    (
      await db.user.findMany({
        where: { username: { in: ['teacher', 'student1', 'student2'] } },
        select: { id: true, username: true },
      })
    ).map((u) => [u.username, u.id]),
  );
  const section = await db.courseSection.findFirstOrThrow({
    where: { courseId },
    orderBy: { rank: 'asc' },
  });
  const { id: forumId } = await createActivity.run(ctx, {
    courseId,
    sectionId: section.id,
    moduleKey: 'forum',
    name: 'Форум курса',
    intro: '<p>Задавайте вопросы и помогайте друг другу.</p>',
    showIntro: true,
    settings: { subscription: 'auto' },
  });
  // Written directly: module actions need a signed-in author, and seeding stays quiet.
  const now = Date.now();
  const d = await db.forumDiscussion.create({
    data: {
      activityId: forumId,
      authorId: people.student1 ?? null,
      title: 'Как установить Python на Windows?',
      postCount: 2,
      lastPostAt: new Date(now - 3600_000),
    },
  });
  const root = await db.forumPost.create({
    data: {
      discussionId: d.id,
      authorId: people.student1 ?? null,
      contentHtml:
        '<p>Скачал установщик, но команда <code>python</code> не находится. Что делать?</p>',
      createdAt: new Date(now - 2 * 3600_000),
    },
  });
  await db.forumPost.create({
    data: {
      discussionId: d.id,
      parentId: root.id,
      authorId: people.teacher ?? null,
      contentHtml:
        '<p>Переустановите и отметьте галочку <strong>Add python.exe to PATH</strong>, затем откройте новый терминал.</p>',
      createdAt: new Date(now - 3600_000),
    },
  });
  await db.announcement.create({
    data: {
      courseId,
      authorId: people.teacher ?? null,
      title: 'Добро пожаловать на курс!',
      contentHtml:
        '<p>Первое занятие — в понедельник. Пройдите тест по основам, чтобы проверить себя.</p>',
      pinned: true,
      notify: false,
      notifiedAt: new Date(),
    },
  });
}
