import { isEmptyRichText, sanitizeRichText } from '@hubium/editor/server';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  defineQuery,
  type ModuleCtx,
  ModuleError,
  msg,
} from '@hubium/module-sdk';
import { groupsWhere, userGroupIds } from '@hubium/module-sdk/groups';
import { z } from 'zod';
import { diffText, htmlLines, linkedTitles, normTitle } from './text.ts';

// mod-wiki: pages a course writes together, as Moodle's wiki. A wiki is shared, or each
// group's in group mode, or each learner's own when it is individual; those are
// subwikis. Pages link to each other with [[Title]] (a link to a missing page offers
// to create it), every save is a version that can be compared and restored, and the
// page being changed is locked for others while its editor is open.

export const WikiSettings = z.object({
  /** collaborative: one wiki (per group); individual: each learner's own. */
  mode: z.enum(['collaborative', 'individual']).default('collaborative'),
  /** The page a wiki opens with. */
  firstPageTitle: z.string().trim().max(255).default(''),
});
export type WikiSettingsT = z.output<typeof WikiSettings>;
type Wiki = ActivityRef<WikiSettingsT>;

/** A lock lasts this long unless the open editor renews it. */
export const LOCK_MS = 2 * 60_000;

const uid = (ctx: ModuleCtx) => {
  if (ctx.actor.kind !== 'user') throw new ModuleError('BAD_REQUEST', msg('errors.common.signIn'));
  return ctx.actor.userId;
};

export const firstTitle = (a: Wiki) => normTitle(a.settings.firstPageTitle) || a.name;

// ── which wiki ──

export interface SubwikiRef {
  groupId: string | null;
  userId: string | null;
}
const keyOf = (s: SubwikiRef) => `${s.groupId ?? ''}/${s.userId ?? ''}`;

/**
 * The wiki the user asks for (or their own by default), what they may do with it, and
 * the other wikis they may switch to.
 */
export async function resolveSubwiki(
  ctx: ModuleCtx,
  ref: ActivityRef,
  ask: { groupId?: string | null; userId?: string | null },
) {
  const a = ref as Wiki;
  const me = uid(ctx);
  const [manage, write] = await Promise.all([
    ctx.perm.can('mod.wiki:manage', a.id),
    ctx.perm.can('mod.wiki:edit', a.id),
  ]);
  // groups
  let groupId: string | null = null;
  let groups: { id: string; name: string }[] = [];
  let mine: string[] = [];
  if (a.groupMode !== 'NONE') {
    mine = await userGroupIds(ctx.db, a, me);
    groups = await ctx.db.group.findMany({
      where:
        manage || a.groupMode === 'VISIBLE'
          ? groupsWhere(a)
          : { id: { in: mine }, ...groupsWhere(a) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    groupId =
      ask.groupId && groups.some((g) => g.id === ask.groupId)
        ? ask.groupId
        : (mine.find((g) => groups.some((x) => x.id === g)) ?? groups[0]?.id ?? null);
  }
  // learners in an individual wiki
  let userId: string | null = null;
  let users: { id: string; name: string }[] = [];
  if (a.settings.mode === 'individual') {
    userId = me;
    if (manage) {
      const ids = await ctx.perm.usersWithCap('mod.wiki:edit', a.id);
      users = await ctx.db.user.findMany({
        where: { id: { in: [...new Set([...ids, me])] } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      if (ask.userId && users.some((u) => u.id === ask.userId)) userId = ask.userId;
    }
  }
  const inGroup = a.groupMode === 'NONE' || groupId === null || mine.includes(groupId);
  const own = a.settings.mode !== 'individual' || userId === me;
  return {
    ref: { groupId, userId } satisfies SubwikiRef,
    groups,
    users,
    canEdit: write && (manage || (inGroup && own)),
    manage,
  };
}

async function subwikiOf(ctx: ModuleCtx, a: ActivityRef, s: SubwikiRef, create: boolean) {
  const key = keyOf(s);
  const found = await ctx.db.wikiSubwiki.findUnique({
    where: { activityId_key: { activityId: a.id, key } },
  });
  if (found || !create) return found;
  return ctx.db.wikiSubwiki.upsert({
    where: { activityId_key: { activityId: a.id, key } },
    create: { activityId: a.id, groupId: s.groupId, userId: s.userId, key },
    update: {},
  });
}

/** The subwiki of a page, checked against what the user may see and change. */
async function pageAccess(ctx: ModuleCtx, a: Wiki, pageId: string) {
  const page = await ctx.db.wikiPage.findUnique({
    where: { id: pageId },
    include: { subwiki: true },
  });
  if (!page || page.subwiki.activityId !== a.id)
    throw new ModuleError('NOT_FOUND', msg('mod.wiki.errors.noPage'));
  const r = await resolveSubwiki(ctx, a, {
    groupId: page.subwiki.groupId,
    userId: page.subwiki.userId,
  });
  if (keyOf(r.ref) !== page.subwiki.key)
    throw new ModuleError('NOT_FOUND', msg('mod.wiki.errors.noPage'));
  return { page, ...r };
}

// ── reading ──

/** Pages of a subwiki: titles, versions, and which pages nothing links to. */
export async function wikiIndex(ctx: ModuleCtx, ref: ActivityRef, s: SubwikiRef) {
  const a = ref as Wiki;
  const sw = await subwikiOf(ctx, a, s, false);
  if (!sw) return { pages: [], orphans: [] };
  const pages = await ctx.db.wikiPage.findMany({
    where: { subwikiId: sw.id },
    orderBy: { title: 'asc' },
    select: { id: true, title: true, version: true, updatedAt: true, content: true },
  });
  const linked = new Set(pages.flatMap((p) => linkedTitles(p.content)));
  const first = firstTitle(a);
  return {
    pages: pages.map(({ content: _c, ...p }) => p),
    orphans: pages.filter((p) => p.title !== first && !linked.has(p.title)).map((p) => p.title),
  };
}

/** A page by id or title in a subwiki; null when it is not written yet. */
export async function wikiPage(
  ctx: ModuleCtx,
  ref: ActivityRef,
  s: SubwikiRef,
  q: { pageId?: string; title?: string },
) {
  const a = ref as Wiki;
  const sw = await subwikiOf(ctx, a, s, false);
  if (!sw) return null;
  const title = q.title ? normTitle(q.title) : q.pageId ? undefined : firstTitle(a);
  const page = await ctx.db.wikiPage.findFirst({
    where: {
      subwikiId: sw.id,
      ...(q.pageId ? { id: q.pageId } : { title }),
    },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { createdAt: true, author: { select: { name: true } } },
      },
    },
  });
  if (!page) return null;
  const all = await ctx.db.wikiPage.findMany({
    where: { subwikiId: sw.id },
    select: { id: true, title: true },
  });
  const locked =
    page.lockedById &&
    page.lockedUntil &&
    page.lockedUntil > ctx.now &&
    page.lockedById !== uid(ctx)
      ? await ctx.db.user.findUnique({ where: { id: page.lockedById }, select: { name: true } })
      : null;
  return {
    id: page.id,
    title: page.title,
    content: page.content,
    version: page.version,
    updatedAt: page.updatedAt,
    author: page.versions[0]?.author?.name ?? null,
    /** Pages of the wiki by title, for links. */
    ids: Object.fromEntries(all.map((p) => [p.title, p.id])) as Record<string, string>,
    lockedBy: locked?.name ?? null,
  };
}

export async function wikiHistory(ctx: ModuleCtx, ref: ActivityRef, pageId: string) {
  await pageAccess(ctx, ref as Wiki, pageId);
  return ctx.db.wikiVersion.findMany({
    where: { pageId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      createdAt: true,
      content: true,
      author: { select: { name: true } },
    },
  });
}

/** Two versions of a page and what changed between them. */
export async function wikiCompare(
  ctx: ModuleCtx,
  ref: ActivityRef,
  pageId: string,
  from: number,
  to: number,
) {
  await pageAccess(ctx, ref as Wiki, pageId);
  const rows = await ctx.db.wikiVersion.findMany({
    where: { pageId, version: { in: [from, to] } },
    include: { author: { select: { name: true } } },
  });
  const a = rows.find((r) => r.version === from);
  const b = rows.find((r) => r.version === to);
  if (!a || !b) throw new ModuleError('NOT_FOUND', msg('mod.wiki.errors.noVersion'));
  return {
    from: { version: a.version, createdAt: a.createdAt, author: a.author?.name ?? null },
    to: { version: b.version, createdAt: b.createdAt, author: b.author?.name ?? null },
    parts: diffText(htmlLines(a.content), htmlLines(b.content)),
  };
}

// ── changing ──

/**
 * Holds the page until the transaction ends: two saves of one page at a time would both
 * write the next version (and the second fail on its number); the second now waits and
 * then finds the page changed.
 */
async function lockPage(ctx: ModuleCtx, pageId: string) {
  await ctx.db.$queryRaw`SELECT 1 FROM "WikiPage" WHERE "id" = ${pageId}::uuid FOR UPDATE`;
}

/** Saves a new version of a page: content, author and the page's version number. */
async function addVersion(ctx: ModuleCtx, page: { id: string; version: number }, content: string) {
  const version = page.version + 1;
  await ctx.db.wikiVersion.create({
    data: { pageId: page.id, version, content, authorId: uid(ctx), createdAt: ctx.now },
  });
  await ctx.db.wikiPage.update({
    where: { id: page.id },
    data: { content, version, lockedById: null, lockedUntil: null },
  });
  return version;
}

const SubwikiInput = {
  groupId: z.string().uuid().nullable().default(null),
  userId: z.string().uuid().nullable().default(null),
};

export const wiki = defineModule<WikiSettingsT>({
  key: 'wiki',
  archetype: 'activity',
  icon: 'NotebookPen',
  // backups carry the settings: the pages are users' work, as in Moodle
  supports: { viewCompletion: true, groups: true },
  settings: {
    schema: WikiSettings as unknown as z.ZodType<WikiSettingsT>,
    defaults: () => WikiSettings.parse({}),
  },
  completion: {
    schema: z.object({
      edits: z.preprocess(
        (v) => (v === '' || v === null ? undefined : v),
        z.coerce.number().int().min(1).max(1000).optional(),
      ),
    }),
    async evaluate(ctx, a, userId, rules) {
      const need = (rules as { edits?: number }).edits;
      if (!need) return 'complete';
      const n = await ctx.db.wikiVersion.count({
        where: { authorId: userId, page: { subwiki: { activityId: a.id } } },
      });
      return n >= need ? 'complete' : 'incomplete';
    },
  },
  // pages are what learners write: the tutor does not read them
  ai: { tutorPolicy: 'exclude' },
  reset: {
    async userData(ctx, a) {
      await ctx.db.wikiSubwiki.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return {
        versions: await ctx.db.wikiVersion.findMany({
          where: { authorId: userId },
          select: {
            version: true,
            content: true,
            createdAt: true,
            page: { select: { title: true, subwiki: { select: { activityId: true } } } },
          },
        }),
      };
    },
    // a learner's own wiki goes; versions of shared pages stay without their author
    async erase(ctx, userId) {
      await ctx.db.wikiSubwiki.deleteMany({ where: { userId } });
      await ctx.db.wikiVersion.updateMany({
        where: { authorId: userId },
        data: { authorId: null },
      });
    },
  },
  queries: {
    index: defineQuery({
      summary: 'Pages of a wiki (yours or a group’s by default) and the orphaned ones',
      input: z.object(SubwikiInput),
      async handler(ctx, a, input) {
        const r = await resolveSubwiki(ctx, a, input);
        return wikiIndex(ctx, a, r.ref);
      },
    }),
    page: defineQuery({
      summary: 'A page by id or title (the first page by default) with its HTML and version',
      input: z.object({
        ...SubwikiInput,
        pageId: z.string().uuid().optional(),
        title: z.string().max(255).optional(),
      }),
      async handler(ctx, a, input) {
        const r = await resolveSubwiki(ctx, a, input);
        const p = await wikiPage(ctx, a, r.ref, input);
        if (!p) throw new ModuleError('NOT_FOUND', msg('mod.wiki.errors.notWrittenYet'));
        const { ids: _ids, ...out } = p;
        return out;
      },
    }),
    history: defineQuery({
      summary: 'Versions of a page, newest first',
      input: z.object({ pageId: z.string().uuid() }),
      async handler(ctx, a, input) {
        return (await wikiHistory(ctx, a, input.pageId)).map(({ content: _c, ...v }) => v);
      },
    }),
  },
  actions: {
    lock: defineAction({
      offline: 'replay',
      summary:
        'Start or go on changing a page (the lock lasts two minutes unless renewed); `force` takes it over',
      capability: 'mod.wiki:edit',
      input: z.object({ pageId: z.string().uuid(), force: z.boolean().default(false) }),
      async handler(ctx, ref, input) {
        const a = ref as Wiki;
        const me = uid(ctx);
        const { page, canEdit } = await pageAccess(ctx, a, input.pageId);
        if (!canEdit) throw new ModuleError('FORBIDDEN', msg('mod.wiki.errors.cannotChange'));
        const held = page.lockedById && page.lockedById !== me && page.lockedUntil! > ctx.now;
        if (held && !(input.force && (await ctx.perm.can('mod.wiki:overridelock', a.id)))) {
          const who = await ctx.db.user.findUnique({
            where: { id: page.lockedById! },
            select: { name: true },
          });
          return { locked: false, by: who?.name ?? null, until: page.lockedUntil };
        }
        const until = new Date(ctx.now.getTime() + LOCK_MS);
        await ctx.db.wikiPage.update({
          where: { id: page.id },
          data: { lockedById: me, lockedUntil: until },
        });
        return { locked: true, by: null, until };
      },
    }),
    unlock: defineAction({
      offline: 'replay',
      summary: 'Stop changing a page without saving',
      input: z.object({ pageId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const { page } = await pageAccess(ctx, ref as Wiki, input.pageId);
        if (page.lockedById === uid(ctx))
          await ctx.db.wikiPage.update({
            where: { id: page.id },
            data: { lockedById: null, lockedUntil: null },
          });
        return { ok: true };
      },
    }),
    save: defineAction({
      offline: 'guarded',
      summary:
        'Save a page: a new page by `title`, or a new version of `pageId` (`baseVersion` is the version you changed)',
      capability: 'mod.wiki:edit',
      input: z.object({
        ...SubwikiInput,
        pageId: z.string().uuid().optional(),
        title: z.string().max(255).optional(),
        baseVersion: z.number().int().min(0).optional(),
        content: z.string().max(500_000),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Wiki;
        const me = uid(ctx);
        const content = sanitizeRichText(input.content);
        if (isEmptyRichText(content))
          throw new ModuleError('BAD_REQUEST', msg('mod.wiki.errors.pageEmpty'));
        if (input.pageId) {
          // a change is to the version it was made on, or it would overwrite another's
          if (input.baseVersion === undefined)
            throw new ModuleError('BAD_REQUEST', msg('mod.wiki.errors.baseVersionNeeded'));
          await lockPage(ctx, input.pageId);
          const { page, canEdit } = await pageAccess(ctx, a, input.pageId);
          if (!canEdit) throw new ModuleError('FORBIDDEN', msg('mod.wiki.errors.cannotChange'));
          if (page.lockedById && page.lockedById !== me && page.lockedUntil! > ctx.now)
            throw new ModuleError('CONFLICT', msg('mod.wiki.errors.lockedByOther'));
          if (input.baseVersion !== page.version)
            throw new ModuleError('CONFLICT', msg('mod.wiki.errors.changedMeanwhile'));
          const version = await addVersion(ctx, page, content);
          await ctx.completion.recompute(a.id, me);
          return { pageId: page.id, version };
        }
        const title = normTitle(input.title ?? '');
        if (!title) throw new ModuleError('BAD_REQUEST', msg('mod.wiki.errors.titleRequired'));
        const r = await resolveSubwiki(ctx, a, input);
        if (!r.canEdit) throw new ModuleError('FORBIDDEN', msg('mod.wiki.errors.cannotWrite'));
        const sw = (await subwikiOf(ctx, a, r.ref, true))!;
        const taken = await ctx.db.wikiPage.findUnique({
          where: { subwikiId_title: { subwikiId: sw.id, title } },
        });
        if (taken) throw new ModuleError('CONFLICT', msg('mod.wiki.errors.titleTaken'));
        const page = await ctx.db.wikiPage.create({
          data: { subwikiId: sw.id, title, createdAt: ctx.now },
        });
        const version = await addVersion(ctx, page, content);
        await ctx.completion.recompute(a.id, me);
        await ctx.log('wiki.page.created', { activityId: a.id, pageId: page.id });
        return { pageId: page.id, version };
      },
    }),
    restore: defineAction({
      offline: 'guarded',
      summary: 'Make an old version of a page the latest one',
      capability: 'mod.wiki:edit',
      input: z.object({ pageId: z.string().uuid(), version: z.number().int().min(1) }),
      async handler(ctx, ref, input) {
        const a = ref as Wiki;
        await lockPage(ctx, input.pageId);
        const { page, canEdit } = await pageAccess(ctx, a, input.pageId);
        if (!canEdit) throw new ModuleError('FORBIDDEN', msg('mod.wiki.errors.cannotChange'));
        if (page.lockedById && page.lockedById !== uid(ctx) && page.lockedUntil! > ctx.now)
          throw new ModuleError('CONFLICT', msg('mod.wiki.errors.lockedByOther'));
        const old = await ctx.db.wikiVersion.findUnique({
          where: { pageId_version: { pageId: page.id, version: input.version } },
        });
        if (!old) throw new ModuleError('NOT_FOUND', msg('mod.wiki.errors.noVersion'));
        return { version: await addVersion(ctx, page, old.content) };
      },
    }),
    deletePage: defineAction({
      offline: 'guarded',
      summary: 'Delete a page with its history',
      capability: 'mod.wiki:manage',
      input: z.object({ pageId: z.string().uuid() }),
      async handler(ctx, ref, input) {
        const { page } = await pageAccess(ctx, ref as Wiki, input.pageId);
        await ctx.db.wikiPage.delete({ where: { id: page.id } });
        return { ok: true };
      },
    }),
  },
});

export const wikiModules = [wiki];
