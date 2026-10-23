import { type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, siteLocale } from '../settings/settings.ts';
import { defaultLetters, type LetterBoundary } from './aggregate.ts';

// Scales (named grade lists, worst first) and letter boundaries, each for the site or for
// one course. A grade on a scale is stored as its 1-based position.

type Tx = Prisma.TransactionClient | Db;

const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : typeof d === 'number' ? d : d.toNumber();

/** Scales a course can use: the site's and its own. */
export async function listScales(db: Tx, courseId: string | null) {
  return db.scale.findMany({
    where: { OR: [{ courseId: null }, ...(courseId ? [{ courseId }] : [])] },
    orderBy: [{ courseId: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
    include: { _count: { select: { gradeItems: true } } },
  });
}

/** A scale the course may use, or a validation error. */
export async function requireScaleFor(db: Tx, courseId: string, scaleId: string) {
  const s = await db.scale.findFirst({
    where: { id: scaleId, OR: [{ courseId: null }, { courseId }] },
  });
  if (!s) throw new ValidationError({ scaleId: [msg('errors.grades.unknownScale')] });
  return s;
}

const authorizeScope = (ctx: RequestContext, courseId: string | null | undefined) =>
  courseId ? ctx.perm.require('grade:manage', courseId) : ctx.perm.require('site:config');

export const saveScale = defineOperation({
  name: 'grade.scale.save',
  offline: 'guarded',
  input: z.object({
    id: z.string().uuid().optional(),
    courseId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(255),
    items: z.array(z.string().trim().min(1).max(100)).min(2).max(100),
  }),
  async authorize(ctx, i) {
    if (i.id) {
      const s = await ctx.db.scale.findUnique({ where: { id: i.id } });
      if (!s) throw new NotFoundError('Scale');
      await authorizeScope(ctx, s.courseId);
    } else await authorizeScope(ctx, i.courseId);
  },
  async handler(ctx, input) {
    if (new Set(input.items).size !== input.items.length)
      throw new ValidationError({ items: [msg('errors.common.distinctGrades')] });
    if (input.id) {
      const s = await ctx.tx.scale.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          _count: { select: { gradeItems: true, competencyFrameworks: true, competencies: true } },
        },
      });
      const used = s._count.gradeItems + s._count.competencyFrameworks + s._count.competencies > 0;
      // Stored grades are positions in the list: a scale in use keeps its length.
      if (used && s.items.length !== input.items.length)
        throw new ConflictError(msg('errors.grades.scaleItemsFixed'));
      await ctx.tx.scale.update({
        where: { id: s.id },
        data: { name: input.name, items: input.items },
      });
      return { id: s.id };
    }
    const s = await ctx.tx.scale.create({
      data: { courseId: input.courseId ?? null, name: input.name, items: input.items },
    });
    await logEvent(ctx.tx, {
      name: 'grade.scale.created',
      actorId: ctx.perm.userId,
      courseId: input.courseId ?? null,
      objectType: 'scale',
      objectId: s.id,
      origin: ctx.origin,
    });
    return { id: s.id };
  },
});

export const deleteScale = defineOperation({
  name: 'grade.scale.delete',
  offline: 'guarded',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const s = await ctx.db.scale.findUnique({ where: { id: i.id } });
    if (!s) throw new NotFoundError('Scale');
    await authorizeScope(ctx, s.courseId);
  },
  async handler(ctx, { id }) {
    if (await ctx.tx.gradeItem.count({ where: { scaleId: id } }))
      throw new ConflictError(msg('errors.grades.scaleUsedByItems'));
    if (
      (await ctx.tx.competencyFramework.count({ where: { scaleId: id } })) +
      (await ctx.tx.competency.count({ where: { scaleId: id } }))
    )
      throw new ConflictError(msg('errors.grades.scaleUsedByCompetencies'));
    await ctx.tx.scale.delete({ where: { id } });
    return { id };
  },
});

/** Position (1-based) of a scale grade given by its name or its number, or null. */
export function scaleValue(items: string[], raw: string): number | null {
  const s = raw.trim();
  const byName = items.findIndex((x) => x.toLowerCase() === s.toLowerCase());
  if (byName >= 0) return byName + 1;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? n : null;
}

// ── letters ─────────────────────────────────────────────────────────────────

async function lettersOf(db: Tx, contextId: string): Promise<LetterBoundary[]> {
  const rows = await db.gradeLetter.findMany({
    where: { contextId },
    orderBy: { lowerBound: 'desc' },
  });
  return rows.map((r) => ({ lowerBound: num(r.lowerBound)!, letter: r.letter }));
}

/** Built-in boundaries of the site language's pack. */
export async function builtInLetters(db: Db): Promise<LetterBoundary[]> {
  return defaultLetters(siteLocale(await getAllSettings(db)));
}

/** The site's letters (its own, or the built-in ones). */
export async function siteLetters(db: Db): Promise<LetterBoundary[]> {
  const own = await lettersOf(db, SYSTEM_CONTEXT_ID);
  return own.length ? own : builtInLetters(db);
}

/**
 * Letters for a course: its own, else the site's. They do not depend on who is looking, so
 * everyone sees the same letter for the same grade.
 */
export async function courseLetters(db: Db, courseId: string): Promise<LetterBoundary[]> {
  const own = await lettersOf(db, courseId);
  return own.length ? own : siteLetters(db);
}

/** Whether the course (or, with SYSTEM_CONTEXT_ID, the site) has its own letters. */
export async function hasOwnLetters(db: Tx, contextId: string): Promise<boolean> {
  return (await db.gradeLetter.count({ where: { contextId } })) > 0;
}

export const saveLetters = defineOperation({
  name: 'grade.letters.save',
  offline: 'guarded',
  input: z.object({
    /** A course id, or the system context for the site. */
    contextId: z.string().uuid(),
    /** Empty: use the inherited letters again. */
    letters: z
      .array(
        z.object({
          lowerBound: z.coerce.number().min(0).max(100),
          letter: z.string().trim().min(1).max(20),
        }),
      )
      .max(50),
  }),
  authorize: (ctx, i) =>
    i.contextId === SYSTEM_CONTEXT_ID
      ? ctx.perm.require('site:config')
      : ctx.perm.require('grade:manage', i.contextId),
  async handler(ctx, { contextId, letters }) {
    if (letters.length) {
      if (new Set(letters.map((l) => l.lowerBound)).size !== letters.length)
        throw new ValidationError({ letters: [msg('errors.grades.distinctBoundaries')] });
      if (!letters.some((l) => l.lowerBound === 0))
        throw new ValidationError({ letters: [msg('errors.grades.letterFromZero')] });
    }
    if (
      contextId !== SYSTEM_CONTEXT_ID &&
      !(await ctx.tx.course.findUnique({ where: { id: contextId } }))
    )
      throw new NotFoundError('Course');
    await ctx.tx.gradeLetter.deleteMany({ where: { contextId } });
    if (letters.length)
      await ctx.tx.gradeLetter.createMany({ data: letters.map((l) => ({ ...l, contextId })) });
    await logEvent(ctx.tx, {
      name: 'grade.letters.changed',
      actorId: ctx.perm.userId,
      contextId,
      courseId: contextId === SYSTEM_CONTEXT_ID ? null : contextId,
      origin: ctx.origin,
    });
    return { ok: true };
  },
});
