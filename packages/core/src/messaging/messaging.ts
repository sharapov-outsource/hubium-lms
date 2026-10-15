import { type Db, Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { fileUrl, registerFileArea, storeFile } from '../files/files.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { publishRealtime } from '../realtime.ts';

// Direct, group and course-group conversations. Delivery is realtime (SSE); offline
// recipients get a `message.new` notification (email digest by default) for the first
// unread message of a conversation only.

type Tx = Prisma.TransactionClient;
type AnyDb = Db | Tx;

export const MESSAGE_COMPONENT = 'message';
export const MESSAGE_MAX_FILES = 5;
/** Attachments travel in one server action request (10 MB body limit, see next.config). */
export const MESSAGE_MAX_FILE_BYTES = 9 * 1024 * 1024;

function me(ctx: RequestContext): string {
  const id = ctx.perm.userId;
  if (!id) throw new ForbiddenError(msg('errors.common.signIn'));
  return id;
}

export const directKey = (a: string, b: string) => [a, b].sort().join(':');

async function isBlocked(db: AnyDb, a: string, b: string): Promise<boolean> {
  const n = await db.userBlock.count({
    where: {
      OR: [
        { userId: a, blockedUserId: b },
        { userId: b, blockedUserId: a },
      ],
    },
  });
  return n > 0;
}

async function shareCourse(db: AnyDb, a: string, b: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "Enrolment" e1
      JOIN "Enrolment" e2 ON e2."courseId" = e1."courseId"
     WHERE e1."userId" = ${a}::uuid AND e2."userId" = ${b}::uuid
       AND e1.status = 'ACTIVE' AND e2.status = 'ACTIVE'`;
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Can `from` start a conversation with / write to `to`? Blocks and privacy apply. */
export async function canMessage(
  db: AnyDb,
  from: { id: string; isSiteAdmin?: boolean },
  toId: string,
): Promise<{ ok: true } | { ok: false; reason: 'blocked' | 'privacy' | 'unavailable' }> {
  if (from.id === toId) return { ok: true };
  const to = await db.user.findUnique({
    where: { id: toId },
    select: { status: true, kind: true, messagePrivacy: true },
  });
  if (to?.status !== 'ACTIVE' || to.kind !== 'PERSON') {
    return { ok: false, reason: 'unavailable' };
  }
  if (await isBlocked(db, from.id, toId)) return { ok: false, reason: 'blocked' };
  if (from.isSiteAdmin) return { ok: true };
  if (to.messagePrivacy === 'NOBODY') return { ok: false, reason: 'privacy' };
  if (to.messagePrivacy === 'COURSEMATES' && !(await shareCourse(db, from.id, toId))) {
    return { ok: false, reason: 'privacy' };
  }
  return { ok: true };
}

async function requireMember(db: AnyDb, conversationId: string, userId: string) {
  const m = await db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: { conversation: true },
  });
  if (!m || m.leftAt) throw new NotFoundError('Conversation');
  return m;
}

async function activeMemberIds(db: AnyDb, conversationId: string): Promise<string[]> {
  const rows = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ── conversations ─────────────────────────────────────────────────────────────

export const openDirectConversation = defineOperation({
  name: 'message.direct.open',
  mutation: true,
  input: z.object({ userId: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('message:send'),
  async handler(ctx, { userId }) {
    const self = me(ctx);
    const key = directKey(self, userId);
    const existing = await ctx.tx.conversation.findUnique({ where: { directKey: key } });
    if (existing) {
      await ctx.tx.conversationMember.updateMany({
        where: { conversationId: existing.id, userId: self },
        data: { archivedAt: null },
      });
      return { id: existing.id };
    }
    const check = await canMessage(ctx.tx, { id: self, isSiteAdmin: ctx.perm.isSiteAdmin }, userId);
    if (!check.ok) throw new ForbiddenError(msg(`errors.messaging.cannotMessage.${check.reason}`));
    const c = await ctx.tx.conversation.create({
      data: {
        kind: self === userId ? 'SELF' : 'DIRECT',
        directKey: key,
        createdById: self,
        members: {
          create: [...new Set([self, userId])].map((u) => ({ userId: u })),
        },
      },
    });
    return { id: c.id };
  },
});

export const createGroupConversation = defineOperation({
  name: 'message.group.create',
  mutation: true,
  input: z.object({
    name: z.string().trim().min(1).max(100),
    userIds: z.array(z.string().uuid()).min(1).max(100),
  }),
  authorize: (ctx) => ctx.perm.require('message:send'),
  async handler(ctx, input) {
    const self = me(ctx);
    const others = [...new Set(input.userIds)].filter((u) => u !== self);
    for (const u of others) {
      const check = await canMessage(ctx.tx, { id: self, isSiteAdmin: ctx.perm.isSiteAdmin }, u);
      if (!check.ok)
        throw new ValidationError({ userIds: [msg(`errors.messaging.cannotAdd.${check.reason}`)] });
    }
    const c = await ctx.tx.conversation.create({
      data: {
        kind: 'GROUP',
        name: input.name,
        createdById: self,
        members: { create: [self, ...others].map((userId) => ({ userId })) },
      },
    });
    return { id: c.id };
  },
});

/**
 * Opens the chat of a course group, creating it on first use and syncing its members
 * with the group (plus the opener when they manage the course).
 */
export const openGroupChat = defineOperation({
  name: 'message.groupchat.open',
  mutation: true,
  input: z.object({ groupId: z.string().uuid() }),
  async authorize(ctx, { groupId }) {
    const self = me(ctx);
    const g = await ctx.db.group.findUnique({
      where: { id: groupId },
      select: { courseId: true, members: { where: { userId: self }, select: { userId: true } } },
    });
    if (!g) throw new NotFoundError('Group');
    if (!g.members.length) await ctx.perm.require('group:manage', g.courseId);
  },
  async handler(ctx, { groupId }) {
    const self = me(ctx);
    const g = await ctx.tx.group.findUniqueOrThrow({
      where: { id: groupId },
      include: { members: { select: { userId: true } } },
    });
    const c =
      (await ctx.tx.conversation.findUnique({ where: { groupId } })) ??
      (await ctx.tx.conversation.create({
        data: { kind: 'GROUP', name: g.name, courseId: g.courseId, groupId, createdById: self },
      }));
    await syncGroupChatMembers(ctx.tx, c.id, [...g.members.map((m) => m.userId), self]);
    return { id: c.id };
  },
});

export async function syncGroupChatMembers(
  tx: Tx,
  conversationId: string,
  userIds: string[],
): Promise<void> {
  const want = new Set(userIds);
  const current = await tx.conversationMember.findMany({ where: { conversationId } });
  for (const m of current) {
    if (want.has(m.userId) && m.leftAt) {
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId, userId: m.userId } },
        data: { leftAt: null },
      });
    }
    want.delete(m.userId);
  }
  if (want.size) {
    await tx.conversationMember.createMany({
      data: [...want].map((userId) => ({ conversationId, userId })),
      skipDuplicates: true,
    });
  }
}

/** People who leave course groups also leave those groups' chats. */
export async function leaveGroupChats(
  tx: AnyDb,
  where: { groupIds: string[] } | { courseId: string },
  userIds: string[],
): Promise<void> {
  if (!userIds.length) return;
  await tx.conversationMember.updateMany({
    where: {
      userId: { in: userIds },
      leftAt: null,
      conversation:
        'groupIds' in where
          ? { groupId: { in: where.groupIds } }
          : { courseId: where.courseId, groupId: { not: null } },
    },
    data: { leftAt: new Date() },
  });
}

export interface ConversationSummary {
  id: string;
  kind: 'DIRECT' | 'GROUP' | 'SELF';
  name: string | null;
  courseId: string | null;
  lastMessageAt: Date | null;
  unread: number;
  lastBody: string | null;
  lastSenderId: string | null;
  otherUserId: string | null;
  otherName: string | null;
  otherImage: string | null;
  memberCount: number;
}

export async function listConversations(
  db: Db,
  userId: string,
  opts: { q?: string; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const rows = await db.$queryRaw<(ConversationSummary & { unread: bigint })[]>`
    SELECT c.id, c.kind::text AS kind, c.name, c."courseId", c."lastMessageAt",
      (SELECT count(*) FROM "Message" x
        WHERE x."conversationId" = c.id AND x."deletedAt" IS NULL
          AND x."senderId" IS DISTINCT FROM ${userId}::uuid
          AND x."createdAt" > COALESCE(m."lastReadAt", 'epoch')) AS unread,
      lm.body AS "lastBody", lm."senderId" AS "lastSenderId",
      ou.id AS "otherUserId", ou.name AS "otherName", ou.image AS "otherImage",
      (SELECT count(*)::int FROM "ConversationMember" cm
        WHERE cm."conversationId" = c.id AND cm."leftAt" IS NULL) AS "memberCount"
    FROM "ConversationMember" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    LEFT JOIN LATERAL (
      SELECT body, "senderId" FROM "Message"
       WHERE "conversationId" = c.id AND "deletedAt" IS NULL
       ORDER BY "createdAt" DESC, id DESC LIMIT 1) lm ON true
    LEFT JOIN LATERAL (
      SELECT u.id, u.name, u.image FROM "ConversationMember" om
        JOIN "User" u ON u.id = om."userId"
       WHERE om."conversationId" = c.id AND om."userId" <> ${userId}::uuid
         AND c.kind = 'DIRECT' LIMIT 1) ou ON true
    WHERE m."userId" = ${userId}::uuid AND m."leftAt" IS NULL AND m."archivedAt" IS NULL
      AND (${q}::text IS NULL OR c.name ILIKE ${q} OR ou.name ILIKE ${q})
    ORDER BY c."lastMessageAt" DESC NULLS LAST, c."createdAt" DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, unread: Number(r.unread) }));
}

/** Number of conversations with unread messages (the header badge). */
export async function unreadConversationCount(db: Db, userId: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "ConversationMember" m
     WHERE m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
       AND EXISTS (SELECT 1 FROM "Message" x
                    WHERE x."conversationId" = m."conversationId" AND x."deletedAt" IS NULL
                      AND x."senderId" IS DISTINCT FROM ${userId}::uuid
                      AND x."createdAt" > COALESCE(m."lastReadAt", 'epoch'))`;
  return Number(rows[0]?.n ?? 0);
}

export async function getConversation(db: Db, userId: string, conversationId: string) {
  const m = await requireMember(db, conversationId, userId);
  const members = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    include: { user: { select: { id: true, name: true, image: true, lastAccessAt: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  const other =
    m.conversation.kind === 'DIRECT' ? members.find((x) => x.userId !== userId)?.user : undefined;
  const blocked = other ? await isBlocked(db, userId, other.id) : false;
  const iBlocked = other
    ? (await db.userBlock.count({ where: { userId, blockedUserId: other.id } })) > 0
    : false;
  return {
    ...m.conversation,
    lastReadAt: m.lastReadAt,
    mutedUntil: m.mutedUntil,
    members: members.map((x) => x.user),
    other: other ?? null,
    blocked,
    iBlocked,
  };
}

export interface MessageView {
  id: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  createdAt: Date;
  deleted: boolean;
  attachments: { id: string; name: string; mimeType: string; size: number; url: string }[];
}

export async function listMessages(
  db: Db,
  userId: string,
  conversationId: string,
  opts: { before?: string; after?: string; limit?: number } = {},
): Promise<{ items: MessageView[]; hasMore: boolean }> {
  await requireMember(db, conversationId, userId);
  const limit = Math.min(opts.limit ?? 30, 100);
  const rows = await db.message.findMany({
    where: {
      conversationId,
      ...(opts.before ? { id: { lt: opts.before } } : {}),
      ...(opts.after ? { id: { gt: opts.after } } : {}),
    },
    orderBy: { id: opts.after ? 'asc' : 'desc' },
    take: limit + 1,
    include: { sender: { select: { name: true } } },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!opts.after) page.reverse();
  const files = page.length
    ? await db.file.findMany({
        where: {
          contextId: SYSTEM_CONTEXT_ID,
          component: MESSAGE_COMPONENT,
          area: 'attachment',
          itemId: { in: page.map((m) => m.id) },
        },
        orderBy: { name: 'asc' },
      })
    : [];
  return {
    hasMore,
    items: page.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.sender?.name ?? null,
      body: m.deletedAt ? '' : m.body,
      createdAt: m.createdAt,
      deleted: !!m.deletedAt,
      attachments: m.deletedAt
        ? []
        : files
            .filter((f) => f.itemId === m.id)
            .map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              size: Number(f.size),
              url: fileUrl(f),
            })),
    })),
  };
}

// ── sending ───────────────────────────────────────────────────────────────────

const Attachment = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().max(255).optional(),
  data: z.custom<Buffer>((v) => Buffer.isBuffer(v), 'Expected file data'),
});

export const sendMessage = defineOperation({
  name: 'message.send',
  mutation: true,
  input: z
    .object({
      conversationId: z.string().uuid(),
      body: z.string().trim().max(10_000).default(''),
      attachments: z.array(Attachment).max(MESSAGE_MAX_FILES).default([]),
    })
    .refine((i) => i.body.length > 0 || i.attachments.length > 0, {
      message: 'errors.messaging.empty',
      path: ['body'],
    }),
  authorize: (ctx) => ctx.perm.require('message:send'),
  async handler(ctx, input) {
    const self = me(ctx);
    const member = await requireMember(ctx.tx, input.conversationId, self);
    const conv = member.conversation;
    const members = await activeMemberIds(ctx.tx, conv.id);
    const others = members.filter((u) => u !== self);
    if (conv.kind === 'DIRECT' && others[0]) {
      const check = await canMessage(
        ctx.tx,
        { id: self, isSiteAdmin: ctx.perm.isSiteAdmin },
        others[0],
      );
      if (!check.ok)
        throw new ForbiddenError(msg(`errors.messaging.cannotMessage.${check.reason}`));
    }
    const previous = conv.lastMessageAt;
    const message = await ctx.tx.message.create({
      data: { conversationId: conv.id, senderId: self, body: input.body, createdAt: ctx.now },
    });
    for (const f of input.attachments) {
      await storeFile(ctx.tx, {
        contextId: SYSTEM_CONTEXT_ID,
        component: MESSAGE_COMPONENT,
        area: 'attachment',
        itemId: message.id,
        name: f.name,
        mimeType: f.mimeType,
        data: f.data,
        uploadedById: self,
        maxBytes: MESSAGE_MAX_FILE_BYTES,
      });
    }
    await ctx.tx.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: ctx.now },
    });
    await ctx.tx.conversationMember.update({
      where: { conversationId_userId: { conversationId: conv.id, userId: self } },
      data: { lastReadAt: ctx.now, archivedAt: null },
    });
    await ctx.tx.conversationMember.updateMany({
      where: { conversationId: conv.id, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    await publishRealtime(ctx.tx, members, 'message.new', {
      conversationId: conv.id,
      messageId: message.id,
      senderId: self,
    });
    // Notify only recipients who had read everything before this message (one per burst).
    const fresh = await ctx.tx.conversationMember.findMany({
      where: {
        conversationId: conv.id,
        userId: { in: others },
        leftAt: null,
        AND: [
          { OR: [{ mutedUntil: null }, { mutedUntil: { lt: ctx.now } }] },
          previous ? { lastReadAt: { gte: previous } } : {},
        ],
      },
      select: { userId: true },
    });
    if (fresh.length) {
      const sender = await ctx.tx.user.findUniqueOrThrow({
        where: { id: self },
        select: { name: true },
      });
      await notifyUsers(
        ctx.tx,
        fresh.map((f) => f.userId),
        {
          type: 'message.new',
          title: { key: 'notifications.text.messageNew', values: { name: sender.name } },
          body: input.body.slice(0, 300),
          url: `/messages/${conv.id}`,
          actorId: self,
          data: { conversationId: conv.id },
        },
      );
    }
    return { id: message.id };
  },
});

export const deleteMessage = defineOperation({
  name: 'message.delete',
  mutation: true,
  input: z.object({ id: z.string().uuid() }),
  async handler(ctx, { id }) {
    const self = me(ctx);
    const message = await ctx.tx.message.findUnique({ where: { id } });
    if (!message || message.deletedAt) throw new NotFoundError('Message');
    if (message.senderId !== self)
      throw new ForbiddenError(msg('errors.messaging.onlySenderDeletes'));
    await ctx.tx.message.update({ where: { id }, data: { deletedAt: ctx.now } });
    await publishRealtime(
      ctx.tx,
      await activeMemberIds(ctx.tx, message.conversationId),
      'message.new',
      {
        conversationId: message.conversationId,
        messageId: id,
        deleted: true,
      },
    );
    return { ok: true };
  },
});

export const markConversationRead = defineOperation({
  name: 'message.read',
  mutation: true,
  input: z.object({ conversationId: z.string().uuid() }),
  async handler(ctx, { conversationId }) {
    const self = me(ctx);
    await requireMember(ctx.tx, conversationId, self);
    await ctx.tx.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: self } },
      data: { lastReadAt: ctx.now },
    });
    await publishRealtime(ctx.tx, await activeMemberIds(ctx.tx, conversationId), 'message.read', {
      conversationId,
      userId: self,
    });
    return { ok: true };
  },
});

/** "Typing…" indicator: realtime only, never stored. */
export async function sendTyping(db: Db, userId: string, conversationId: string): Promise<void> {
  await requireMember(db, conversationId, userId);
  const others = (await activeMemberIds(db, conversationId)).filter((u) => u !== userId);
  if (!others.length) return;
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  await publishRealtime(db, others, 'typing', { conversationId, userId, name: u.name });
}

export const setConversationState = defineOperation({
  name: 'message.conversation.state',
  mutation: true,
  input: z.object({
    conversationId: z.string().uuid(),
    muted: z.boolean().optional(),
    archived: z.boolean().optional(),
    leave: z.boolean().optional(),
  }),
  async handler(ctx, input) {
    const self = me(ctx);
    const m = await requireMember(ctx.tx, input.conversationId, self);
    if (input.leave && m.conversation.kind !== 'GROUP') {
      throw new ValidationError({ leave: [msg('errors.messaging.onlyGroupsLeft')] });
    }
    if (input.leave && m.conversation.groupId) {
      throw new ValidationError({ leave: [msg('errors.messaging.courseGroupChat')] });
    }
    await ctx.tx.conversationMember.update({
      where: { conversationId_userId: { conversationId: input.conversationId, userId: self } },
      data: {
        ...(input.muted !== undefined
          ? { mutedUntil: input.muted ? new Date('9999-12-31T00:00:00Z') : null }
          : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? ctx.now : null } : {}),
        ...(input.leave ? { leftAt: ctx.now } : {}),
      },
    });
    return { ok: true };
  },
});

// ── blocking and privacy ──────────────────────────────────────────────────────

export const setUserBlocked = defineOperation({
  name: 'message.block',
  mutation: true,
  input: z.object({ userId: z.string().uuid(), blocked: z.boolean() }),
  async handler(ctx, input) {
    const self = me(ctx);
    if (input.userId === self)
      throw new ValidationError({ userId: [msg('errors.messaging.blockSelf')] });
    if (input.blocked) {
      await ctx.tx.userBlock.upsert({
        where: { userId_blockedUserId: { userId: self, blockedUserId: input.userId } },
        create: { userId: self, blockedUserId: input.userId },
        update: {},
      });
    } else {
      await ctx.tx.userBlock.deleteMany({ where: { userId: self, blockedUserId: input.userId } });
    }
    return { ok: true };
  },
});

export async function listBlockedUsers(db: Db, userId: string) {
  const rows = await db.userBlock.findMany({
    where: { userId },
    include: { blocked: { select: { id: true, name: true, image: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => r.blocked);
}

export const setMessagePrivacy = defineOperation({
  name: 'message.privacy',
  mutation: true,
  input: z.object({ privacy: z.enum(['ANYONE', 'COURSEMATES', 'NOBODY']) }),
  async handler(ctx, { privacy }) {
    await ctx.tx.user.update({ where: { id: me(ctx) }, data: { messagePrivacy: privacy } });
    return { ok: true };
  },
});

/** People the user may start a conversation with, matching a search string. */
export async function searchMessageableUsers(
  ctx: RequestContext,
  q: string,
): Promise<{ id: string; name: string; image: string | null }[]> {
  const self = me(ctx);
  const term = q.trim();
  if (term.length < 2) return [];
  const like = { contains: term, mode: Prisma.QueryMode.insensitive };
  const exact = { equals: term, mode: Prisma.QueryMode.insensitive };
  // by name; an address or login only whole, or a piece of one would tell it letter by
  // letter to someone who never sees addresses
  const candidates = await ctx.db.user.findMany({
    where: {
      id: { not: self },
      status: 'ACTIVE',
      kind: 'PERSON',
      OR: [{ name: like }, { email: exact }, { username: exact }],
    },
    select: { id: true, name: true, image: true },
    orderBy: { name: 'asc' },
    take: 40,
  });
  const out: { id: string; name: string; image: string | null }[] = [];
  for (const c of candidates) {
    if ((await canMessage(ctx.db, { id: self, isSiteAdmin: ctx.perm.isSiteAdmin }, c.id)).ok) {
      out.push(c);
    }
    if (out.length >= 15) break;
  }
  return out;
}

// Attachments are readable by current members of the message's conversation.
registerFileArea(MESSAGE_COMPONENT, 'attachment', async (ctx, file) => {
  const userId = ctx.perm.userId;
  if (!userId) return false;
  const message = await ctx.db.message.findUnique({
    where: { id: file.itemId },
    select: { conversationId: true, deletedAt: true },
  });
  if (!message || message.deletedAt) return false;
  const m = await ctx.db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: message.conversationId, userId } },
  });
  return !!m && !m.leftAt;
});
