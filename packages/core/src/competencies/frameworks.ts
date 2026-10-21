import { type Competency, type CompetencyFramework, type Db, Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { MutationContext, RequestContext } from '../context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import { buildFrameworkCsv, type CsvCompetency, parseFrameworkCsv } from './csv.ts';
import {
  checkPointsConfig,
  checkScaleConfig,
  OUTCOMES,
  type PointsConfigT,
  ScaleConfig,
  type ScaleConfigT,
  TAXONOMIES,
} from './model.ts';

// Competency frameworks, as Moodle's: a tree of competencies under a framework rated on a
// site scale, each level named by a taxonomy term; a competency may have a scale of its
// own, a rule by which it follows its children, and cross-references to others of its
// framework. Frameworks move between sites as Moodle's CSV.

type Tx = Prisma.TransactionClient | Db;

const idNumber = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^,]+$/, 'errors.field.noCommas');

async function loadFramework(db: Tx, id: string) {
  const f = await db.competencyFramework.findUnique({ where: { id } });
  if (!f) throw new NotFoundError('Competency framework');
  return f;
}

async function loadCompetency(db: Tx, id: string) {
  const c = await db.competency.findUnique({ where: { id } });
  if (!c) throw new NotFoundError('Competency');
  return c;
}

/** The site scale a framework or competency uses, checked against its configuration. */
async function siteScale(db: Tx, scaleId: string, config: unknown, field: string) {
  const s = await db.scale.findFirst({ where: { id: scaleId, courseId: null } });
  if (!s) throw new ValidationError({ [field]: [msg('errors.competencies.chooseSiteScale')] });
  try {
    return { scale: s, config: checkScaleConfig(config, s.items.length) };
  } catch (e) {
    throw new ValidationError({ scaleConfig: [(e as Error).message] });
  }
}

/** The ids of a competency and everything below it. */
async function subtree(db: Tx, c: Pick<Competency, 'id' | 'path' | 'frameworkId'>) {
  const below = await db.competency.findMany({
    where: { frameworkId: c.frameworkId, path: { startsWith: `${c.path}${c.id}/` } },
    select: { id: true },
  });
  return [c.id, ...below.map((x) => x.id)];
}

/** Whether people's ratings, courses, plans or templates use any of these competencies. */
async function inUse(db: Tx, ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  const where = { competencyId: { in: ids } };
  const counts = await Promise.all([
    db.courseCompetency.count({ where }),
    db.activityCompetency.count({ where }),
    db.userCompetency.count({ where }),
    db.userCompetencyCourse.count({ where }),
    db.userCompetencyPlan.count({ where }),
    db.learningPlanTemplateCompetency.count({ where }),
    db.learningPlanCompetency.count({ where }),
    db.userEvidenceCompetency.count({ where }),
  ]);
  return counts.some(Boolean);
}

/** Whether anyone has been rated on these competencies (their scale is then fixed). */
async function rated(db: Tx, ids: string[]) {
  const where = { competencyId: { in: ids }, grade: { not: null } };
  const n = await Promise.all([
    db.userCompetency.count({ where }),
    db.userCompetencyCourse.count({ where }),
    db.userCompetencyPlan.count({ where }),
  ]);
  return n.some(Boolean);
}

// ── frameworks ───────────────────────────────────────────────────────────────

export const FrameworkInput = z.object({
  id: z.string().uuid().optional(),
  shortName: z.string().trim().min(1).max(255),
  idNumber,
  description: z.string().max(10_000).default(''),
  /** A site scale, or "new" for `newScale`, made with the framework (or an equal one taken). */
  scaleId: z.union([z.string().uuid(), z.literal('new')]),
  newScale: z
    .object({
      name: z.string().trim().min(1).max(255),
      items: z.array(z.string().trim().min(1).max(100)).min(2).max(100),
    })
    .optional(),
  scaleConfig: z.unknown(),
  taxonomies: z.array(z.enum(TAXONOMIES)).min(1).max(10).default(['competency']),
  visible: z.boolean().default(true),
});

/** The scale a framework asked for as "new": a site scale with the same name and grades if
 *  there is one, else made now, in the framework's transaction and under its permission. */
async function frameworkScale(
  ctx: MutationContext,
  scaleId: string,
  spec: z.output<typeof FrameworkInput>['newScale'],
): Promise<string> {
  if (scaleId !== 'new') return scaleId;
  if (!spec) throw new ValidationError({ scaleId: [msg('errors.field.required')] });
  if (new Set(spec.items).size !== spec.items.length)
    throw new ValidationError({ scaleId: [msg('errors.common.distinctGrades')] });
  const same = await ctx.tx.scale.findFirst({
    where: { courseId: null, name: spec.name, items: { equals: spec.items } },
    select: { id: true },
  });
  if (same) return same.id;
  const s = await ctx.tx.scale.create({ data: { courseId: null, ...spec } });
  await logEvent(ctx.tx, {
    name: 'grade.scale.created',
    actorId: ctx.perm.userId,
    objectType: 'scale',
    objectId: s.id,
    origin: ctx.origin,
  });
  return s.id;
}

export const saveFramework = defineOperation({
  name: 'competency.framework.save',
  offline: 'online',
  input: FrameworkInput,
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, input) {
    const clash = await ctx.tx.competencyFramework.findUnique({
      where: { idNumber: input.idNumber },
    });
    if (clash && clash.id !== input.id)
      throw new ValidationError({ idNumber: [msg('errors.competencies.frameworkIdNumberInUse')] });
    const scaleId = await frameworkScale(ctx, input.scaleId, input.newScale);
    const { config } = await siteScale(ctx.tx, scaleId, input.scaleConfig, 'scaleId');
    const data = {
      shortName: input.shortName,
      idNumber: input.idNumber,
      description: input.description,
      scaleId,
      scaleConfig: config as unknown as Prisma.InputJsonValue,
      taxonomies: input.taxonomies,
      visible: input.visible,
    };
    if (input.id) {
      const old = await loadFramework(ctx.tx, input.id);
      if (old.scaleId !== scaleId) {
        const ids = (
          await ctx.tx.competency.findMany({
            where: { frameworkId: old.id, scaleId: null },
            select: { id: true },
          })
        ).map((c) => c.id);
        if (await rated(ctx.tx, ids))
          throw new ValidationError({ scaleId: [msg('errors.competencies.scaleRated')] });
      }
      await ctx.tx.competencyFramework.update({ where: { id: old.id }, data });
      return { id: old.id };
    }
    const f = await ctx.tx.competencyFramework.create({
      data: { ...data, createdById: ctx.perm.userId },
    });
    await logEvent(ctx.tx, {
      name: 'competency.framework.created',
      actorId: ctx.perm.userId,
      objectType: 'competencyFramework',
      objectId: f.id,
      origin: ctx.origin,
    });
    return { id: f.id };
  },
});

export const deleteFramework = defineOperation({
  name: 'competency.framework.delete',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id }) {
    await loadFramework(ctx.tx, id);
    const ids = (
      await ctx.tx.competency.findMany({ where: { frameworkId: id }, select: { id: true } })
    ).map((c) => c.id);
    if (await inUse(ctx.tx, ids))
      throw new ConflictError(msg('errors.competencies.frameworkInUse'));
    // children first: the tree holds on to its parents
    await ctx.tx.competency.updateMany({ where: { frameworkId: id }, data: { parentId: null } });
    await ctx.tx.competencyFramework.delete({ where: { id } });
    return { id };
  },
});

/** A copy of a framework with all its competencies, rules and cross-references. */
export const duplicateFramework = defineOperation({
  name: 'competency.framework.duplicate',
  offline: 'online',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id }) {
    const f = await loadFramework(ctx.tx, id);
    let n = 1;
    let copyId = `${f.idNumber}_${n}`;
    while (await ctx.tx.competencyFramework.findUnique({ where: { idNumber: copyId } }))
      copyId = `${f.idNumber}_${++n}`;
    const copy = await ctx.tx.competencyFramework.create({
      data: {
        shortName: `${f.shortName} (${n})`,
        idNumber: copyId,
        description: f.description,
        scaleId: f.scaleId,
        scaleConfig: f.scaleConfig as Prisma.InputJsonValue,
        taxonomies: f.taxonomies,
        visible: f.visible,
        createdById: ctx.perm.userId,
      },
    });
    const all = await ctx.tx.competency.findMany({
      where: { frameworkId: id },
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });
    const map = new Map<string, string>();
    const pathOf = new Map<string, string>();
    for (const c of sortTree(all)) {
      const parentId = c.parentId ? map.get(c.parentId)! : null;
      const path = parentId ? `${pathOf.get(parentId)}${parentId}/` : '/';
      const nc = await ctx.tx.competency.create({
        data: {
          frameworkId: copy.id,
          parentId,
          path,
          sortOrder: c.sortOrder,
          shortName: c.shortName,
          idNumber: c.idNumber,
          description: c.description,
          scaleId: c.scaleId,
          scaleConfig: (c.scaleConfig ?? undefined) as Prisma.InputJsonValue | undefined,
          ruleType: c.ruleType,
          ruleOutcome: c.ruleOutcome,
        },
      });
      map.set(c.id, nc.id);
      pathOf.set(nc.id, path);
    }
    for (const c of all)
      if (c.ruleConfig) {
        const cfg = c.ruleConfig as PointsConfigT;
        await ctx.tx.competency.update({
          where: { id: map.get(c.id)! },
          data: {
            ruleConfig: {
              ...cfg,
              children: cfg.children.map((x) => ({ ...x, id: map.get(x.id) ?? x.id })),
            },
          },
        });
      }
    const related = await ctx.tx.relatedCompetency.findMany({
      where: { competencyId: { in: all.map((c) => c.id) } },
    });
    if (related.length)
      await ctx.tx.relatedCompetency.createMany({
        data: related.map((r) => ({
          competencyId: map.get(r.competencyId)!,
          relatedId: map.get(r.relatedId)!,
        })),
        skipDuplicates: true,
      });
    return { id: copy.id };
  },
});

/** Parents before children, siblings in their order. */
export function sortTree<T extends { id: string; parentId: string | null; sortOrder: number }>(
  all: T[],
): T[] {
  const kids = new Map<string | null, T[]>();
  for (const c of all) {
    const k = c.parentId && all.some((x) => x.id === c.parentId) ? c.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  const out: T[] = [];
  const walk = (parent: string | null) => {
    for (const c of (kids.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(null);
  return out;
}

// ── competencies ─────────────────────────────────────────────────────────────

export const CompetencyInput = z.object({
  id: z.string().uuid().optional(),
  frameworkId: z.string().uuid().optional(),
  parentId: z.string().uuid().nullable().optional(),
  shortName: z.string().trim().min(1).max(255),
  idNumber,
  description: z.string().max(10_000).default(''),
  /** A scale of its own; null: the framework's. */
  scaleId: z.string().uuid().nullable().default(null),
  scaleConfig: z.unknown().optional(),
});

export const saveCompetency = defineOperation({
  name: 'competency.save',
  offline: 'guarded',
  input: CompetencyInput,
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, input) {
    const old = input.id ? await loadCompetency(ctx.tx, input.id) : null;
    const frameworkId = old?.frameworkId ?? input.frameworkId;
    if (!frameworkId) throw new ValidationError({ frameworkId: [msg('errors.field.required')] });
    await loadFramework(ctx.tx, frameworkId);
    const clash = await ctx.tx.competency.findUnique({
      where: { frameworkId_idNumber: { frameworkId, idNumber: input.idNumber } },
    });
    if (clash && clash.id !== old?.id)
      throw new ValidationError({
        idNumber: [msg('errors.competencies.competencyIdNumberInUse')],
      });
    let scaleConfig: ScaleConfigT | null = null;
    if (input.scaleId)
      scaleConfig = (await siteScale(ctx.tx, input.scaleId, input.scaleConfig, 'scaleId')).config;
    if (old && old.scaleId !== input.scaleId && (await rated(ctx.tx, [old.id])))
      throw new ValidationError({ scaleId: [msg('errors.competencies.scaleRated')] });
    const data = {
      shortName: input.shortName,
      idNumber: input.idNumber,
      description: input.description,
      scaleId: input.scaleId,
      scaleConfig: scaleConfig ? (scaleConfig as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    };
    if (old) {
      await ctx.tx.competency.update({ where: { id: old.id }, data });
      return { id: old.id };
    }
    const parent = input.parentId ? await loadCompetency(ctx.tx, input.parentId) : null;
    if (parent && parent.frameworkId !== frameworkId)
      throw new ValidationError({ parentId: [msg('errors.competencies.parentElsewhere')] });
    const last = await ctx.tx.competency.aggregate({
      where: { frameworkId, parentId: parent?.id ?? null },
      _max: { sortOrder: true },
    });
    const c = await ctx.tx.competency.create({
      data: {
        ...data,
        frameworkId,
        parentId: parent?.id ?? null,
        path: parent ? `${parent.path}${parent.id}/` : '/',
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    return { id: c.id };
  },
});

/** Moves a competency (with what is below it) under another parent, or to the top. */
export const moveCompetency = defineOperation({
  name: 'competency.move',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id, parentId }) {
    const c = await loadCompetency(ctx.tx, id);
    const parent = parentId ? await loadCompetency(ctx.tx, parentId) : null;
    if (parent && parent.frameworkId !== c.frameworkId)
      throw new ValidationError({ parentId: [msg('errors.competencies.parentElsewhere')] });
    // the form offers the current parent first: moving there changes nothing, and above all
    // keeps the competency in its parent's rule
    if ((parent?.id ?? null) === c.parentId) return { id };
    const below = await subtree(ctx.tx, c);
    if (parent && below.includes(parent.id))
      throw new ValidationError({ parentId: [msg('errors.competencies.underItself')] });
    const oldPrefix = `${c.path}${c.id}/`;
    const path = parent ? `${parent.path}${parent.id}/` : '/';
    const last = await ctx.tx.competency.aggregate({
      where: { frameworkId: c.frameworkId, parentId: parent?.id ?? null },
      _max: { sortOrder: true },
    });
    await ctx.tx.competency.update({
      where: { id },
      data: { parentId: parent?.id ?? null, path, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
    const newPrefix = `${path}${c.id}/`;
    await ctx.tx.$executeRaw`
      UPDATE "Competency" SET path = ${newPrefix} || substr(path, ${oldPrefix.length + 1})
      WHERE "frameworkId" = ${c.frameworkId}::uuid AND path LIKE ${`${oldPrefix}%`}`;
    // the old parent's rule no longer counts it
    if (c.parentId) await dropFromRule(ctx.tx, c.parentId, [id]);
    return { id };
  },
});

/** Moves a competency one place among its siblings. */
export const reorderCompetency = defineOperation({
  name: 'competency.reorder',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id, direction }) {
    const c = await loadCompetency(ctx.tx, id);
    const siblings = await ctx.tx.competency.findMany({
      where: { frameworkId: c.frameworkId, parentId: c.parentId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return { id };
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    for (const [n, s] of siblings.entries())
      await ctx.tx.competency.update({ where: { id: s.id }, data: { sortOrder: n } });
    return { id };
  },
});

async function dropFromRule(tx: Tx, parentId: string, ids: string[]) {
  const p = await tx.competency.findUnique({ where: { id: parentId } });
  if (p?.ruleType !== 'POINTS' || !p.ruleConfig) return;
  const cfg = p.ruleConfig as PointsConfigT;
  const children = cfg.children.filter((x) => !ids.includes(x.id));
  const total = children.reduce((n, x) => n + x.points, 0);
  // a rule that can no longer be met is switched off
  await tx.competency.update({
    where: { id: p.id },
    data:
      children.length && total >= cfg.points
        ? { ruleConfig: { ...cfg, children } }
        : { ruleType: null, ruleOutcome: 'NONE', ruleConfig: Prisma.DbNull },
  });
}

export const deleteCompetency = defineOperation({
  name: 'competency.delete',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id }) {
    const c = await loadCompetency(ctx.tx, id);
    const ids = await subtree(ctx.tx, c);
    if (await inUse(ctx.tx, ids))
      throw new ConflictError(msg('errors.competencies.competencyInUse'));
    await ctx.tx.competency.updateMany({ where: { id: { in: ids } }, data: { parentId: null } });
    await ctx.tx.competency.deleteMany({ where: { id: { in: ids } } });
    if (c.parentId) await dropFromRule(ctx.tx, c.parentId, [id]);
    return { id };
  },
});

export const RuleInput = z.object({
  id: z.string().uuid(),
  ruleType: z.enum(['ALL', 'POINTS']).nullable(),
  ruleOutcome: z.enum(OUTCOMES).default('NONE'),
  ruleConfig: z.unknown().optional(),
});

/** How a competency follows its children: a rule and what it does when met. */
export const setCompetencyRule = defineOperation({
  name: 'competency.rule',
  offline: 'guarded',
  input: RuleInput,
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, input) {
    const c = await loadCompetency(ctx.tx, input.id);
    const children = (
      await ctx.tx.competency.findMany({ where: { parentId: c.id }, select: { id: true } })
    ).map((x) => x.id);
    if (input.ruleType && !children.length)
      throw new ValidationError({ ruleType: [msg('errors.competencies.ruleNeedsChildren')] });
    let config: PointsConfigT | null = null;
    if (input.ruleType === 'POINTS')
      try {
        config = checkPointsConfig(input.ruleConfig, children);
      } catch (e) {
        throw new ValidationError({ ruleConfig: [(e as Error).message] });
      }
    await ctx.tx.competency.update({
      where: { id: c.id },
      data: {
        ruleType: input.ruleType,
        ruleOutcome: input.ruleType ? input.ruleOutcome : 'NONE',
        ruleConfig: config ? (config as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    return { id: c.id };
  },
});

/** Cross-references a competency with another of its framework, or removes the reference. */
export const setRelatedCompetency = defineOperation({
  name: 'competency.related',
  offline: 'guarded',
  input: z.object({
    id: z.string().uuid(),
    relatedId: z.string().uuid(),
    related: z.boolean(),
  }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { id, relatedId, related }) {
    const [a, b] = await Promise.all([
      loadCompetency(ctx.tx, id),
      loadCompetency(ctx.tx, relatedId),
    ]);
    if (a.id === b.id || a.frameworkId !== b.frameworkId)
      throw new ValidationError({ relatedId: [msg('errors.competencies.chooseOtherCompetency')] });
    const pairs = [
      { competencyId: a.id, relatedId: b.id },
      { competencyId: b.id, relatedId: a.id },
    ];
    if (related) await ctx.tx.relatedCompetency.createMany({ data: pairs, skipDuplicates: true });
    else
      await ctx.tx.relatedCompetency.deleteMany({
        where: { OR: pairs },
      });
    return { id };
  },
});

// ── reading ──────────────────────────────────────────────────────────────────

export async function listFrameworks(ctx: RequestContext, opts: { all?: boolean } = {}) {
  await ctx.perm.require('competency:view');
  const manage = await ctx.perm.can('competency:manage');
  return ctx.db.competencyFramework.findMany({
    where: manage && opts.all !== false ? {} : { visible: true },
    orderBy: { shortName: 'asc' },
    include: {
      scale: { select: { name: true, items: true } },
      _count: { select: { competencies: true } },
    },
  });
}

export type CompetencyNode = Competency & {
  depth: number;
  children: string[];
  related: string[];
};

/** A framework with its competencies in tree order. */
export async function frameworkTree(db: Tx, id: string) {
  const framework = await db.competencyFramework.findUnique({
    where: { id },
    include: { scale: true },
  });
  if (!framework) throw new NotFoundError('Competency framework');
  const [all, related] = await Promise.all([
    db.competency.findMany({ where: { frameworkId: id } }),
    db.relatedCompetency.findMany({ where: { competency: { frameworkId: id } } }),
  ]);
  const nodes: CompetencyNode[] = sortTree(all).map((c) => ({
    ...c,
    depth: c.path.split('/').filter(Boolean).length,
    children: all
      .filter((x) => x.parentId === c.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((x) => x.id),
    related: related.filter((r) => r.competencyId === c.id).map((r) => r.relatedId),
  }));
  return { framework, competencies: nodes };
}

/** The scale a competency is rated on, with its configuration. */
export async function competencyScale(
  db: Tx,
  c: Pick<Competency, 'scaleId' | 'scaleConfig' | 'frameworkId'>,
): Promise<{ id: string; items: string[]; config: ScaleConfigT }> {
  if (c.scaleId && c.scaleConfig) {
    const s = await db.scale.findUniqueOrThrow({ where: { id: c.scaleId } });
    return { id: s.id, items: s.items, config: ScaleConfig.parse(c.scaleConfig) };
  }
  const f = await db.competencyFramework.findUniqueOrThrow({
    where: { id: c.frameworkId },
    include: { scale: true },
  });
  return { id: f.scaleId, items: f.scale.items, config: ScaleConfig.parse(f.scaleConfig) };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export async function exportFrameworkCsv(ctx: RequestContext, id: string): Promise<string> {
  await ctx.perm.require('competency:manage');
  const { framework: f, competencies } = await frameworkTree(ctx.db, id);
  const byId = new Map(competencies.map((c) => [c.id, c]));
  const scales = new Map(
    (
      await ctx.db.scale.findMany({
        where: { id: { in: competencies.flatMap((c) => (c.scaleId ? [c.scaleId] : [])) } },
      })
    ).map((s) => [s.id, s]),
  );
  return buildFrameworkCsv(
    {
      idNumber: f.idNumber,
      shortName: f.shortName,
      description: f.description,
      scaleId: f.scaleId,
      scaleItems: f.scale.items,
      scaleConfig: ScaleConfig.parse(f.scaleConfig),
      taxonomies: f.taxonomies,
    },
    competencies.map((c) => ({
      parentIdNumber: c.parentId ? (byId.get(c.parentId)?.idNumber ?? null) : null,
      idNumber: c.idNumber,
      shortName: c.shortName,
      description: c.description,
      scaleId: c.scaleId,
      scaleItems: c.scaleId ? (scales.get(c.scaleId)?.items ?? null) : null,
      scaleConfig: c.scaleConfig ? ScaleConfig.parse(c.scaleConfig) : null,
      ruleType: c.ruleType,
      ruleOutcome: c.ruleOutcome,
      ruleConfig: (c.ruleConfig as PointsConfigT | null) ?? null,
      related: c.related.map((r) => byId.get(r)?.idNumber).filter((x): x is string => !!x),
      exportId: c.id,
    })),
  );
}

/** A site scale with exactly these values, or a new one named after the framework. */
async function scaleFor(tx: Tx, items: string[], name: string) {
  const site = await tx.scale.findMany({ where: { courseId: null } });
  const same = site.find(
    (s) => s.items.length === items.length && s.items.every((v, i) => v === items[i]),
  );
  return same ?? (await tx.scale.create({ data: { name, items } }));
}

/** Creates a framework from a Moodle competency framework CSV. */
export const importFrameworkCsv = defineOperation({
  name: 'competency.framework.import',
  offline: 'online',
  input: z.object({ csv: z.string().min(1).max(10_000_000) }),
  authorize: (ctx) => ctx.perm.require('competency:manage'),
  async handler(ctx, { csv }) {
    let parsed: ReturnType<typeof parseFrameworkCsv>;
    try {
      parsed = parseFrameworkCsv(csv);
    } catch (e) {
      throw new ValidationError({ csv: [(e as Error).message] }, (e as Error).message);
    }
    const { framework: fw, competencies } = parsed;
    if (await ctx.tx.competencyFramework.findUnique({ where: { idNumber: fw.idNumber } })) {
      const m = `A framework with the ID number ${fw.idNumber} exists already`;
      throw new ValidationError({ csv: [m] }, m);
    }
    const scale = await scaleFor(ctx.tx, fw.scaleItems, fw.shortName);
    let config: ScaleConfigT;
    try {
      config = checkScaleConfig(fw.scaleConfig, scale.items.length);
    } catch (e) {
      throw new ValidationError({ csv: [(e as Error).message] }, (e as Error).message);
    }
    const f = await ctx.tx.competencyFramework.create({
      data: {
        shortName: fw.shortName.slice(0, 255),
        idNumber: fw.idNumber.slice(0, 100),
        description: fw.description,
        scaleId: scale.id,
        scaleConfig: config as unknown as Prisma.InputJsonValue,
        taxonomies: fw.taxonomies.length ? fw.taxonomies : ['competency'],
        createdById: ctx.perm.userId,
      },
    });
    // parents first
    const byIdNumber = new Map<string, { id: string; path: string }>();
    const exported = new Map<string, string>();
    const order: CsvCompetency[] = [];
    const pending = [...competencies];
    while (pending.length) {
      const i = pending.findIndex(
        (c) => !c.parentIdNumber || order.some((o) => o.idNumber === c.parentIdNumber),
      );
      if (i < 0) {
        const m = 'The competencies of the file loop through their parents';
        throw new ValidationError({ csv: [m] }, m);
      }
      order.push(...pending.splice(i, 1));
    }
    const sortOrders = new Map<string, number>();
    for (const c of order) {
      const parent = c.parentIdNumber ? byIdNumber.get(c.parentIdNumber)! : null;
      const key = parent?.id ?? '';
      const sortOrder = sortOrders.get(key) ?? 0;
      sortOrders.set(key, sortOrder + 1);
      let own: { scaleId: string; config: ScaleConfigT } | null = null;
      if (c.scaleItems && c.scaleConfig) {
        const s = await scaleFor(ctx.tx, c.scaleItems, `${fw.shortName}: ${c.shortName}`);
        try {
          own = { scaleId: s.id, config: checkScaleConfig(c.scaleConfig, s.items.length) };
        } catch {
          own = null;
        }
      }
      const path = parent ? `${parent.path}${parent.id}/` : '/';
      const nc = await ctx.tx.competency.create({
        data: {
          frameworkId: f.id,
          parentId: parent?.id ?? null,
          path,
          sortOrder,
          shortName: c.shortName.slice(0, 255),
          idNumber: c.idNumber.slice(0, 100),
          description: c.description,
          scaleId: own?.scaleId ?? null,
          scaleConfig: (own?.config ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      byIdNumber.set(c.idNumber, { id: nc.id, path });
      if (c.exportId) exported.set(c.exportId, nc.id);
    }
    // rules and cross-references, now that every competency has its id
    for (const c of order) {
      const id = byIdNumber.get(c.idNumber)!.id;
      if (c.ruleType) {
        const children = order
          .filter((x) => x.parentIdNumber === c.idNumber)
          .map((x) => byIdNumber.get(x.idNumber)!.id);
        let config: PointsConfigT | null = null;
        if (c.ruleType === 'POINTS' && c.ruleConfig)
          try {
            config = checkPointsConfig(
              {
                ...c.ruleConfig,
                children: c.ruleConfig.children.map((x) => ({
                  ...x,
                  id: exported.get(x.id) ?? byIdNumber.get(x.id)?.id ?? x.id,
                })),
              },
              children,
            );
          } catch {
            config = null;
          }
        if (children.length && (c.ruleType === 'ALL' || config))
          await ctx.tx.competency.update({
            where: { id },
            data: {
              ruleType: c.ruleType,
              ruleOutcome: c.ruleOutcome,
              ruleConfig: (config ?? undefined) as Prisma.InputJsonValue | undefined,
            },
          });
      }
      const related = c.related
        .map((r) => byIdNumber.get(r)?.id)
        .filter((r): r is string => !!r && r !== id);
      if (related.length)
        await ctx.tx.relatedCompetency.createMany({
          data: related.flatMap((r) => [
            { competencyId: id, relatedId: r },
            { competencyId: r, relatedId: id },
          ]),
          skipDuplicates: true,
        });
    }
    await logEvent(ctx.tx, {
      name: 'competency.framework.imported',
      actorId: ctx.perm.userId,
      objectType: 'competencyFramework',
      objectId: f.id,
      data: { competencies: order.length },
      origin: ctx.origin,
    });
    return { id: f.id, competencies: order.length };
  },
});

export type { CompetencyFramework };
