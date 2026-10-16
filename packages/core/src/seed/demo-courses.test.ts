import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { seedDemoCourses } from './demo-courses.ts';

describe('demo courses', () => {
  const t = useTestDb();

  it('have an activity of every kind, what learners did in them, and achievements', async () => {
    const users = Object.fromEntries(
      (await t.db.user.findMany({ select: { id: true, username: true } })).map((u) => [
        u.username,
        u.id,
      ]),
    );
    expect((await seedDemoCourses(t.db, users)).created).toBe(true);
    const lit = await t.db.course.findUniqueOrThrow({ where: { shortName: 'DEMO-LIT' } });
    const activities = await t.db.activity.findMany({ where: { courseId: lit.id } });
    expect(new Set(activities.map((a) => a.moduleKey))).toEqual(
      new Set([
        'page',
        'choice',
        'feedback',
        'glossary',
        'book',
        'lesson',
        'wiki',
        'data',
        'workshop',
        'h5p',
        'scorm',
      ]),
    );
    const of = (key: string) => activities.find((a) => a.moduleKey === key)!.id;
    // the Chekhov week has its subsections
    expect(
      await t.db.courseSection.count({ where: { courseId: lit.id, parentId: { not: null } } }),
    ).toBe(2);
    // the packages are unpacked and ready to open
    expect(
      await t.db.scormPackage.findUniqueOrThrow({ where: { activityId: of('scorm') } }),
    ).toMatchObject({ status: 'READY', title: '«Вишнёвый сад»: интерактивный урок' });
    expect(
      await t.db.h5pPackage.findUniqueOrThrow({ where: { activityId: of('h5p') } }),
    ).toMatchObject({ status: 'READY', mainLibrary: 'H5P.HubiumQuiz' });

    // what the three learners did
    expect(await t.db.choiceAnswer.count({ where: { activityId: of('choice') } })).toBe(3);
    expect(await t.db.feedbackResponse.count({ where: { activityId: of('feedback') } })).toBe(3);
    expect(await t.db.dataRecord.count({ where: { activityId: of('data') } })).toBe(5);
    expect(await t.db.glossaryEntry.count({ where: { activityId: of('glossary') } })).toBe(6);
    expect(await t.db.bookChapter.count({ where: { activityId: of('book') } })).toBe(6);
    const lessonAttempts = await t.db.lessonAttempt.findMany({
      where: { activityId: of('lesson') },
      orderBy: { percent: 'desc' },
    });
    expect(lessonAttempts.map((a) => a.percent && Math.round(a.percent))).toEqual([100, 67]);
    expect(
      await t.db.workshop.findUniqueOrThrow({ where: { activityId: of('workshop') } }),
    ).toMatchObject({ phase: 'closed' });
    // the seminar's grades reached the gradebook: three essays and three reviewers
    const workshopGrades = await t.db.grade.count({
      where: { item: { activityId: of('workshop') }, finalGrade: { not: null } },
    });
    expect(workshopGrades).toBe(6);

    // badges: the lesson and the seminar earned one, a manager awarded another
    const awards = await t.db.badgeAward.findMany({
      include: { badge: { select: { name: true } }, user: { select: { username: true } } },
    });
    expect(awards.map((a) => `${a.badge.name}: ${a.user.username}`).sort()).toEqual([
      'Знаток «Онегина»: student1',
      'Знаток «Онегина»: student3',
      'Лучший читатель: student2',
    ]);
    expect(await t.db.certificateIssue.count()).toBe(1);
    expect(await t.db.learningPlan.count({ where: { status: 'ACTIVE' } })).toBe(3);
    expect(await t.db.customReport.count()).toBe(1);
    expect(
      (await t.db.user.findUniqueOrThrow({ where: { username: 'student2' } })).customFields,
    ).toMatchObject({ city: 'Казань' });

    // running it again adds nothing
    const counts = () =>
      Promise.all([
        t.db.activity.count(),
        t.db.courseSection.count(),
        t.db.badge.count(),
        t.db.certificate.count(),
        t.db.competencyFramework.count(),
        t.db.learningPlan.count(),
        t.db.customReport.count(),
      ]);
    const before = await counts();
    expect((await seedDemoCourses(t.db, users)).created).toBe(false);
    expect(await counts()).toEqual(before);
  });
});
