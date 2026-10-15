import {
  type Db,
  type LearningPlan,
  type LearningPlanStatus,
  type Prisma,
  SYSTEM_CONTEXT_ID,
} from '@hubium/db';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { deleteFiles, registerFileArea } from '../files/files.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { competencyScale } from './frameworks.ts';
import { addEvidence, canViewUserCompetencies } from './ratings.ts';

// Learning plans, as Moodle's: a person's list of competencies to work on, made from a
// template (for chosen people, or for every member of linked cohorts) or put together
// for them; a draft is reviewed and approved, an active plan follows the ratings, and a
// completed plan keeps them as they were. People add evidence of prior learning (a link,
// files) to their competencies, and comment on plans and competencies.

type Tx = Prisma.TransactionClient | Db;

export const USER_EVIDENCE_COMPONENT = 'competency';

// evidence files: their owner, and those who see the owner's competencies
registerFileArea(USER_EVIDENCE_COMPONENT, 'userevidence', async (ctx, file) => {
  const e = await ctx.db.userEvidence.findUnique({
    where: { id: file.itemId ?? '' },
    select: { userId: true },
  });
  return !!e && canViewUserCompetencies(ctx, e.userId);
});

const DRAFTS: LearningPlanStatus[] = ['DRAFT', 'WAITING_FOR_REVIEW', 'IN_REVIEW'];

async function loadPlan(db: Tx, id: string) {
  const p = await db.learningPlan.findUnique({ where: { id } });
  if (!p) throw new NotFoundError('Learning plan');
  return p;
}

async function loadTemplate(db: Tx, id: string) {
  const t = await db.learningPlanTemplate.findUnique({ where: { id } });
  if (!t) throw new NotFoundError('Learning plan template');
  return t;
}

/** What the viewer may do with a plan. */
export async function planAccess(ctx: RequestContext, p: LearningPlan) {
  const own = p.userId === ctx.perm.userId;
  const [manageAll, manageOwn, review, requestReview] = await Promise.all([
    ctx.perm.can('competency:planmanage'),
    ctx.perm.can('competency:planmanageown'),
    ctx.perm.can('competency:review'),
    ctx.perm.can('competency:requestreview'),
  ]);
  const draft = DRAFTS.includes(p.status);
  return {
    view: own || (await canViewUserCompetencies(ctx, p.userId)),
    /** Change its name, dates and competencies. */
    edit: (manageAll || (own && manageOwn && draft)) && p.status !== 'COMPLETE',
    remove: manageAll || (own && manageOwn && draft),
    requestReview: own && requestReview && p.status === 'DRAFT',
    cancelReview: own && requestReview && p.status === 'WAITING_FOR_REVIEW',
    review: review && !own && (p.status === 'WAITING_FOR_REVIEW' || p.status === 'DRAFT'),
    stopReview: review && p.status === 'IN_REVIEW',
    approve: (manageAll || review) && !own && draft,
    unapprove: manageAll && p.status === 'ACTIVE',
    complete: manageAll && p.status === 'ACTIVE',
    reopen: manageAll && p.status === 'COMPLETE',
    unlink: manageAll && !!p.templateId && p.status !== 'COMPLETE',
    comment: own || manageAll || review,
  };
}

async function requirePlan(
  ctx: RequestContext,
  id: string,
  what: keyof Awaited<ReturnType<typeof planAccess>>,
) {
  const p = await loadPlan(ctx.db, id);
  if (!(await planAccess(ctx, p))[what]) throw new ForbiddenError();
  return p;
}

// ── templates ────────────────────────────────────────────────────────────────

export const saveTemplate = defineOperation({
  name: 'competency.template.save',
  input: z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).default(''),
    dueDate: z.coerce.date().nullable().default(null),
    visible: z.boolean().default(true),
  }),
  authorize: (ctx) => ctx.perm.require('competency:templatemanage'),
  async handler(ctx, i) {
    const data = {
      name: i.name,
      description: i.description,
      dueDate: i.dueDate,
      visible: i.visible,
    };
    if (i.id) {
      await loadTemplate(ctx.tx, i.id);
      await ctx.tx.learningPlanTemplate.update({ where: { id: i.id }, data });
      // linked plans follow their template's name and dates
      await ctx.tx.learningPlan.updateMany({
        where: { templateId: i.id, status: { not: 'COMPLETE' } },
        data: { name: i.name, description: i.description, dueDate: i.dueDate },
      });
      return { id: i.id };
    }
    const t = await ctx.tx.learningPlanTemplate.create({
      data: { ...data, createdById: ctx.perm.userId },
    });
    return { id: t.id };
  },
});

/** Deletes a template; its plans are deleted with it or kept with its competencies. */
export const deleteTemplate = defineOperation({
  name: 'competency.template.delete',
  input: z.object({ id: z.string().uuid(), deletePlans: z.boolean().default(false) }),
  authorize: (ctx) => ctx.perm.require('competency:templatemanage'),
  async handler(ctx, { id, deletePlans }) {
    await loadTemplate(ctx.tx, id);
    const plans = await ctx.tx.learningPlan.findMany({ where: { templateId: id } });
    if (deletePlans) await ctx.tx.learningPlan.deleteMany({ where: { templateId: id } });
    else for (const p of plans) await unlink(ctx.tx, p);
    await ctx.tx.learningPlanTemplate.delete({ where: { id } });
    return { id, plans: plans.length };
  },
});

export const setTemplateCompetency = defineOperation({
  name: 'competency.template.competency',
  input: z.object({
    templateId: z.string().uuid(),
    competencyId: z.string().uuid(),
    linked: z.boolean(),
  }),
  authorize: (ctx) => ctx.perm.require('competency:templatemanage'),
  async handler(ctx, { templateId, competencyId, linked }) {
    await loadTemplate(ctx.tx, templateId);
    if (!linked) {
      // a completed plan keeps what it had; others follow the template
      await ctx.tx.learningPlanTemplateCompetency.deleteMany({
        where: { templateId, competencyId },
      });
      return { templateId };
    }
    if (
      !(await ctx.tx.competency.findFirst({
        where: { id: competencyId, framework: { visible: true } },
      }))
    )
      throw new ValidationError({ competencyId: ['Unknown competency'] });
    const last = await ctx.tx.learningPlanTemplateCompetency.aggregate({
      where: { templateId },
      _max: { sortOrder: true },
    });
    await ctx.tx.learningPlanTemplateCompetency.upsert({
      where: { templateId_competencyId: { templateId, competencyId } },
      create: { templateId, competencyId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      update: {},
    });
    return { templateId };
  },
});

export const setTemplateCohort = defineOperation({
  name: 'competency.template.cohort',
  input: z.object({
    templateId: z.string().uuid(),
    cohortId: z.string().uuid(),
    linked: z.boolean(),
  }),
  authorize: (ctx) => ctx.perm.require('competency:templatemanage'),
  async handler(ctx, { templateId, cohortId, linked }) {
    const t = await loadTemplate(ctx.tx, templateId);
    if (!linked) {
      // plans already made stay theirs
      await ctx.tx.learningPlanTemplateCohort.deleteMany({ where: { templateId, cohortId } });
      return { created: 0 };
    }
    if (!(await ctx.tx.cohort.findUnique({ where: { id: cohortId } })))
      throw new ValidationError({ cohortId: ['Unknown cohort'] });
    await ctx.tx.learningPlanTemplateCohort.upsert({
      where: { templateId_cohortId: { templateId, cohortId } },
      create: { templateId, cohortId },
      update: {},
    });
    const members = await ctx.tx.cohortMember.findMany({
      where: { cohortId },
      select: { userId: true },
    });
    return {
      created: await createPlans(
        ctx.tx,
        t,
        members.map((m) => m.userId),
        ctx.perm.userId ?? null,
      ),
    };
  },
});

/** Plans from a template for those of these people who have none from it; how many. */
async function createPlans(
  tx: Tx,
  t: { id: string; name: string; description: string; dueDate: Date | null; visible: boolean },
  userIds: string[],
  actorId: string | null,
): Promise<number> {
  if (!t.visible || !userIds.length) return 0;
  const [have, active] = await Promise.all([
    tx.learningPlan.findMany({
      where: { userId: { in: userIds }, OR: [{ templateId: t.id }, { origTemplateId: t.id }] },
      select: { userId: true },
    }),
    tx.user.findMany({
      where: { id: { in: userIds }, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    }),
  ]);
  const skip = new Set(have.map((h) => h.userId));
  const users = active.map((u) => u.id).filter((u) => !skip.has(u));
  for (const userId of users)
    await tx.learningPlan.create({
      data: {
        userId,
        templateId: t.id,
        name: t.name,
        description: t.description,
        dueDate: t.dueDate,
        status: 'ACTIVE',
        createdById: actorId,
      },
    });
  if (users.length)
    await notifyUsers(tx, users, {
      type: 'competency.plan',
      title: { key: 'notifications.text.planCreated', values: { name: t.name } },
      body: '',
      url: '/plans',
    });
  return users.length;
}

export const createPlansFromTemplate = defineOperation({
  name: 'competency.template.plans',
  input: z.object({
    templateId: z.string().uuid(),
    userIds: z.array(z.string().uuid()).min(1).max(1000),
  }),
  authorize: (ctx) => ctx.perm.require('competency:planmanage'),
  async handler(ctx, { templateId, userIds }) {
    const t = await loadTemplate(ctx.tx, templateId);
    if (!t.visible) throw new ValidationError({ templateId: ['The template is hidden'] });
    return { created: await createPlans(ctx.tx, t, userIds, ctx.perm.userId ?? null) };
  },
});

/** Cron (hourly): members of templates' cohorts get their plans. */
export async function syncTemplateCohorts(db: Db, now = new Date()): Promise<number> {
  const links = await db.learningPlanTemplateCohort.findMany({
    where: {
      template: { visible: true, OR: [{ dueDate: null }, { dueDate: { gt: now } }] },
    },
    include: { template: true },
  });
  let n = 0;
  for (const l of links) {
    const members = await db.cohortMember.findMany({
      where: { cohortId: l.cohortId },
      select: { userId: true },
    });
    n += await db.$transaction((tx) =>
      createPlans(
        tx,
        l.template,
        members.map((m) => m.userId),
        null,
      ),
    );
  }
  return n;
}

// ── plans ────────────────────────────────────────────────────────────────────

export const savePlan = defineOperation({
  name: 'competency.plan.save',
  input: z.object({
    id: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).default(''),
    dueDate: z.coerce.date().nullable().default(null),
  }),
  async authorize(ctx, i) {
    if (i.id) {
      await requirePlan(ctx, i.id, 'edit');
      return;
    }
    const userId = i.userId ?? ctx.perm.userId;
    if (userId === ctx.perm.userId && (await ctx.perm.can('competency:planmanageown'))) return;
    await ctx.perm.require('competency:planmanage');
  },
  async handler(ctx, i) {
    const data = { name: i.name, description: i.description, dueDate: i.dueDate };
    if (i.id) {
      const p = await loadPlan(ctx.tx, i.id);
      // a template's plan takes its name and dates from the template
      if (p.templateId) throw new ConflictError('The plan follows its template; unlink it first');
      await ctx.tx.learningPlan.update({ where: { id: p.id }, data });
      return { id: p.id };
    }
    const userId = i.userId ?? ctx.perm.userId!;
    if (!(await ctx.tx.user.findUnique({ where: { id: userId } })))
      throw new ValidationError({ userId: ['Unknown user'] });
    const p = await ctx.tx.learningPlan.create({
      data: { ...data, userId, status: 'DRAFT', createdById: ctx.perm.userId },
    });
    return { id: p.id };
  },
});

export const deletePlan = defineOperation({
  name: 'competency.plan.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) => void (await requirePlan(ctx, i.id, 'remove')),
  async handler(ctx, { id }) {
    await ctx.tx.learningPlan.delete({ where: { id } });
    return { id };
  },
});

export const setPlanCompetency = defineOperation({
  name: 'competency.plan.competency',
  input: z.object({
    planId: z.string().uuid(),
    competencyId: z.string().uuid(),
    linked: z.boolean(),
  }),
  authorize: async (ctx, i) => void (await requirePlan(ctx, i.planId, 'edit')),
  async handler(ctx, { planId, competencyId, linked }) {
    const p = await loadPlan(ctx.tx, planId);
    if (p.templateId) throw new ConflictError('The plan follows its template; unlink it first');
    if (!linked) {
      await ctx.tx.learningPlanCompetency.deleteMany({ where: { planId, competencyId } });
      return { planId };
    }
    if (
      !(await ctx.tx.competency.findFirst({
        where: { id: competencyId, framework: { visible: true } },
      }))
    )
      throw new ValidationError({ competencyId: ['Unknown competency'] });
    const last = await ctx.tx.learningPlanCompetency.aggregate({
      where: { planId },
      _max: { sortOrder: true },
    });
    await ctx.tx.learningPlanCompetency.upsert({
      where: { planId_competencyId: { planId, competencyId } },
      create: { planId, competencyId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      update: {},
    });
    return { planId };
  },
});

/** The plan keeps the template's competencies as its own, and stops following it. */
async function unlink(tx: Tx, p: LearningPlan) {
  if (!p.templateId) return;
  const comps = await tx.learningPlanTemplateCompetency.findMany({
    where: { templateId: p.templateId },
  });
  if (comps.length)
    await tx.learningPlanCompetency.createMany({
      data: comps.map((c) => ({
        planId: p.id,
        competencyId: c.competencyId,
        sortOrder: c.sortOrder,
      })),
      skipDuplicates: true,
    });
  await tx.learningPlan.update({
    where: { id: p.id },
    data: { templateId: null, origTemplateId: p.templateId },
  });
}

export const unlinkPlan = defineOperation({
  name: 'competency.plan.unlink',
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) => void (await requirePlan(ctx, i.id, 'unlink')),
  async handler(ctx, { id }) {
    await unlink(ctx.tx, await loadPlan(ctx.tx, id));
    return { id };
  },
});

/** The competencies of a plan, in order: its template's while linked, its own otherwise. */
export async function planCompetencyIds(db: Tx, p: Pick<LearningPlan, 'id' | 'templateId'>) {
  const rows = p.templateId
    ? await db.learningPlanTemplateCompetency.findMany({
        where: { templateId: p.templateId },
        orderBy: { sortOrder: 'asc' },
      })
    : await db.learningPlanCompetency.findMany({
        where: { planId: p.id },
        orderBy: { sortOrder: 'asc' },
      });
  return rows.map((r) => r.competencyId);
}

const STEPS = [
  'requestReview',
  'cancelReview',
  'review',
  'stopReview',
  'approve',
  'unapprove',
  'complete',
  'reopen',
] as const;

/** Moves a plan along: reviews, approval, completion (which keeps its ratings), reopening. */
export const planStep = defineOperation({
  name: 'competency.plan.step',
  input: z.object({ id: z.string().uuid(), step: z.enum(STEPS) }),
  authorize: async (ctx, i) => void (await requirePlan(ctx, i.id, i.step)),
  async handler(ctx, { id, step }) {
    const p = await loadPlan(ctx.tx, id);
    const status: Record<(typeof STEPS)[number], LearningPlanStatus> = {
      requestReview: 'WAITING_FOR_REVIEW',
      cancelReview: 'DRAFT',
      review: 'IN_REVIEW',
      stopReview: 'DRAFT',
      approve: 'ACTIVE',
      unapprove: 'DRAFT',
      complete: 'COMPLETE',
      reopen: 'ACTIVE',
    };
    if (step === 'complete') {
      const ids = await planCompetencyIds(ctx.tx, p);
      const ratings = await ctx.tx.userCompetency.findMany({
        where: { userId: p.userId, competencyId: { in: ids } },
      });
      await ctx.tx.userCompetencyPlan.createMany({
        data: ids.map((competencyId, sortOrder) => {
          const r = ratings.find((x) => x.competencyId === competencyId);
          return {
            userId: p.userId,
            planId: p.id,
            competencyId,
            sortOrder,
            grade: r?.grade ?? null,
            proficiency: r?.proficiency ?? null,
          };
        }),
        skipDuplicates: true,
      });
      // reviews under way end with the plan
      await ctx.tx.userCompetency.updateMany({
        where: { userId: p.userId, competencyId: { in: ids }, status: { not: 'IDLE' } },
        data: { status: 'IDLE' },
      });
    }
    if (step === 'reopen') await ctx.tx.userCompetencyPlan.deleteMany({ where: { planId: p.id } });
    await ctx.tx.learningPlan.update({
      where: { id: p.id },
      data: {
        status: status[step],
        ...(step === 'review' ? { reviewerId: ctx.perm.userId } : {}),
      },
    });
    if (step === 'approve' || step === 'complete')
      await notifyUsers(ctx.tx, [p.userId], {
        type: 'competency.plan',
        title: {
          key:
            step === 'approve'
              ? 'notifications.text.planApproved'
              : 'notifications.text.planCompleted',
          values: { name: p.name },
        },
        body: '',
        url: `/plans/${p.id}`,
      });
    await logEvent(ctx.tx, {
      name: `competency.plan.${step}`,
      actorId: ctx.perm.userId,
      relatedUserId: p.userId,
      objectType: 'learningPlan',
      objectId: p.id,
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { status: status[step] };
  },
});

// ── comments ─────────────────────────────────────────────────────────────────

export const addCompetencyComment = defineOperation({
  name: 'competency.comment',
  input: z.object({
    planId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    competencyId: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(5000),
  }),
  async authorize(ctx, i) {
    if (i.planId) await requirePlan(ctx, i.planId, 'comment');
    else if (i.userId && i.competencyId) {
      const own = i.userId === ctx.perm.userId;
      if (!own && !(await ctx.perm.can('competency:review'))) {
        if (!(await canViewUserCompetencies(ctx, i.userId))) throw new ForbiddenError();
        await ctx.perm.require('competency:planmanage');
      }
    } else throw new ValidationError({ planId: ['A plan or a competency'] });
  },
  async handler(ctx, i) {
    let userCompetencyId: string | null = null;
    let owner: string;
    if (i.planId) owner = (await loadPlan(ctx.tx, i.planId)).userId;
    else {
      const uc = await ctx.tx.userCompetency.upsert({
        where: { userId_competencyId: { userId: i.userId!, competencyId: i.competencyId! } },
        create: { userId: i.userId!, competencyId: i.competencyId! },
        update: {},
      });
      userCompetencyId = uc.id;
      owner = uc.userId;
    }
    const c = await ctx.tx.competencyComment.create({
      data: {
        planId: i.planId ?? null,
        userCompetencyId,
        authorId: ctx.perm.userId,
        text: i.text,
      },
    });
    // the person it is about hears of others' comments
    if (owner !== ctx.perm.userId)
      await notifyUsers(ctx.tx, [owner], {
        type: 'competency.comment',
        title: { key: 'notifications.text.competencyComment', values: {} },
        body: i.text.slice(0, 300),
        url: i.planId ? `/plans/${i.planId}` : `/competencies/user/${owner}/${i.competencyId}`,
      });
    return { id: c.id };
  },
});

export const deleteCompetencyComment = defineOperation({
  name: 'competency.comment.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const c = await ctx.db.competencyComment.findUnique({ where: { id: i.id } });
    if (!c) throw new NotFoundError('Comment');
    if (c.authorId !== ctx.perm.userId) await ctx.perm.require('competency:planmanage');
  },
  async handler(ctx, { id }) {
    await ctx.tx.competencyComment.delete({ where: { id } });
    return { id };
  },
});

// ── evidence of prior learning ───────────────────────────────────────────────

async function requireOwnEvidence(ctx: RequestContext, userId: string) {
  if (userId === ctx.perm.userId) await ctx.perm.require('competency:evidencemanageown');
  else await ctx.perm.require('competency:planmanage');
}

export const saveUserEvidence = defineOperation({
  name: 'competency.userevidence.save',
  input: z.object({
    id: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).default(''),
    url: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2000)]).default(''),
  }),
  async authorize(ctx, i) {
    const userId = i.id
      ? (await ctx.db.userEvidence.findUnique({ where: { id: i.id } }))?.userId
      : (i.userId ?? ctx.perm.userId);
    if (!userId) throw new NotFoundError('Evidence');
    await requireOwnEvidence(ctx, userId);
  },
  async handler(ctx, i) {
    const data = { name: i.name, description: i.description, url: i.url };
    if (i.id) {
      await ctx.tx.userEvidence.update({ where: { id: i.id }, data });
      return { id: i.id };
    }
    const e = await ctx.tx.userEvidence.create({
      data: { ...data, userId: i.userId ?? ctx.perm.userId! },
    });
    return { id: e.id };
  },
});

export const deleteUserEvidence = defineOperation({
  name: 'competency.userevidence.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const e = await ctx.db.userEvidence.findUnique({ where: { id: i.id } });
    if (!e) throw new NotFoundError('Evidence');
    await requireOwnEvidence(ctx, e.userId);
  },
  async handler(ctx, { id }) {
    await deleteFiles(ctx.tx, {
      contextId: SYSTEM_CONTEXT_ID,
      component: USER_EVIDENCE_COMPONENT,
      area: 'userevidence',
      itemId: id,
    });
    await ctx.tx.userEvidence.delete({ where: { id } });
    return { id };
  },
});

/** Ties evidence to a competency (logged on it), or unties it. */
export const linkUserEvidence = defineOperation({
  name: 'competency.userevidence.link',
  input: z.object({
    id: z.string().uuid(),
    competencyId: z.string().uuid(),
    linked: z.boolean(),
  }),
  async authorize(ctx, i) {
    const e = await ctx.db.userEvidence.findUnique({ where: { id: i.id } });
    if (!e) throw new NotFoundError('Evidence');
    await requireOwnEvidence(ctx, e.userId);
  },
  async handler(ctx, { id, competencyId, linked }) {
    const e = await ctx.tx.userEvidence.findUniqueOrThrow({ where: { id } });
    if (!linked) {
      await ctx.tx.userEvidenceCompetency.deleteMany({
        where: { userEvidenceId: id, competencyId },
      });
      return { id };
    }
    if (
      !(await ctx.tx.competency.findFirst({
        where: { id: competencyId, framework: { visible: true } },
      }))
    )
      throw new ValidationError({ competencyId: ['Unknown competency'] });
    const had = await ctx.tx.userEvidenceCompetency.findUnique({
      where: { userEvidenceId_competencyId: { userEvidenceId: id, competencyId } },
    });
    if (had) return { id };
    await ctx.tx.userEvidenceCompetency.create({ data: { userEvidenceId: id, competencyId } });
    await addEvidence(ctx.tx, {
      userId: e.userId,
      competencyId,
      contextId: SYSTEM_CONTEXT_ID,
      action: 'LOG',
      description: 'priorLearning',
      data: { name: e.name },
      url: e.url || null,
      actorId: ctx.perm.userId,
    });
    return { id };
  },
});

// ── reading ──────────────────────────────────────────────────────────────────

export async function listTemplates(ctx: RequestContext) {
  await ctx.perm.require('competency:templatemanage');
  return ctx.db.learningPlanTemplate.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { competencies: true, cohorts: true, plans: true } } },
  });
}

export async function templateDetail(ctx: RequestContext, id: string) {
  await ctx.perm.require('competency:templatemanage');
  const t = await ctx.db.learningPlanTemplate.findUnique({
    where: { id },
    include: {
      competencies: {
        orderBy: { sortOrder: 'asc' },
        include: {
          competency: { include: { framework: { select: { id: true, shortName: true } } } },
        },
      },
      cohorts: { include: { cohort: { select: { id: true, name: true } } } },
      plans: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!t) throw new NotFoundError('Learning plan template');
  return { ...t, createPlans: await ctx.perm.can('competency:planmanage') };
}

/** A person's plans, for them and those who see their competencies. */
export async function userPlans(ctx: RequestContext, userId: string) {
  if (!(await canViewUserCompetencies(ctx, userId))) throw new ForbiddenError();
  const [user, plans, manageOwn, manageAll] = await Promise.all([
    ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true } }),
    ctx.db.learningPlan.findMany({
      where: { userId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    }),
    ctx.perm.can('competency:planmanageown'),
    ctx.perm.can('competency:planmanage'),
  ]);
  if (!user) throw new NotFoundError('User');
  const counts = await Promise.all(
    plans.map(async (p) => {
      const ids = await planCompetencyIds(ctx.db, p);
      const proficient =
        p.status === 'COMPLETE'
          ? await ctx.db.userCompetencyPlan.count({ where: { planId: p.id, proficiency: true } })
          : await ctx.db.userCompetency.count({
              where: { userId, competencyId: { in: ids }, proficiency: true },
            });
      return { total: ids.length, proficient };
    }),
  );
  return {
    user,
    plans: plans.map((p, i) => ({ ...p, ...counts[i]! })),
    canCreate: manageAll || (userId === ctx.perm.userId && manageOwn),
  };
}

/** A plan with its competencies and the ratings it shows (kept ones once completed). */
export async function planDetail(ctx: RequestContext, id: string) {
  const p = await ctx.db.learningPlan.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true } },
      template: { select: { id: true, name: true } },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true } } },
      },
    },
  });
  if (!p) throw new NotFoundError('Learning plan');
  const access = await planAccess(ctx, p);
  if (!access.view) throw new ForbiddenError();
  const ids = await planCompetencyIds(ctx.db, p);
  const [competencies, ratings, kept] = await Promise.all([
    ctx.db.competency.findMany({
      where: { id: { in: ids } },
      include: { framework: { select: { id: true, shortName: true } } },
    }),
    ctx.db.userCompetency.findMany({ where: { userId: p.userId, competencyId: { in: ids } } }),
    p.status === 'COMPLETE'
      ? ctx.db.userCompetencyPlan.findMany({ where: { planId: p.id } })
      : Promise.resolve([]),
  ]);
  const rows = await Promise.all(
    ids.map(async (cid) => {
      const c = competencies.find((x) => x.id === cid)!;
      const r =
        p.status === 'COMPLETE'
          ? kept.find((x) => x.competencyId === cid)
          : ratings.find((x) => x.competencyId === cid);
      return {
        competency: c,
        scale: await competencyScale(ctx.db, c),
        grade: r?.grade ?? null,
        proficiency: r?.proficiency ?? null,
        status: ratings.find((x) => x.competencyId === cid)?.status ?? 'IDLE',
      };
    }),
  );
  const reviewer = p.reviewerId
    ? await ctx.db.user.findUnique({ where: { id: p.reviewerId }, select: { name: true } })
    : null;
  return {
    plan: p,
    access,
    competencies: rows.filter((r) => r.competency),
    reviewer: reviewer?.name ?? null,
  };
}

/** What waits for the viewer's review: plans and competencies people asked about. */
export async function reviewQueue(ctx: RequestContext) {
  await ctx.perm.require('competency:review');
  const me = ctx.perm.userId ?? '';
  const [plans, competencies] = await Promise.all([
    ctx.db.learningPlan.findMany({
      where: {
        userId: { not: me },
        OR: [{ status: 'WAITING_FOR_REVIEW' }, { status: 'IN_REVIEW', reviewerId: me }],
      },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'asc' },
    }),
    ctx.db.userCompetency.findMany({
      where: {
        userId: { not: me },
        OR: [{ status: 'WAITING_FOR_REVIEW' }, { status: 'IN_REVIEW', reviewerId: me }],
      },
      include: {
        user: { select: { id: true, name: true } },
        competency: { select: { id: true, shortName: true, idNumber: true } },
      },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);
  return { plans, competencies };
}

/** A person's evidence of prior learning, with the competencies each is tied to. */
export async function userEvidenceList(ctx: RequestContext, userId: string) {
  if (!(await canViewUserCompetencies(ctx, userId))) throw new ForbiddenError();
  const [items, manage] = await Promise.all([
    ctx.db.userEvidence.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        competencies: {
          include: { competency: { select: { id: true, shortName: true, idNumber: true } } },
        },
      },
    }),
    userId === ctx.perm.userId
      ? ctx.perm.can('competency:evidencemanageown')
      : ctx.perm.can('competency:planmanage'),
  ]);
  const files = await ctx.db.file.findMany({
    where: {
      contextId: SYSTEM_CONTEXT_ID,
      component: USER_EVIDENCE_COMPONENT,
      area: 'userevidence',
      itemId: { in: items.map((i) => i.id) },
      status: 'READY',
    },
    select: { id: true, name: true, itemId: true, size: true },
  });
  return {
    manage,
    items: items.map((i) => ({ ...i, files: files.filter((f) => f.itemId === i.id) })),
  };
}
