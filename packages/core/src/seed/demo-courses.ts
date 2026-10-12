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
  if (await db.course.findUnique({ where: { shortName: 'DEMO-PY' } })) return { created: false };
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
  return { created: true, courses: [py, hist] };
}
