import { sanitizeRichText } from '@hubium/editor/server';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
  msg,
} from '@hubium/module-sdk';
import { bool } from '@hubium/module-sdk/fields';
import { z } from 'zod';

// mod-book: a resource of several pages, as in Moodle. Chapters are kept in one ordered
// list; a subchapter belongs to the chapter before it. Moving, hiding or deleting a
// chapter takes its subchapters along.

export const BookSettings = z.object({
  /** How chapter titles are numbered in the table of contents and headings. */
  numbering: z.enum(['none', 'numbers', 'bullets', 'indented']).default('numbers'),
  /** The chapter's content carries its own title: none is added above it. */
  customTitles: bool(false),
});
export type BookSettingsT = z.output<typeof BookSettings>;

export interface Chapter {
  id: string;
  sortOrder: number;
  subchapter: boolean;
  title: string;
  content: string;
  hidden: boolean;
}

/** Chapter numbers in reading order: "1" for a chapter, "1.2" for its subchapters. */
export function chapterNumbers(chapters: Pick<Chapter, 'id' | 'subchapter'>[]) {
  const out = new Map<string, string>();
  let main = 0;
  let sub = 0;
  for (const c of chapters) {
    if (!c.subchapter || main === 0) {
      main++;
      sub = 0;
      out.set(c.id, String(main));
    } else {
      sub++;
      out.set(c.id, `${main}.${sub}`);
    }
  }
  return out;
}

/** The chapter and, for a main chapter, the subchapters that follow it. */
export function chapterBlock<T extends Pick<Chapter, 'id' | 'subchapter'>>(list: T[], id: string) {
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return [];
  if (list[i]!.subchapter) return [list[i]!];
  let end = i + 1;
  while (end < list.length && list[end]!.subchapter) end++;
  return list.slice(i, end);
}

/**
 * The order after moving a chapter one step: a main chapter (with its subchapters) swaps
 * with the neighbouring main chapter's block, a subchapter with the neighbouring row.
 */
export function movedOrder<T extends Pick<Chapter, 'id' | 'subchapter'>>(
  list: T[],
  id: string,
  direction: 'up' | 'down',
): T[] {
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return list;
  const c = list[i]!;
  if (c.subchapter) {
    const j = direction === 'up' ? i - 1 : i + 1;
    // the first row of the book is always a chapter
    if (j < (direction === 'up' ? 1 : 0) || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  }
  const blocks: T[][] = [];
  for (const row of list)
    if (!row.subchapter || !blocks.length) blocks.push([row]);
    else blocks.at(-1)!.push(row);
  const b = blocks.findIndex((x) => x[0]!.id === id);
  const other = direction === 'up' ? b - 1 : b + 1;
  if (other < 0 || other >= blocks.length) return list;
  [blocks[b], blocks[other]] = [blocks[other]!, blocks[b]!];
  return blocks.flat();
}

async function chapters(ctx: ModuleCtx, activityId: string): Promise<Chapter[]> {
  return ctx.db.bookChapter.findMany({
    where: { activityId },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      sortOrder: true,
      subchapter: true,
      title: true,
      content: true,
      hidden: true,
    },
  });
}

/** The chapters learners read: neither hidden ones nor the subchapters of a hidden one. */
export function readableChapters<C extends { subchapter: boolean; hidden: boolean }>(
  all: C[],
): C[] {
  let parentHidden = false;
  return all.filter((c) => {
    if (!c.subchapter) parentHidden = c.hidden;
    return !c.hidden && !parentHidden;
  });
}

/** Chapters the user may read: hidden ones (and their subchapters) only with the capability. */
export async function visibleChapters(ctx: ModuleCtx, a: ActivityRef): Promise<Chapter[]> {
  const all = await chapters(ctx, a.id);
  if (await ctx.perm.can('mod.book:viewhiddenchapters', a.id)) return all;
  return readableChapters(all);
}

/** Writes the order back as 0..n; the first row cannot be a subchapter. */
async function saveOrder(ctx: ModuleCtx, list: Pick<Chapter, 'id' | 'subchapter'>[]) {
  for (const [i, c] of list.entries())
    await ctx.db.bookChapter.update({
      where: { id: c.id },
      data: { sortOrder: i, ...(i === 0 && c.subchapter ? { subchapter: false } : {}) },
    });
}

async function chapterOf(ctx: ModuleCtx, a: ActivityRef, id: string) {
  const c = await ctx.db.bookChapter.findFirst({ where: { id, activityId: a.id } });
  if (!c) throw new ModuleError('NOT_FOUND', msg('mod.book.errors.noChapter'));
  return c;
}

const ChapterInput = z.object({
  title: z.string().trim().min(1).max(255),
  content: z.string().max(500_000).default(''),
  subchapter: z.boolean().default(false),
});

/** Replaces ids an import mapped (files in chapter content); others stay. */
function rewriteIds(text: string, map: (old: string) => string | undefined) {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (m) => map(m.toLowerCase()) ?? m,
  );
}

const ExportedChapter = z.object({
  title: z.string(),
  content: z.string(),
  subchapter: z.boolean(),
  hidden: z.boolean(),
});

export const book = defineModule<BookSettingsT>({
  key: 'book',
  archetype: 'resource',
  icon: 'BookOpen',
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: BookSettings as unknown as z.ZodType<BookSettingsT>,
    defaults: () => BookSettings.parse({}),
  },
  ai: {
    async extract(ctx, a) {
      // the tutor answers learners: what they cannot read stays out
      return readableChapters(await chapters(ctx, a.id)).map((c) => ({
        title: c.title,
        text: c.content,
      }));
    },
  },
  backup: {
    async export(ctx, a) {
      return {
        chapters: (await chapters(ctx, a.id)).map(({ title, content, subchapter, hidden }) => ({
          title,
          content,
          subchapter,
          hidden,
        })),
      };
    },
    async import(ctx, a, data, map) {
      // the archive is untrusted: the same checks as when chapters are written here
      const parsed = z.object({ chapters: z.array(ExportedChapter).max(5000) }).safeParse(data);
      if (!parsed.success) return;
      await ctx.db.bookChapter.createMany({
        data: parsed.data.chapters.map((c, i) => ({
          activityId: a.id,
          sortOrder: i,
          subchapter: i > 0 && c.subchapter,
          title: c.title.slice(0, 255) || '—',
          content: sanitizeRichText(rewriteIds(c.content, map)),
          hidden: c.hidden,
        })),
      });
    },
  },
  queries: {
    chapters: defineQuery({
      summary: 'The table of contents: chapters the caller may read, in order',
      input: z.object({}),
      async handler(ctx, a) {
        const list = await visibleChapters(ctx, a);
        const numbers = chapterNumbers(list);
        return list.map((c) => ({
          id: c.id,
          number: numbers.get(c.id),
          title: c.title,
          subchapter: c.subchapter,
          hidden: c.hidden,
        }));
      },
    }),
    chapter: defineQuery({
      summary: 'One chapter with its content',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        const c = (await visibleChapters(ctx, a)).find((x) => x.id === input.id);
        if (!c) throw new ModuleError('NOT_FOUND', msg('mod.book.errors.noChapter'));
        return c;
      },
    }),
  },
  actions: {
    addChapter: defineAction({
      summary: 'Add a chapter, after another one or at the end',
      capability: 'mod.book:edit',
      input: ChapterInput.extend({ afterId: z.string().uuid().nullable().default(null) }),
      async handler(ctx, a, input) {
        const list = await chapters(ctx, a.id);
        // after a main chapter, a new main chapter goes after its subchapters
        let at = list.length;
        if (input.afterId) {
          const block = input.subchapter
            ? [list.find((c) => c.id === input.afterId)].filter(Boolean)
            : chapterBlock(list, input.afterId);
          if (!block.length) throw new ModuleError('NOT_FOUND', msg('mod.book.errors.noChapter'));
          at = list.findIndex((c) => c.id === block.at(-1)!.id) + 1;
        }
        const created = await ctx.db.bookChapter.create({
          data: {
            activityId: a.id,
            sortOrder: list.length,
            subchapter: input.subchapter && list.length > 0 && at > 0,
            title: input.title,
            content: sanitizeRichText(input.content),
          },
        });
        const order = [...list];
        order.splice(at, 0, created);
        await saveOrder(ctx, order);
        await ctx.log('book.chapter.created', { activityId: a.id, chapterId: created.id });
        return { id: created.id };
      },
    }),
    updateChapter: defineAction({
      summary: 'Change a chapter',
      capability: 'mod.book:edit',
      input: ChapterInput.extend({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        await chapterOf(ctx, a, input.id);
        const first = (await chapters(ctx, a.id))[0]?.id === input.id;
        await ctx.db.bookChapter.update({
          where: { id: input.id },
          data: {
            title: input.title,
            content: sanitizeRichText(input.content),
            subchapter: input.subchapter && !first,
          },
        });
        await ctx.log('book.chapter.updated', { activityId: a.id, chapterId: input.id });
        return { id: input.id };
      },
    }),
    deleteChapter: defineAction({
      summary: 'Delete a chapter (a chapter goes with its subchapters)',
      capability: 'mod.book:edit',
      input: z.object({ id: z.string().uuid() }),
      async handler(ctx, a, input) {
        await chapterOf(ctx, a, input.id);
        const list = await chapters(ctx, a.id);
        const gone = new Set(chapterBlock(list, input.id).map((c) => c.id));
        await ctx.db.bookChapter.deleteMany({ where: { id: { in: [...gone] } } });
        await saveOrder(
          ctx,
          list.filter((c) => !gone.has(c.id)),
        );
        await ctx.log('book.chapter.deleted', { activityId: a.id, chapters: gone.size });
        return { deleted: gone.size };
      },
    }),
    moveChapter: defineAction({
      summary: 'Move a chapter one step up or down',
      capability: 'mod.book:edit',
      input: z.object({ id: z.string().uuid(), direction: z.enum(['up', 'down']) }),
      async handler(ctx, a, input) {
        await chapterOf(ctx, a, input.id);
        await saveOrder(ctx, movedOrder(await chapters(ctx, a.id), input.id, input.direction));
        return { ok: true };
      },
    }),
    setChapterHidden: defineAction({
      summary: 'Hide or show a chapter (with its subchapters)',
      capability: 'mod.book:edit',
      input: z.object({ id: z.string().uuid(), hidden: z.boolean() }),
      async handler(ctx, a, input) {
        await chapterOf(ctx, a, input.id);
        const block = chapterBlock(await chapters(ctx, a.id), input.id);
        await ctx.db.bookChapter.updateMany({
          where: { id: { in: block.map((c) => c.id) } },
          data: { hidden: input.hidden },
        });
        return { ok: true };
      },
    }),
  },
});

export const bookModules = [book];
