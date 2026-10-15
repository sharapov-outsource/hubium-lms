'use server';

import {
  addCompetencyComment,
  addCourseCompetencies,
  addManualEvidence,
  createPlansFromTemplate,
  deleteCompetency,
  deleteCompetencyComment,
  deleteFramework,
  deletePlan,
  deleteTemplate,
  deleteUserEvidence,
  duplicateFramework,
  importFrameworkCsv,
  linkUserEvidence,
  moveCompetency,
  planStep,
  rateInCourse,
  rateUserCompetency,
  removeCourseCompetency,
  reorderCompetency,
  resolveLogins,
  reviewUserCompetency,
  saveCompetency,
  saveFramework,
  savePlan,
  saveTemplate,
  saveUserEvidence,
  setActivityCompetency,
  setCompetencyRule,
  setCourseCompetency,
  setCourseCompetencySettings,
  setPlanCompetency,
  setRelatedCompetency,
  setTemplateCohort,
  setTemplateCompetency,
  USER_EVIDENCE_COMPONENT,
  unlinkPlan,
  ValidationError,
} from '@hubium/core';
import { checkFile, storeFile } from '@hubium/core/files/files';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { createTranslator } from '@hubium/i18n/packs';
import { msg } from '@hubium/module-sdk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { formToObject, runAction } from '../action';
import { db } from '../db';
import { getContext } from '../session';

const ADMIN = '/admin/competencies';
const ids = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);
const date = (v: string | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);

// ── frameworks ───────────────────────────────────────────────────────────────

/** Saves a framework; "new" as the scale makes the usual two-value competence scale first. */
export async function saveFrameworkAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const scaleId = v.scaleId ?? '';
    let scaleConfig: unknown;
    let newScale: { name: string; items: string[] } | undefined;
    if (scaleId === 'new') {
      // made with the framework, under its permission, or not at all
      const t = createTranslator(await getLocale());
      newScale = {
        name: t('competencies.defaultScale.name'),
        items: [t('competencies.defaultScale.no'), t('competencies.defaultScale.yes')],
      };
      scaleConfig = { default: 2, proficient: [2] };
    } else
      scaleConfig = {
        default: Number(v.scaleDefault),
        proficient: fd.getAll('proficient').map(Number),
      };
    const r = await saveFramework.run(ctx, {
      id: v.id || undefined,
      shortName: v.shortName ?? '',
      idNumber: v.idNumber ?? '',
      description: v.description ?? '',
      scaleId,
      newScale,
      scaleConfig,
      taxonomies: fd.getAll('taxonomy').map(String) as never,
      visible: v.visible === 'on',
    });
    revalidatePath(ADMIN, 'layout');
    return r;
  });
}

export async function deleteFrameworkAction(id: string) {
  const r = await runAction(async () => {
    await deleteFramework.run(await getContext(), { id });
    revalidatePath(ADMIN);
    return null;
  });
  if (r.ok) redirect(ADMIN);
  return r;
}

export async function duplicateFrameworkAction(id: string) {
  return runAction(async () => {
    const r = await duplicateFramework.run(await getContext(), { id });
    revalidatePath(ADMIN);
    return r;
  });
}

export async function importFrameworkAction(fd: FormData) {
  return runAction(async () => {
    const file = fd.get('file');
    if (!(file instanceof File) || !file.size)
      throw new ValidationError({ file: [msg('errors.common.chooseCsv')] });
    const r = await importFrameworkCsv.run(await getContext(), { csv: await file.text() });
    revalidatePath(ADMIN);
    return r;
  });
}

// ── competencies ─────────────────────────────────────────────────────────────

export async function saveCompetencyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const own = !!v.scaleId;
    const r = await saveCompetency.run(await getContext(), {
      id: v.id || undefined,
      frameworkId: v.frameworkId || undefined,
      parentId: v.parentId || null,
      shortName: v.shortName ?? '',
      idNumber: v.idNumber ?? '',
      description: v.description ?? '',
      scaleId: own ? v.scaleId! : null,
      scaleConfig: own
        ? { default: Number(v.scaleDefault), proficient: fd.getAll('proficient').map(Number) }
        : undefined,
    });
    revalidatePath(ADMIN, 'layout');
    return r;
  });
}

export async function deleteCompetencyAction(id: string) {
  return runAction(async () => {
    await deleteCompetency.run(await getContext(), { id });
    revalidatePath(ADMIN, 'layout');
    return null;
  });
}

export async function reorderCompetencyAction(id: string, direction: 'up' | 'down') {
  return runAction(async () => {
    await reorderCompetency.run(await getContext(), { id, direction });
    revalidatePath(ADMIN, 'layout');
    return null;
  });
}

export async function moveCompetencyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await moveCompetency.run(await getContext(), {
      id: v.id ?? '',
      parentId: v.parentId || null,
    });
    revalidatePath(ADMIN, 'layout');
    return null;
  });
}

export async function setRuleAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const type = v.ruleType === 'ALL' || v.ruleType === 'POINTS' ? v.ruleType : null;
    let ruleConfig: unknown;
    if (type === 'POINTS') {
      const children = ids(v.children).map((id) => ({
        id,
        points: Number(v[`points-${id}`] || 0),
        required: v[`required-${id}`] === 'on',
      }));
      ruleConfig = {
        points: Number(v.points || 0),
        children: children.filter((c) => c.points || c.required),
      };
    }
    await setCompetencyRule.run(await getContext(), {
      id: v.id ?? '',
      ruleType: type,
      ruleOutcome: (v.ruleOutcome ?? 'NONE') as never,
      ruleConfig,
    });
    revalidatePath(ADMIN, 'layout');
    return null;
  });
}

export async function setRelatedAction(id: string, relatedId: string, related: boolean) {
  return runAction(async () => {
    await setRelatedCompetency.run(await getContext(), { id, relatedId, related });
    revalidatePath(ADMIN, 'layout');
    return null;
  });
}

export async function addRelatedAction(fd: FormData) {
  const v = formToObject(fd);
  return setRelatedAction(v.id ?? '', v.relatedId ?? '', true);
}

// ── templates ────────────────────────────────────────────────────────────────

const TEMPLATES = `${ADMIN}/templates`;

export async function saveTemplateAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveTemplate.run(await getContext(), {
      id: v.id || undefined,
      name: v.name ?? '',
      description: v.description ?? '',
      dueDate: date(v.dueDate),
      visible: v.visible === 'on',
    });
    revalidatePath(TEMPLATES, 'layout');
    return r;
  });
}

export async function deleteTemplateAction(id: string, deletePlans: boolean) {
  const r = await runAction(async () => {
    await deleteTemplate.run(await getContext(), { id, deletePlans });
    revalidatePath(TEMPLATES);
    return null;
  });
  if (r.ok) redirect(TEMPLATES);
  return r;
}

export async function addTemplateCompetenciesAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    for (const competencyId of ids(v.competencyIds))
      await setTemplateCompetency.run(ctx, {
        templateId: v.templateId ?? '',
        competencyId,
        linked: true,
      });
    revalidatePath(TEMPLATES, 'layout');
    return null;
  });
}

export async function removeTemplateCompetencyAction(templateId: string, competencyId: string) {
  return runAction(async () => {
    await setTemplateCompetency.run(await getContext(), {
      templateId,
      competencyId,
      linked: false,
    });
    revalidatePath(TEMPLATES, 'layout');
    return null;
  });
}

export async function setTemplateCohortAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await setTemplateCohort.run(await getContext(), {
      templateId: v.templateId ?? '',
      cohortId: v.cohortId ?? '',
      linked: v.linked !== 'false',
    });
    revalidatePath(TEMPLATES, 'layout');
    return r;
  });
}

/** Plans from the template for people named by email or login, one per line or comma. */
export async function createPlansAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const userIds = await resolveLogins(ctx, v.logins, {
      allowed: () => ctx.perm.require('competency:planmanage'),
      field: 'logins',
    });
    if (!userIds.length)
      throw new ValidationError({ logins: [msg('errors.competencies.namePerson')] });
    const r = await createPlansFromTemplate.run(ctx, { templateId: v.templateId ?? '', userIds });
    revalidatePath(TEMPLATES, 'layout');
    return r;
  });
}

// ── courses ──────────────────────────────────────────────────────────────────

const coursePath = (courseId: string | undefined) => `/course/${courseId}/competencies`;

export async function addCourseCompetenciesAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await addCourseCompetencies.run(await getContext(), {
      courseId: v.courseId ?? '',
      competencyIds: ids(v.competencyIds),
    });
    revalidatePath(coursePath(v.courseId), 'layout');
    return r;
  });
}

export async function removeCourseCompetencyAction(courseId: string, competencyId: string) {
  return runAction(async () => {
    await removeCourseCompetency.run(await getContext(), { courseId, competencyId });
    revalidatePath(coursePath(courseId), 'layout');
    return null;
  });
}

export async function setCourseCompetencyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await setCourseCompetency.run(await getContext(), {
      courseId: v.courseId ?? '',
      competencyId: v.competencyId ?? '',
      ruleOutcome: (v.ruleOutcome as never) || undefined,
      move: v.move === 'up' || v.move === 'down' ? v.move : undefined,
    });
    revalidatePath(coursePath(v.courseId), 'layout');
    return null;
  });
}

export async function setCourseCompetencySettingsAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await setCourseCompetencySettings.run(await getContext(), {
      courseId: v.courseId ?? '',
      pushRatings: v.pushRatings === 'on',
    });
    revalidatePath(coursePath(v.courseId), 'layout');
    return null;
  });
}

export async function setActivityCompetencyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await setActivityCompetency.run(await getContext(), {
      activityId: v.activityId ?? '',
      competencyId: v.competencyId ?? '',
      ruleOutcome: v.ruleOutcome === 'REMOVE' ? null : ((v.ruleOutcome ?? 'NONE') as never),
    });
    revalidatePath(coursePath(v.courseId), 'layout');
    return null;
  });
}

export async function rateInCourseAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await rateInCourse.run(await getContext(), {
      courseId: v.courseId ?? '',
      userId: v.userId ?? '',
      competencyId: v.competencyId ?? '',
      grade: v.grade ? Number(v.grade) : null,
      note: v.note ?? '',
    });
    revalidatePath(coursePath(v.courseId), 'layout');
    return null;
  });
}

// ── people's competencies and plans ──────────────────────────────────────────

const userPath = (userId: string | undefined, competencyId: string | undefined) =>
  `/competencies/user/${userId}/${competencyId}`;

export async function rateUserCompetencyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await rateUserCompetency.run(await getContext(), {
      userId: v.userId ?? '',
      competencyId: v.competencyId ?? '',
      grade: v.grade ? Number(v.grade) : null,
      note: v.note ?? '',
    });
    revalidatePath(userPath(v.userId, v.competencyId));
    return null;
  });
}

export async function reviewAction(
  userId: string,
  competencyId: string,
  step: 'request' | 'cancel' | 'start' | 'stop',
) {
  return runAction(async () => {
    const r = await reviewUserCompetency.run(await getContext(), { userId, competencyId, step });
    revalidatePath(userPath(userId, competencyId));
    return r;
  });
}

export async function addEvidenceNoteAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await addManualEvidence.run(await getContext(), {
      userId: v.userId ?? '',
      competencyId: v.competencyId ?? '',
      note: v.note ?? '',
      url: v.url ?? '',
    });
    revalidatePath(userPath(v.userId, v.competencyId));
    return null;
  });
}

export async function commentAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await addCompetencyComment.run(await getContext(), {
      planId: v.planId || undefined,
      userId: v.userId || undefined,
      competencyId: v.competencyId || undefined,
      text: v.text ?? '',
    });
    revalidatePath(v.planId ? `/plans/${v.planId}` : userPath(v.userId, v.competencyId));
    return null;
  });
}

export async function deleteCommentAction(id: string, path: string) {
  return runAction(async () => {
    await deleteCompetencyComment.run(await getContext(), { id });
    revalidatePath(path);
    return null;
  });
}

export async function savePlanAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await savePlan.run(await getContext(), {
      id: v.id || undefined,
      userId: v.userId || undefined,
      name: v.name ?? '',
      description: v.description ?? '',
      dueDate: date(v.dueDate),
    });
    revalidatePath('/plans', 'layout');
    return r;
  });
}

export async function deletePlanAction(id: string, userId: string) {
  const r = await runAction(async () => {
    await deletePlan.run(await getContext(), { id });
    revalidatePath('/plans', 'layout');
    return null;
  });
  if (r.ok) redirect(`/plans?user=${userId}`);
  return r;
}

export async function planStepAction(
  id: string,
  step:
    | 'requestReview'
    | 'cancelReview'
    | 'review'
    | 'stopReview'
    | 'approve'
    | 'unapprove'
    | 'complete'
    | 'reopen',
) {
  return runAction(async () => {
    const r = await planStep.run(await getContext(), { id, step });
    revalidatePath('/plans', 'layout');
    return r;
  });
}

export async function unlinkPlanAction(id: string) {
  return runAction(async () => {
    await unlinkPlan.run(await getContext(), { id });
    revalidatePath('/plans', 'layout');
    return null;
  });
}

export async function addPlanCompetenciesAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    for (const competencyId of ids(v.competencyIds))
      await setPlanCompetency.run(ctx, { planId: v.planId ?? '', competencyId, linked: true });
    revalidatePath(`/plans/${v.planId}`);
    return null;
  });
}

export async function removePlanCompetencyAction(planId: string, competencyId: string) {
  return runAction(async () => {
    await setPlanCompetency.run(await getContext(), { planId, competencyId, linked: false });
    revalidatePath(`/plans/${planId}`);
    return null;
  });
}

// ── evidence of prior learning ───────────────────────────────────────────────

const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;

export async function saveUserEvidenceAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    const files = fd.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.some((f) => f.size > EVIDENCE_MAX_BYTES))
      throw new ValidationError({ files: [msg('errors.competencies.evidenceTooLarge')] });
    // checked (malware too) before the evidence is saved, or a refused file would leave it
    // saved without its files, and the next try would save it twice
    const uploads = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        mimeType: f.type,
        data: Buffer.from(await f.arrayBuffer()),
      })),
    );
    for (const u of uploads) await checkFile(db, u);
    const r = await saveUserEvidence.run(ctx, {
      id: v.id || undefined,
      userId: v.userId || undefined,
      name: v.name ?? '',
      description: v.description ?? '',
      url: v.url ?? '',
    });
    for (const u of uploads)
      await storeFile(db, {
        contextId: SYSTEM_CONTEXT_ID,
        component: USER_EVIDENCE_COMPONENT,
        area: 'userevidence',
        itemId: r.id,
        ...u,
        uploadedById: ctx.perm.userId ?? null,
      });
    for (const competencyId of ids(v.competencyIds))
      await linkUserEvidence.run(ctx, { id: r.id, competencyId, linked: true });
    revalidatePath('/evidence');
    return r;
  });
}

export async function deleteUserEvidenceAction(id: string) {
  return runAction(async () => {
    await deleteUserEvidence.run(await getContext(), { id });
    revalidatePath('/evidence');
    return null;
  });
}

export async function unlinkUserEvidenceAction(id: string, competencyId: string) {
  return runAction(async () => {
    await linkUserEvidence.run(await getContext(), { id, competencyId, linked: false });
    revalidatePath('/evidence');
    return null;
  });
}
