import type { Db, Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { msg, renderMsg } from '@hubium/module-sdk';
import {
  checkQuestionText,
  checkVariants,
  Dataset,
  Hint,
  type Problem,
  parseGift,
  type QuestionType,
  questionDataFrom,
  questionDataSchemas,
  questionTypes,
} from '@hubium/questions';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ConflictError, type MsgOrText, NotFoundError, ValidationError } from '../errors.ts';
import { issueMsg } from '../issue-messages.ts';
import { optionalText } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { isCalculated, saveSharedDatasets, sharedDatasets } from './datasets.ts';

/** A question's problem (see @hubium/questions) as a message for people. */
export const problemMsg = (p: Problem) => msg(p.key, p.values);

type Tx = Prisma.TransactionClient | Db;

/** Default category of a course's question bank, created on demand. */
export async function ensureDefaultQuestionCategory(tx: Tx, courseId: string) {
  const existing = await tx.questionCategory.findFirst({
    where: { contextId: courseId, parentId: null },
    orderBy: { createdAt: 'asc' },
  });
  return existing ?? tx.questionCategory.create({ data: { contextId: courseId, name: '' } });
}

async function categoryCourse(db: Tx, categoryId: string): Promise<string> {
  const c = await db.questionCategory.findUnique({
    where: { id: categoryId },
    select: { contextId: true },
  });
  if (!c) throw new NotFoundError('Question category');
  return c.contextId;
}

/** Categories each followed by their subcategories, with how deep each one sits. */
function inTreeOrder<T extends { id: string; parentId: string | null }>(
  cats: T[],
): (T & { depth: number })[] {
  const ids = new Set(cats.map((c) => c.id));
  const children = new Map<string | null, T[]>();
  for (const c of cats) {
    // one whose parent is missing is shown at the top rather than lost
    const parent = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const out: (T & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of children.get(parent) ?? []) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The course's question categories as a tree; the default one comes first. */
export async function listQuestionCategories(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('question:use', courseId);
  await ensureDefaultQuestionCategory(ctx.db, courseId);
  const cats = await ctx.db.questionCategory.findMany({
    where: { contextId: courseId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    // hidden ones too: the bank lists them, and a category with them cannot go
    include: { _count: { select: { questions: true } } },
  });
  // the default category is the oldest top one (see ensureDefaultQuestionCategory)
  const root = cats
    .filter((c) => !c.parentId)
    .reduce<(typeof cats)[number] | undefined>(
      (a, c) => (!a || c.createdAt < a.createdAt ? c : a),
      undefined,
    );
  return inTreeOrder(root ? [root, ...cats.filter((c) => c !== root)] : cats);
}

/** Throws unless the category exists and belongs to `courseId`. */
async function requireCategoryIn(db: Tx, categoryId: string, courseId: string) {
  if ((await categoryCourse(db, categoryId)) !== courseId)
    throw new ValidationError({ categoryId: [msg('errors.common.unknownCategory')] });
}

export const saveQuestionCategory = defineOperation({
  name: 'question.category.save',
  input: z.object({
    courseId: z.string().uuid(),
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    parentId: z
      .string()
      .uuid()
      .optional()
      .or(z.literal('').transform(() => undefined)),
  }),
  authorize: (ctx, i) => ctx.perm.require('question:manage', i.courseId),
  async handler(ctx, input) {
    if (input.parentId) await requireCategoryIn(ctx.tx, input.parentId, input.courseId);
    const parent =
      input.parentId ?? (await ensureDefaultQuestionCategory(ctx.tx, input.courseId)).id;
    if (input.id) {
      // Only categories of the course the permission was checked for.
      const r = await ctx.tx.questionCategory.updateMany({
        where: { id: input.id, contextId: input.courseId },
        data: { name: input.name },
      });
      if (!r.count) throw new NotFoundError('Question category');
      return { id: input.id };
    }
    const c = await ctx.tx.questionCategory.create({
      data: { contextId: input.courseId, name: input.name, parentId: parent },
    });
    return { id: c.id };
  },
});

export const deleteQuestionCategory = defineOperation({
  name: 'question.category.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    await ctx.perm.require('question:manage', await categoryCourse(ctx.db, i.id));
  },
  async handler(ctx, { id }) {
    const c = await ctx.tx.questionCategory.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { questions: true, children: true } } },
    });
    if (!c.parentId) throw new ValidationError({ id: [msg('errors.questions.defaultCategory')] });
    if (c._count.questions || c._count.children)
      throw new ConflictError(msg('errors.courses.categoryNotEmpty'));
    await ctx.tx.questionCategory.delete({ where: { id } });
    return { id };
  },
});

export const QuestionInput = z.object({
  categoryId: z.string().uuid(),
  type: z.enum(questionTypes as [QuestionType, ...QuestionType[]]),
  name: z.string().trim().min(1).max(255),
  text: z.string().max(100_000),
  generalFeedback: z.string().max(50_000).default(''),
  defaultMark: z.coerce.number().min(0).max(1000).default(1),
  data: z.unknown(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  status: z.enum(['DRAFT', 'READY', 'HIDDEN']).default('READY'),
  idNumber: optionalText(100),
  /** Share of the mark lost per wrong try in interactive quizzes; new questions get ⅓. */
  penalty: z.coerce.number().min(0).max(1).optional(),
  /** Shown after wrong tries in interactive quizzes, one per try. */
  // not Hints: its default would replace the hints of an edit that leaves them out
  hints: z.array(Hint).max(10).optional(),
  /** Calculated questions: datasets their category shares, created or changed with it. */
  sharedDatasets: z.array(Dataset).max(30).optional(),
});

const blankHtml = (html: string) =>
  !/<(img|video|iframe)\b/i.test(html) && !html.replace(/<[^>]*>|&nbsp;/g, '').trim();

function validateData(type: QuestionType, data: unknown) {
  const r = questionDataSchemas[type].safeParse(data);
  if (!r.success) {
    const fieldErrors: Record<string, MsgOrText[]> = {};
    for (const i of r.error.issues)
      (fieldErrors[`data.${i.path.join('.')}`.replace(/\.$/, '')] ??= []).push(issueMsg(i));
    throw new ValidationError(fieldErrors);
  }
  return r.data;
}

export const saveQuestion = defineOperation({
  name: 'question.save',
  input: QuestionInput.extend({ id: z.string().uuid().optional() }),
  async authorize(ctx, i) {
    const courseId = await categoryCourse(ctx.db, i.categoryId);
    await ctx.perm.require('question:manage', courseId);
    if (i.id) {
      // Editing: the question must already live in the same course's bank.
      const q = await ctx.db.question.findUnique({
        where: { id: i.id },
        select: { categoryId: true },
      });
      if (!q || (await categoryCourse(ctx.db, q.categoryId)) !== courseId)
        throw new NotFoundError('Question');
    }
  },
  async handler(ctx, input) {
    const text = sanitizeRichText(input.text);
    if (!text.trim() && input.type !== 'DESCRIPTION') {
      throw new ValidationError({ text: [msg('errors.questions.textRequired')] });
    }
    // A Cloze text holds its answers: they are read from it. Gaps in the text must match
    // the choices of the gap types.
    const derived = questionDataFrom(input.type, text, input.data);
    const fromText = derived !== input.data;
    const early = fromText ? checkQuestionText(input.type, text, derived) : null;
    if (early) throw new ValidationError({ text: [problemMsg(early)] });
    const data = validateData(input.type, derived) as Prisma.InputJsonValue;
    const textError = fromText ? null : checkQuestionText(input.type, text, data);
    if (textError) throw new ValidationError({ text: [problemMsg(textError)] });
    if (isCalculated(input.type)) {
      // the shared datasets it names change with it; every variant must give numbers
      const names = new Set((data as { shared?: string[] }).shared ?? []);
      if (input.sharedDatasets?.length)
        await saveSharedDatasets(
          ctx.tx,
          input.categoryId,
          input.sharedDatasets.filter((d) => names.has(d.name)),
        );
      const problem = checkVariants(
        input.type as 'CALCULATED',
        text,
        data as never,
        await sharedDatasets(
          ctx.tx,
          input.categoryId,
          await categoryCourse(ctx.tx, input.categoryId),
        ),
      );
      if (problem) throw new ValidationError({ data: [problemMsg(problem)] });
    }
    const values = {
      categoryId: input.categoryId,
      type: input.type,
      name: input.name,
      text,
      generalFeedback: sanitizeRichText(input.generalFeedback),
      defaultMark: input.type === 'DESCRIPTION' ? 0 : input.defaultMark,
      data,
      tags: input.tags,
      status: input.status,
      idNumber: input.idNumber ?? null,
      // left as they are when not given (an edit through the API without them)
      ...(input.penalty !== undefined ? { penalty: input.penalty } : {}),
      ...(input.hints !== undefined
        ? {
            // a hint with no text and nothing to do is dropped (as Moodle): it would only
            // add a try
            hints: input.hints
              .map((h) => ({ ...h, text: sanitizeRichText(h.text) }))
              .filter(
                (h) => !blankHtml(h.text) || h.clearWrong || h.showNumCorrect,
              ) as Prisma.InputJsonValue,
          }
        : {}),
    };
    if (input.id) {
      // Attempts keep their own snapshots, so editing never changes past results.
      const q = await ctx.tx.question.update({
        where: { id: input.id },
        data: { ...values, version: { increment: 1 } },
      });
      return { id: q.id };
    }
    const q = await ctx.tx.question.create({
      data: { ...values, createdById: ctx.perm.userId },
    });
    return { id: q.id };
  },
});

export const deleteQuestion = defineOperation({
  name: 'question.delete',
  input: z.object({ id: z.string().uuid() }),
  async authorize(ctx, i) {
    const q = await ctx.db.question.findUnique({
      where: { id: i.id },
      select: { categoryId: true },
    });
    if (!q) throw new NotFoundError('Question');
    await ctx.perm.require('question:manage', await categoryCourse(ctx.db, q.categoryId));
  },
  async handler(ctx, { id }) {
    const used = await ctx.tx.question.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { slots: true, attempts: true } } },
    });
    if (used._count.slots || used._count.attempts) {
      // In use: hide instead of deleting so attempts keep their reference.
      await ctx.tx.question.update({ where: { id }, data: { status: 'HIDDEN' } });
      return { id, hidden: true };
    }
    await ctx.tx.question.delete({ where: { id } });
    return { id, hidden: false };
  },
});

/** One page of a course's questions, the most recently changed first. */
export async function listQuestions(
  ctx: RequestContext,
  courseId: string,
  opts: {
    categoryId?: string;
    q?: string;
    type?: QuestionType;
    includeHidden?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
) {
  await ctx.perm.require('question:use', courseId);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const where: Prisma.QuestionWhereInput = {
    category: { contextId: courseId },
    ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.includeHidden ? {} : { status: { not: 'HIDDEN' } }),
    ...(opts.q
      ? {
          OR: [
            { name: { contains: opts.q, mode: 'insensitive' } },
            { text: { contains: opts.q, mode: 'insensitive' } },
            { tags: { has: opts.q } },
          ],
        }
      : {}),
  };
  const [total, items] = await Promise.all([
    ctx.db.question.count({ where }),
    ctx.db.question.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { items, total, page, pageSize };
}

/**
 * Every question of a category and of the categories below it (of the whole bank without
 * one) that is not hidden, category by category, for an export; with the category path
 * of each question.
 */
export async function questionsForExport(
  ctx: RequestContext,
  courseId: string,
  categoryId?: string,
) {
  await ctx.perm.require('question:manage', courseId);
  const cats = await listQuestionCategories(ctx, courseId);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const pathOf = (id: string): string[] => {
    const c = byId.get(id);
    return c ? [...(c.parentId ? pathOf(c.parentId) : []), c.name] : [];
  };
  const within = (id: string): boolean =>
    !categoryId ||
    id === categoryId ||
    (!!byId.get(id)?.parentId && within(byId.get(id)!.parentId!));
  const chosen = cats.filter((c) => within(c.id));
  const questions = await ctx.db.question.findMany({
    where: { categoryId: { in: chosen.map((c) => c.id) }, status: { not: 'HIDDEN' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const rank = new Map(chosen.map((c, i) => [c.id, i]));
  return questions
    .sort((a, b) => rank.get(a.categoryId)! - rank.get(b.categoryId)!)
    .map((q) => ({ ...q, categoryPath: pathOf(q.categoryId) }));
}

export const importGift = defineOperation({
  name: 'question.importGift',
  input: z.object({
    courseId: z.string().uuid(),
    categoryId: z.string().uuid().optional(),
    gift: z.string().min(1).max(5_000_000),
  }),
  authorize: (ctx, i) => ctx.perm.require('question:manage', i.courseId),
  async handler(ctx, { courseId, categoryId, gift }) {
    if (categoryId) await requireCategoryIn(ctx.tx, categoryId, courseId);
    const parsed = parseGift(gift);
    const root = await ensureDefaultQuestionCategory(ctx.tx, courseId);
    const target = categoryId ?? root.id;
    const byName = new Map<string, string>();
    let created = 0;
    const errors = parsed.errors.map((e) => ({
      block: e.block,
      message: problemMsg(e.problem).in(ctx.locale),
    }));
    for (const q of parsed.questions) {
      let cat = target;
      if (q.category && !categoryId) {
        const leaf = q.category.split('/').filter(Boolean).at(-1) ?? q.category;
        if (!byName.has(leaf)) {
          const found = await ctx.tx.questionCategory.findFirst({
            where: { contextId: courseId, name: leaf },
          });
          byName.set(
            leaf,
            found?.id ??
              (
                await ctx.tx.questionCategory.create({
                  data: { contextId: courseId, name: leaf, parentId: root.id },
                })
              ).id,
          );
        }
        cat = byName.get(leaf)!;
      }
      const data = questionDataSchemas[q.type].safeParse(q.data);
      if (!data.success) {
        const issue = data.error.issues[0];
        errors.push({
          block: 0,
          message: msg('errors.questions.named', {
            name: q.name,
            problem: issue ? renderMsg(issueMsg(issue), ctx.locale) : '',
          }).in(ctx.locale),
        });
        continue;
      }
      await ctx.tx.question.create({
        data: {
          categoryId: cat,
          type: q.type,
          name: q.name.slice(0, 255) || 'Question',
          text: sanitizeRichText(q.text.replace(/\n/g, '<br>')),
          generalFeedback: sanitizeRichText(q.generalFeedback),
          defaultMark: q.type === 'DESCRIPTION' ? 0 : 1,
          data: data.data as Prisma.InputJsonValue,
          source: 'IMPORT',
          createdById: ctx.perm.userId,
        },
      });
      created++;
    }
    return { created, errors };
  },
});
