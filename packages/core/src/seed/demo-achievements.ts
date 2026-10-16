import type { Db } from '@hubium/db';
import { reviewBadge, saveBadge, setBadgeImage, setBadgeStatus } from '../badges/badges.ts';
import {
  issueCertificate,
  saveCertificate,
  setCertificateStatus,
} from '../certificates/certificates.ts';
import { defaultFields } from '../certificates/template.ts';
import { saveCompetency, saveFramework } from '../competencies/frameworks.ts';
import {
  createPlansFromTemplate,
  saveTemplate,
  setTemplateCompetency,
} from '../competencies/plans.ts';
import {
  addCourseCompetencies,
  rateInCourse,
  setActivityCompetency,
  setCourseCompetency,
} from '../competencies/ratings.ts';
import { saveCourseField } from '../courses/course-fields.ts';
import { saveReport } from '../reports/reports.ts';
import { saveProfileField, writeProfileValues } from '../users/profile-fields.ts';
import { systemCtx, userCtx } from './demo-ctx.ts';

// The demo's achievements and site setup: badges (one already earned in the literature
// course, one awarded by hand), a certificate, a competency framework with learning plans,
// a saved report, and a custom profile field and course field with values.

/** A round badge with a letter, as the demo's badge images. */
function badgeSvg(letter: string, color: string): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
      `<circle cx="128" cy="128" r="120" fill="${color}"/>` +
      `<circle cx="128" cy="128" r="96" fill="none" stroke="#fff" stroke-width="8"/>` +
      `<text x="128" y="160" font-family="Georgia,serif" font-size="96" fill="#fff" text-anchor="middle">${letter}</text>` +
      `</svg>`,
  );
}

/** Idempotent: skipped once the site has the demo framework. */
export async function seedDemoAchievements(db: Db) {
  if (await db.competencyFramework.findFirst({ where: { idNumber: 'DEMO-LIT-ANALYSIS' } })) return;
  const [py, lit] = await Promise.all([
    db.course.findUnique({ where: { shortName: 'DEMO-PY' } }),
    db.course.findUnique({ where: { shortName: 'DEMO-LIT' } }),
  ]);
  if (!py || !lit) return;
  const ctx = systemCtx(db);
  const people = Object.fromEntries(
    (
      await db.user.findMany({
        where: { username: { in: ['teacher', 'student1', 'student2', 'student3', 'manager'] } },
        select: { id: true, username: true },
      })
    ).map((u) => [u.username, u.id]),
  );
  const learners = [people.student1, people.student2, people.student3].filter(
    (x): x is string => !!x,
  );
  const manager = await db.role.findUniqueOrThrow({ where: { shortName: 'manager' } });

  // custom fields: a city in profiles, a level in the catalog
  await saveProfileField.run(ctx, {
    shortName: 'city',
    name: { ru: 'Город', en: 'City' },
    type: 'text',
    visibleToOthers: true,
  });
  for (const [username, city] of [
    ['teacher', 'Москва'],
    ['student1', 'Москва'],
    ['student2', 'Казань'],
    ['student3', 'Санкт-Петербург'],
  ] as const)
    if (people[username]) await writeProfileValues(db, people[username], { city });
  await saveCourseField.run(ctx, {
    shortName: 'level',
    name: { ru: 'Уровень', en: 'Level' },
    type: 'menu',
    choices: ['Начальный', 'Средний', 'Продвинутый'],
  });
  for (const [course, level] of [
    [py, 'Начальный'],
    [lit, 'Средний'],
  ] as const)
    await db.course.update({
      where: { id: course.id },
      data: { customFields: { ...(course.customFields as object), level } },
    });

  // badges: the literature course's for its lesson and seminar, earned by those who did
  // both; the Python course's for completing it; a site badge a manager awards by hand
  const activity = (moduleKey: string) =>
    db.activity.findFirst({ where: { courseId: lit.id, moduleKey }, select: { id: true } });
  const [lesson, workshop] = await Promise.all([activity('lesson'), activity('workshop')]);
  const badge = async (input: Parameters<typeof saveBadge.run>[1], image: Uint8Array) => {
    const { id } = await saveBadge.run(ctx, input);
    await setBadgeImage.run(ctx, { id, name: 'badge.svg', data: image });
    await setBadgeStatus.run(ctx, { id, status: 'ACTIVE' });
    return id;
  };
  if (lesson && workshop) {
    const id = await badge(
      {
        courseId: lit.id,
        name: 'Знаток «Онегина»',
        description: 'За пройденную лекцию по «Евгению Онегину» и эссе на семинаре.',
        criteria: {
          method: 'all',
          rules: [{ kind: 'activities', activityIds: [lesson.id, workshop.id], method: 'all' }],
        },
      },
      badgeSvg('О', '#7c3aed'),
    );
    await reviewBadge(db, id);
  }
  await badge(
    {
      courseId: py.id,
      name: 'Выпускник курса Python',
      description: 'За прохождение курса «Python для начинающих».',
      criteria: { method: 'all', rules: [{ kind: 'courseCompletion' }] },
    },
    badgeSvg('Py', '#2563eb'),
  );
  const reader = await badge(
    {
      courseId: null,
      name: 'Лучший читатель',
      description: 'Присуждает менеджер обучения за активное участие в курсах.',
      criteria: {
        method: 'all',
        rules: [{ kind: 'manual', roleIds: [manager.id], method: 'all' }],
      },
    },
    badgeSvg('★', '#d97706'),
  );
  // the manager's mark, as their "award" button leaves it
  if (people.student2) {
    await db.badgeMark.create({
      data: { badgeId: reader, userId: people.student2, roleId: manager.id },
    });
    await reviewBadge(db, reader);
  }

  // a certificate on completing the literature course; one issued by hand already
  const { id: certificate } = await saveCertificate.run(ctx, {
    courseId: lit.id,
    name: 'Сертификат слушателя курса',
    orientation: 'landscape',
    fields: defaultFields('landscape', 'ru'),
    onCompletion: true,
  });
  await setCertificateStatus.run(ctx, { id: certificate, status: 'ACTIVE' });
  if (people.student1)
    await issueCertificate.run(ctx, { certificateId: certificate, userId: people.student1 });

  // competencies: a framework for the literature course, rated in it and followed in plans
  const { id: framework } = await saveFramework.run(ctx, {
    shortName: 'Литературный анализ',
    idNumber: 'DEMO-LIT-ANALYSIS',
    description: '<p>Умения, которые развивает курс русской литературы.</p>',
    scaleId: 'new',
    newScale: { name: 'Владение умением', items: ['Не владеет', 'Владеет частично', 'Владеет'] },
    scaleConfig: { default: 3, proficient: [3] },
  });
  const competency = async (shortName: string, idNumber: string, parentId?: string) =>
    (
      await saveCompetency.run(ctx, {
        frameworkId: framework,
        parentId: parentId ?? null,
        shortName,
        idNumber,
      })
    ).id;
  const analysis = await competency('Анализ текста', 'LIT-TEXT');
  const theme = await competency('Тема и идея произведения', 'LIT-THEME', analysis);
  const hero = await competency('Образ героя', 'LIT-HERO', analysis);
  const writing = await competency('Письменная речь', 'LIT-WRITING');
  const linked = [theme, hero, writing];
  await addCourseCompetencies.run(ctx, { courseId: lit.id, competencyIds: linked });
  await setCourseCompetency.run(ctx, {
    courseId: lit.id,
    competencyId: theme,
    ruleOutcome: 'COMPLETE',
  });
  if (workshop)
    for (const competencyId of [hero, writing])
      await setActivityCompetency.run(ctx, {
        activityId: workshop.id,
        competencyId,
        ruleOutcome: 'EVIDENCE',
      });
  const teacher = await userCtx(db, 'teacher');
  for (const [userId, grade] of [
    [people.student1, 3],
    [people.student3, 2],
  ] as const)
    if (userId)
      await rateInCourse.run(teacher, {
        courseId: lit.id,
        userId,
        competencyId: hero,
        grade,
        note: 'По эссе на семинаре.',
      });
  const { id: template } = await saveTemplate.run(ctx, {
    name: 'Читатель-аналитик',
    description: '<p>План первого года: читать внимательно и писать о прочитанном.</p>',
  });
  for (const competencyId of linked)
    await setTemplateCompetency.run(ctx, { templateId: template, competencyId, linked: true });
  if (learners.length)
    await createPlansFromTemplate.run(ctx, { templateId: template, userIds: learners });

  // a report the managers see in their list
  await saveReport.run(ctx, {
    name: 'Прогресс слушателей',
    source: 'participants',
    columns: [
      { field: 'user.fullName' },
      { field: 'course.fullName' },
      { field: 'completion.progress' },
      { field: 'completion.completed' },
    ],
    filters: ['course.fullName', 'completion.completed'],
    sort: { column: 2, desc: true },
    audiences: { roleIds: [manager.id] },
  });
}
