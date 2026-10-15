import type { Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import { csvFile } from '@hubium/module-sdk/csv';
import { z } from 'zod';
import { userContext } from '../ai/user-ctx.ts';
import type { RequestContext } from '../context.ts';
import { enrolUsers } from '../enrol/enrol.ts';
import { AppError, ValidationError } from '../errors.ts';
import { setCohortMembers } from '../groups/groups.ts';
import { enqueue } from '../jobs/jobs.ts';
import { writeOds } from '../lib/sheets.ts';
import { writeXlsx } from '../lib/xlsx.ts';
import { openDirectConversation, sendMessage } from '../messaging/messaging.ts';
import { notifyUsers, registerNotificationType } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { listProfileFields, profileValueText } from './profile-fields.ts';
import { deleteUser, setUserSuspended, unlockUser } from './users.ts';

const logger = log('users');

// Bulk user actions (Moodle's "Bulk user actions"): the people ticked in the user list, or
// everyone the list's filter finds. Each person goes through the same operation as one by
// one, so every check, event and notification applies; a refusal for one person is
// reported and the rest go on. Up to SYNC_LIMIT people are done at once, more in the
// background with a notification when done.

export const BULK_USERS_JOB = 'users.bulk';
export const BULK_DONE = 'admin.bulkDone';
registerNotificationType(BULK_DONE, { email: 'OFF' });

const SYNC_LIMIT = 100;

export const UserFilter = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
export type UserFilter = z.infer<typeof UserFilter>;

export function userFilterWhere(f: UserFilter): Prisma.UserWhereInput {
  return {
    deletedAt: null,
    kind: 'PERSON',
    ...(f.status ? { status: f.status } : {}),
    ...(f.q
      ? {
          OR: [
            { name: { contains: f.q, mode: 'insensitive' } },
            { email: { contains: f.q, mode: 'insensitive' } },
            { username: { contains: f.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const BulkSelection = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(10_000) }),
  z.object({ filter: UserFilter }),
]);

export const BulkAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('suspend') }),
  z.object({ kind: z.literal('activate') }),
  z.object({ kind: z.literal('delete') }),
  z.object({ kind: z.literal('forcePasswordChange') }),
  z.object({ kind: z.literal('unlock') }),
  z.object({ kind: z.literal('addToCohort'), cohortId: z.string().uuid() }),
  z.object({
    kind: z.literal('enrol'),
    courseId: z.string().uuid(),
    roleId: z.string().uuid(),
  }),
  z.object({ kind: z.literal('message'), body: z.string().trim().min(1).max(10_000) }),
]);
export type BulkAction = z.infer<typeof BulkAction>;

export interface BulkResult {
  total: number;
  done: number;
  failed: { userId: string; name: string; error: string }[];
}

async function selectedIds(ctx: RequestContext, sel: z.infer<typeof BulkSelection>) {
  const where =
    'ids' in sel ? { id: { in: sel.ids }, deletedAt: null } : userFilterWhere(sel.filter);
  const rows = await ctx.db.user.findMany({
    where,
    select: { id: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  return rows.map((r) => r.id);
}

/** The capability an action needs besides user:update. */
async function authorizeAction(ctx: RequestContext, a: BulkAction) {
  await ctx.perm.require('user:update');
  if (a.kind === 'delete') await ctx.perm.require('user:delete');
  if (a.kind === 'addToCohort') await ctx.perm.require('cohort:manage');
  if (a.kind === 'enrol') await ctx.perm.require('enrol:manage', a.courseId);
  if (a.kind === 'message') await ctx.perm.require('message:send');
}

async function applyOne(ctx: RequestContext, userId: string, a: BulkAction) {
  switch (a.kind) {
    case 'suspend':
    case 'activate':
      await setUserSuspended.run(ctx, { id: userId, suspended: a.kind === 'suspend' });
      return;
    case 'delete':
      await deleteUser.run(ctx, { id: userId });
      return;
    case 'unlock':
      await unlockUser.run(ctx, { id: userId });
      return;
    case 'forcePasswordChange': {
      const u = await ctx.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { isSiteAdmin: true },
      });
      if (u.isSiteAdmin && !ctx.perm.isSiteAdmin)
        throw new ValidationError({ id: ['Only site admins can change an admin account'] });
      const hasPassword = await ctx.db.account.count({
        where: { userId, providerId: 'credential', password: { not: null } },
      });
      if (!hasPassword) throw new ValidationError({ id: ['No local password'] });
      await ctx.db.user.update({ where: { id: userId }, data: { mustChangePassword: true } });
      return;
    }
    case 'addToCohort':
      await setCohortMembers.run(ctx, { cohortId: a.cohortId, add: [userId] });
      return;
    case 'enrol':
      await enrolUsers.run(ctx, { courseId: a.courseId, roleId: a.roleId, userIds: [userId] });
      return;
    case 'message': {
      const { id } = await openDirectConversation.run(ctx, { userId });
      await sendMessage.run(ctx, { conversationId: id, body: a.body });
      return;
    }
  }
}

/** Applies the action to each person; refusals are collected, not thrown. */
export async function runBulkUserAction(
  ctx: RequestContext,
  ids: string[],
  action: BulkAction,
): Promise<BulkResult> {
  await authorizeAction(ctx, action);
  const result: BulkResult = { total: ids.length, done: 0, failed: [] };
  for (const userId of ids) {
    try {
      await applyOne(ctx, userId, action);
      result.done++;
    } catch (e) {
      const user = await ctx.db.user.findUnique({ where: { id: userId }, select: { name: true } });
      const error =
        e instanceof AppError
          ? (Object.values(e.fieldErrors ?? {}).flat()[0] ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e);
      if (!(e instanceof AppError)) logger.error({ err: e, userId }, 'bulk user action failed');
      result.failed.push({ userId, name: user?.name ?? userId, error });
    }
  }
  return result;
}

export const startBulkUserAction = defineOperation({
  name: 'user.bulk',
  input: z.object({ selection: BulkSelection, action: BulkAction }),
  mutation: false,
  authorize: (ctx, i) => authorizeAction(ctx, i.action),
  async handler(ctx, { selection, action }) {
    const ids = await selectedIds(ctx, selection);
    if (!ids.length) throw new ValidationError({ selection: ['Nobody is selected'] });
    if (ids.length <= SYNC_LIMIT)
      return { queued: false as const, result: await runBulkUserAction(ctx, ids, action) };
    await enqueue(BULK_USERS_JOB, { actorId: ctx.perm.userId!, ids, action });
    return { queued: true as const, total: ids.length };
  },
});

/** The background job: runs as the person who started it and tells them the outcome. */
export async function runBulkUsersJob(
  db: Parameters<typeof userContext>[0],
  data: { actorId: string; ids: string[]; action: BulkAction },
) {
  const ctx = await userContext(db, data.actorId);
  const r = await runBulkUserAction(ctx, data.ids, BulkAction.parse(data.action));
  await db.$transaction((tx) =>
    notifyUsers(tx, [data.actorId], {
      type: BULK_DONE,
      title: { key: 'notifications.bulkDone.title' },
      body: {
        key: 'notifications.bulkDone.body',
        values: { done: r.done, total: r.total, failed: r.failed.length },
      },
      url: '/admin/users',
      data: { failed: r.failed.slice(0, 50) },
    }),
  );
  return { done: r.done, failed: r.failed.length };
}

// ── export ──────────────────────────────────────────────────────────────────

/**
 * The selected people in the columns of the CSV upload (plus status and last sign-in), so
 * an export edited in a spreadsheet can be uploaded again.
 */
export async function exportUsers(
  ctx: RequestContext,
  sel: z.input<typeof BulkSelection>,
  format: 'csv' | 'xlsx' | 'ods',
): Promise<string | Uint8Array> {
  await ctx.perm.require('user:update');
  const ids = await selectedIds(ctx, BulkSelection.parse(sel));
  const fields = await listProfileFields(ctx.db);
  const users = await ctx.db.user.findMany({
    where: { id: { in: ids } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      username: true,
      email: true,
      emailPlaceholder: true,
      firstName: true,
      lastName: true,
      locale: true,
      status: true,
      lastLoginAt: true,
      customFields: true,
    },
  });
  const header = [
    'username',
    'email',
    'firstname',
    'lastname',
    'lang',
    'status',
    'lastlogin',
    ...fields.map((f) => `profile_field_${f.shortName}`),
  ];
  const rows = users.map((u) => {
    const custom = (u.customFields ?? {}) as Record<string, string | boolean>;
    return [
      u.username ?? '',
      u.emailPlaceholder ? '' : u.email,
      u.firstName,
      u.lastName,
      u.locale ?? '',
      u.status.toLowerCase(),
      u.lastLoginAt?.toISOString() ?? '',
      ...fields.map((f) => profileValueText(custom[f.shortName])),
    ];
  });
  if (format === 'xlsx') return writeXlsx([header, ...rows], 'Users');
  if (format === 'ods') return writeOds([header, ...rows], 'Users');
  return csvFile([header, ...rows]);
}
