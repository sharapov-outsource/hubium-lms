import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { saveScale } from '../grades/scales.ts';
import {
  deleteCompetency,
  duplicateFramework,
  exportFrameworkCsv,
  frameworkTree,
  importFrameworkCsv,
  moveCompetency,
  saveCompetency,
  saveFramework,
  setCompetencyRule,
  setRelatedCompetency,
} from './frameworks.ts';
import {
  addCompetencyComment,
  linkUserEvidence,
  planDetail,
  planStep,
  savePlan,
  saveTemplate,
  saveUserEvidence,
  setPlanCompetency,
  setTemplateCohort,
  setTemplateCompetency,
  syncTemplateCohorts,
  unlinkPlan,
  userPlans,
} from './plans.ts';
import {
  addCourseCompetencies,
  addManualEvidence,
  courseBreakdown,
  learnerInCourse,
  rateInCourse,
  rateUserCompetency,
  reviewUserCompetency,
  setActivityCompetency,
  setCourseCompetencySettings,
  userCompetencyDetail,
} from './ratings.ts';

describe('competencies', () => {
  const t = useTestDb();
  const ids = {} as Record<string, string>;

  it('builds a framework, copies it, and moves it as Moodle CSV', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    ids.scale = (
      await saveScale.run(admin, { name: 'Компетентность', items: ['Не освоено', 'Освоено'] })
    ).id;
    ids.fw = (
      await saveFramework.run(admin, {
        shortName: 'Цифровые навыки',
        idNumber: 'DIG',
        scaleId: ids.scale,
        scaleConfig: { default: 2, proficient: [2] },
        taxonomies: ['domain', 'skill'],
      })
    ).id;
    await expect(
      saveFramework.run(admin, {
        shortName: 'x',
        idNumber: 'DIG',
        scaleId: ids.scale,
        scaleConfig: { default: 2, proficient: [2] },
      }),
    ).rejects.toMatchObject({ fieldErrors: { idNumber: [expect.any(String)] } });
    const add = async (idNumber: string, parentId?: string) =>
      (
        await saveCompetency.run(admin, {
          frameworkId: ids.fw,
          parentId: parentId ?? null,
          shortName: `Навык ${idNumber}`,
          idNumber,
        })
      ).id;
    ids.a = await add('A');
    ids.a1 = await add('A1', ids.a);
    ids.a2 = await add('A2', ids.a);
    ids.b = await add('B');
    await setCompetencyRule.run(admin, { id: ids.a, ruleType: 'ALL', ruleOutcome: 'COMPLETE' });
    await expect(
      setCompetencyRule.run(admin, { id: ids.b, ruleType: 'ALL', ruleOutcome: 'COMPLETE' }),
    ).rejects.toMatchObject({ fieldErrors: { ruleType: [expect.any(String)] } });
    await setRelatedCompetency.run(admin, { id: ids.a1, relatedId: ids.b, related: true });

    const tree = await frameworkTree(t.db, ids.fw);
    expect(tree.competencies.map((c) => [c.idNumber, c.depth])).toEqual([
      ['A', 0],
      ['A1', 1],
      ['A2', 1],
      ['B', 0],
    ]);
    expect(tree.competencies.find((c) => c.id === ids.b)!.related).toEqual([ids.a1]);

    // B goes under A and back
    await moveCompetency.run(admin, { id: ids.b, parentId: ids.a });
    expect((await t.db.competency.findUniqueOrThrow({ where: { id: ids.b } })).path).toBe(
      `/${ids.a}/`,
    );
    await expect(moveCompetency.run(admin, { id: ids.a, parentId: ids.a1 })).rejects.toMatchObject({
      fieldErrors: { parentId: [expect.any(String)] },
    });
    await moveCompetency.run(admin, { id: ids.b, parentId: null });

    const copy = await duplicateFramework.run(admin, { id: ids.fw });
    const copied = await frameworkTree(t.db, copy.id);
    expect(copied.framework.idNumber).toBe('DIG_1');
    expect(copied.competencies).toHaveLength(4);
    expect(copied.competencies.find((c) => c.idNumber === 'A')!.ruleType).toBe('ALL');

    // out as CSV and back in under another ID number
    const csv = await exportFrameworkCsv(admin, ids.fw);
    await expect(importFrameworkCsv.run(admin, { csv })).rejects.toMatchObject({
      fieldErrors: { csv: [expect.stringMatching(/exists already/)] },
    });
    const r = await importFrameworkCsv.run(admin, { csv: csv.replace(',DIG,', ',DIG2,') });
    expect(r.competencies).toBe(4);
    const imported = await frameworkTree(t.db, r.id);
    expect(imported.framework.scaleId).toBe(ids.scale);
    expect(imported.framework.taxonomies).toEqual(['domain', 'skill']);
    const byIdNumber = (n: string) => imported.competencies.find((c) => c.idNumber === n)!;
    expect(byIdNumber('A').ruleType).toBe('ALL');
    expect(byIdNumber('A1').parentId).toBe(byIdNumber('A').id);
    expect(byIdNumber('B').related).toEqual([byIdNumber('A1').id]);
  });

  it('is rated through activities, teachers and its children', async () => {
    const f = await courseFixture(t.db, 'COMP1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    ids.course = f.courseId;
    ids.student1 = f.users.student1!;
    ids.student2 = f.users.student2!;
    ids.student3 = f.users.student3!;
    await addCourseCompetencies.run(teacher, {
      courseId: f.courseId,
      competencyIds: [ids.a1!, ids.a2!],
    });
    const page = await f.addActivity(
      'page',
      'Таблицы',
      { content: '<p>x</p>' },
      {
        completionMode: 'MANUAL',
      },
    );
    await setActivityCompetency.run(teacher, {
      activityId: page.id,
      competencyId: ids.a1!,
      ruleOutcome: 'COMPLETE',
    });
    await expect(
      setActivityCompetency.run(teacher, {
        activityId: page.id,
        competencyId: ids.b!,
        ruleOutcome: 'COMPLETE',
      }),
    ).rejects.toMatchObject({ fieldErrors: { competencyId: [expect.any(String)] } });

    // completing the activity completes A1, in the course and for the learner
    await toggleManualCompletion.run(student, { activityId: page.id, done: true });
    const own = (competencyId: string, userId = ids.student1!) =>
      t.db.userCompetency.findUnique({ where: { userId_competencyId: { userId, competencyId } } });
    expect(await own(ids.a1!)).toMatchObject({ grade: 2, proficiency: true });
    expect(
      await t.db.userCompetencyCourse.findFirst({
        where: { userId: ids.student1, competencyId: ids.a1 },
      }),
    ).toMatchObject({ grade: 2, proficiency: true });

    // a teacher's rating of A2 makes both children proficient: A is completed by its rule
    await rateInCourse.run(teacher, {
      courseId: f.courseId,
      userId: ids.student1!,
      competencyId: ids.a2!,
      grade: 2,
      note: 'Хорошо',
    });
    expect(await own(ids.a!)).toMatchObject({ grade: 2, proficiency: true });
    const detail = await userCompetencyDetail(student, ids.student1!, ids.a!);
    expect(detail.evidence.map((e) => [e.action, e.description])).toEqual([
      ['COMPLETE', 'ruleMet'],
    ]);
    await expect(
      rateInCourse.run(student, {
        courseId: f.courseId,
        userId: ids.student1!,
        competencyId: ids.a2!,
        grade: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // a course that keeps its ratings to itself
    await setCourseCompetencySettings.run(teacher, { courseId: f.courseId, pushRatings: false });
    await rateInCourse.run(teacher, {
      courseId: f.courseId,
      userId: ids.student2!,
      competencyId: ids.a1!,
      grade: 2,
    });
    expect((await own(ids.a1!, ids.student2!))?.grade ?? null).toBeNull();
    const report = await courseBreakdown(teacher, f.courseId);
    expect(report.rating(ids.student2!, ids.a1!)).toMatchObject({ grade: 2 });
    expect(report.users.map((u) => u.id)).toContain(ids.student3);

    // in use: not deleted
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(deleteCompetency.run(admin, { id: ids.a1! })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('gathers competencies into plans, reviewed, approved and completed', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const student = await ctxFor(t.db, ids.student1!);
    const other = await ctxFor(t.db, ids.student2!);
    const tpl = await saveTemplate.run(admin, { name: 'Аналитик', description: 'План' });
    for (const id of [ids.a1!, ids.a2!])
      await setTemplateCompetency.run(admin, {
        templateId: tpl.id,
        competencyId: id,
        linked: true,
      });
    const cohort = await t.db.cohort.create({
      data: {
        name: 'Поток',
        contextId: SYSTEM_CONTEXT_ID,
        members: { create: [{ userId: ids.student1! }, { userId: ids.student2! }] },
      },
    });
    expect(
      await setTemplateCohort.run(admin, { templateId: tpl.id, cohortId: cohort.id, linked: true }),
    ).toEqual({ created: 2 });
    expect(await syncTemplateCohorts(t.db)).toBe(0);
    await t.db.cohortMember.create({ data: { cohortId: cohort.id, userId: ids.student3! } });
    expect(await syncTemplateCohorts(t.db)).toBe(1);

    const mine = await userPlans(student, ids.student1!);
    const fromTemplate = mine.plans.find((p) => p.templateId === tpl.id)!;
    expect(fromTemplate).toMatchObject({ status: 'ACTIVE', total: 2, proficient: 2 });
    await expect(userPlans(other, ids.student1!)).rejects.toBeInstanceOf(ForbiddenError);

    // the learner's own draft, sent for review and approved
    const own = await savePlan.run(student, { name: 'Свой план' });
    await setPlanCompetency.run(student, { planId: own.id, competencyId: ids.b!, linked: true });
    await planStep.run(student, { id: own.id, step: 'requestReview' });
    await expect(planStep.run(student, { id: own.id, step: 'approve' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await planStep.run(admin, { id: own.id, step: 'review' });
    await planStep.run(admin, { id: own.id, step: 'approve' });
    // an active plan is no longer the learner's to change
    await expect(
      setPlanCompetency.run(student, { planId: own.id, competencyId: ids.a!, linked: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await addCompetencyComment.run(admin, { planId: own.id, text: 'Начните с безопасности' });
    expect(
      await t.db.notification.count({
        where: { userId: ids.student1, type: 'competency.comment' },
      }),
    ).toBe(1);

    // evidence of prior learning, a review asked for and given
    const ev = await saveUserEvidence.run(student, {
      name: 'Курс по безопасности',
      url: 'https://example.org/cert',
    });
    // a link is a web address: one that runs a script when opened is refused
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      await expect(saveUserEvidence.run(student, { name: 'X', url })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        addManualEvidence.run(admin, {
          userId: ids.student1!,
          competencyId: ids.b!,
          note: 'X',
          url,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await linkUserEvidence.run(student, { id: ev.id, competencyId: ids.b!, linked: true });
    await reviewUserCompetency.run(student, {
      userId: ids.student1!,
      competencyId: ids.b!,
      step: 'request',
    });
    await reviewUserCompetency.run(admin, {
      userId: ids.student1!,
      competencyId: ids.b!,
      step: 'start',
    });
    await rateUserCompetency.run(admin, { userId: ids.student1!, competencyId: ids.b!, grade: 2 });
    await reviewUserCompetency.run(admin, {
      userId: ids.student1!,
      competencyId: ids.b!,
      step: 'stop',
    });
    const b = await userCompetencyDetail(student, ids.student1!, ids.b!);
    expect(b.rating).toMatchObject({ status: 'IDLE', grade: 2, proficiency: true });
    expect(b.evidence.map((e) => e.description)).toEqual(['rated', 'priorLearning']);
    expect(b.userEvidence.map((e) => e.name)).toEqual(['Курс по безопасности']);

    // completed: the plan keeps its ratings as they were
    await planStep.run(admin, { id: own.id, step: 'complete' });
    await rateUserCompetency.run(admin, { userId: ids.student1!, competencyId: ids.b!, grade: 1 });
    const done = await planDetail(student, own.id);
    expect(done.plan.status).toBe('COMPLETE');
    expect(done.competencies.map((c) => [c.competency.idNumber, c.grade])).toEqual([['B', 2]]);
    await planStep.run(admin, { id: own.id, step: 'reopen' });
    expect((await planDetail(student, own.id)).competencies[0]!.grade).toBe(1);

    // a template's plan on its own: it keeps the competencies
    await unlinkPlan.run(admin, { id: fromTemplate.id });
    await setTemplateCompetency.run(admin, {
      templateId: tpl.id,
      competencyId: ids.a1!,
      linked: false,
    });
    const unlinked = await planDetail(student, fromTemplate.id);
    expect(unlinked.plan.templateId).toBeNull();
    expect(unlinked.competencies).toHaveLength(2);
  });
  it("shows a course's ratings of its own learners only", async () => {
    const f = await courseFixture(t.db, 'COMP-OWN');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await expect(learnerInCourse(teacher, f.courseId, f.users.student1!)).resolves.toMatchObject({
      user: { id: f.users.student1 },
    });
    // someone who never studied this course, from anywhere on the site
    await expect(learnerInCourse(teacher, f.courseId, f.users.assistant!)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
