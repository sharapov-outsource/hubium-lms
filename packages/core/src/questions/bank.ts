import type { Db, Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { msg } from '@hubium/module-sdk';
import {
  checkQuestionText,
  checkVariants,
  Dataset,
  Hint,
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

export async function listQuestionCategories(ctx: RequestContext, courseId: string) {
  await ctx.perm.require('question:use', courseId);
  await ensureDefaultQuestionCategory(ctx.db, courseId);
  return ctx.db.questionCategory.findMany({
    where: { contextId: courseId },
    orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { questions: { where: { status: { not: 'HIDDEN' } } } } } },
  });
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
    if (early) throw new ValidationError({ text: [early] });
    const data = validateData(input.type, derived) as Prisma.InputJsonValue;
    const textError = fromText ? null : checkQuestionText(input.type, text, data);
    if (textError) throw new ValidationError({ text: [textError] });
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
      if (problem) throw new ValidationError({ data: [problem] });
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

export async function listQuestions(
  ctx: RequestContext,
  courseId: string,
  opts: { categoryId?: string; q?: string; type?: QuestionType; includeHidden?: boolean } = {},
) {
  await ctx.perm.require('question:use', courseId);
  return ctx.db.question.findMany({
    where: {
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
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: 500,
  });
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
    const errors = [...parsed.errors.map((e) => ({ block: e.block, message: e.message }))];
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
        errors.push({
          block: 0,
          message: `${q.name}: ${data.error.issues[0]?.message ?? 'invalid'}`,
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
