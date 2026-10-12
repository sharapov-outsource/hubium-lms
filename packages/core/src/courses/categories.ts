import { type Category, type Db, type Prisma, SYSTEM_CONTEXT_ID, uuidv7 } from '@hubium/db';
import { z } from 'zod';
import { createContext, moveContext } from '../access/contexts.ts';
import type { RequestContext } from '../context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { optionalText } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';

type Tx = Prisma.TransactionClient | Db;

export interface CategoryNode extends Category {
  depth: number;
  children: CategoryNode[];
  courseCount: number;
}

/** Whole category tree, sorted, with course counts. */
export async function getCategoryTree(
  db: Tx,
  opts: { includeHidden?: boolean } = {},
): Promise<CategoryNode[]> {
  const [cats, counts] = await Promise.all([
    db.category.findMany({
      where: opts.includeHidden ? {} : { visible: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    db.course.groupBy({ by: ['categoryId'], where: { deletedAt: null }, _count: true }),
  ]);
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count]));
  const byParent = new Map<string | null, Category[]>();
  for (const c of cats) {
    const k = c.parentId ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(c);
  }
  const build = (parentId: string | null, depth: number): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((c) => ({
      ...c,
      depth,
      children: build(c.id, depth + 1),
      courseCount: countMap.get(c.id) ?? 0,
    }));
  return build(null, 0);
}

/** Depth-first flat list, convenient for <select> options. */
export function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

export async function categoryPath(db: Tx, id: string): Promise<Category[]> {
  const ctx = await db.context.findUnique({ where: { id }, select: { ancestorIds: true } });
  if (!ctx) return [];
  const ids = [...ctx.ancestorIds.filter((x) => x !== SYSTEM_CONTEXT_ID), id];
  const cats = await db.category.findMany({ where: { id: { in: ids } } });
  return ids.map((i) => cats.find((c) => c.id === i)).filter((c): c is Category => !!c);
}

const CategoryInput = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(10_000).default(''),
  idNumber: optionalText(100),
  parentId: z.string().uuid().nullable().optional(),
  visible: z.boolean().default(true),
});

export const createCategory = defineOperation({
  name: 'category.create',
  input: CategoryInput,
  authorize: (ctx, i) => ctx.perm.require('category:manage', i.parentId ?? SYSTEM_CONTEXT_ID),
  async handler(ctx, input) {
    const id = uuidv7();
    const parentContext = input.parentId ?? SYSTEM_CONTEXT_ID;
    if (input.parentId && !(await ctx.tx.category.findUnique({ where: { id: input.parentId } }))) {
      throw new NotFoundError('Parent category');
    }
    if (
      input.idNumber &&
      (await ctx.tx.category.findUnique({ where: { idNumber: input.idNumber } }))
    ) {
      throw new ValidationError({ idNumber: ['ID number already in use'] });
    }
    await createContext(ctx.tx, id, 'CATEGORY', parentContext);
    const count = await ctx.tx.category.count({ where: { parentId: input.parentId ?? null } });
    await ctx.tx.category.create({
      data: {
        id,
        name: input.name,
        description: input.description,
        idNumber: input.idNumber,
        parentId: input.parentId ?? null,
        visible: input.visible,
        sortOrder: count,
      },
    });
    await logEvent(ctx.tx, {
      name: 'category.created',
      actorId: ctx.perm.userId,
      contextId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

export const updateCategory = defineOperation({
  name: 'category.update',
  input: CategoryInput.extend({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('category:manage', i.id),
  async handler(ctx, input) {
    const cat = await ctx.tx.category.findUnique({ where: { id: input.id } });
    if (!cat) throw new NotFoundError('Category');
    const newParent = input.parentId === undefined ? cat.parentId : input.parentId;
    if (newParent !== cat.parentId) {
      if (newParent === cat.id)
        throw new ValidationError({ parentId: ['A category cannot contain itself'] });
      await ctx.perm.require('category:manage', newParent ?? SYSTEM_CONTEXT_ID);
      const target = newParent ?? SYSTEM_CONTEXT_ID;
      const targetCtx = await ctx.tx.context.findUnique({ where: { id: target } });
      if (targetCtx?.ancestorIds.includes(cat.id)) {
        throw new ValidationError({
          parentId: ['Cannot move a category into its own subcategory'],
        });
      }
      await moveContext(ctx.tx, cat.id, target);
    }
    if (input.idNumber && input.idNumber !== cat.idNumber) {
      const dupe = await ctx.tx.category.findUnique({ where: { idNumber: input.idNumber } });
      if (dupe) throw new ValidationError({ idNumber: ['ID number already in use'] });
    }
    await ctx.tx.category.update({
      where: { id: cat.id },
      data: {
        name: input.name,
        description: input.description,
        idNumber: input.idNumber ?? null,
        visible: input.visible,
        parentId: newParent,
      },
    });
    return { id: cat.id };
  },
});

export const deleteCategory = defineOperation({
  name: 'category.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx, i) => ctx.perm.require('category:manage', i.id),
  async handler(ctx, { id }) {
    const [children, courses] = await Promise.all([
      ctx.tx.category.count({ where: { parentId: id } }),
      ctx.tx.course.count({ where: { categoryId: id } }),
    ]);
    if (children || courses) throw new ConflictError('Category is not empty');
    await ctx.tx.category.delete({ where: { id } });
    await ctx.tx.context.delete({ where: { id } });
    await logEvent(ctx.tx, {
      name: 'category.deleted',
      actorId: ctx.perm.userId,
      objectId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

export const moveCategoryOrder = defineOperation({
  name: 'category.reorder',
  input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
  authorize: (ctx, i) => ctx.perm.require('category:manage', i.id),
  async handler(ctx, { id, direction }) {
    const cat = await ctx.tx.category.findUniqueOrThrow({ where: { id } });
    const siblings = await ctx.tx.category.findMany({
      where: { parentId: cat.parentId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return { id };
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    for (const [idx, s] of siblings.entries()) {
      await ctx.tx.category.update({ where: { id: s.id }, data: { sortOrder: idx } });
    }
    return { id };
  },
});

/** Categories where the actor may create courses (for the "new course" picker). */
export async function categoriesWhereCan(
  ctx: RequestContext,
  cap: 'course:create' | 'category:manage',
): Promise<CategoryNode[]> {
  const flat = flattenTree(await getCategoryTree(ctx.db, { includeHidden: true }));
  const out: CategoryNode[] = [];
  for (const c of flat) if (await ctx.perm.can(cap, c.id)) out.push(c);
  return out;
}
