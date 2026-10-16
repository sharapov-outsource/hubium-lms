import { type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { msg, renderMsg } from '@hubium/module-sdk';
import { parseCsv } from '@hubium/module-sdk/csv';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { unlockAccount } from '../auth/lockout.ts';
import { assertPasswordAllowed, recordPasswordChange } from '../auth/password-policy.ts';
import type { MutationContext, RequestContext } from '../context.ts';
import { assertCanAssignRole } from '../enrol/enrol.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { issueMsg } from '../issue-messages.ts';
import { SHEET_LIMITS } from '../lib/sheets.ts';
import { localeCode, optionalLocale, timeZone } from '../lib/zod.ts';
import { defineOperation, type Operation, parseInput } from '../operation.ts';
import { erasePersonalData } from '../privacy/privacy.ts';
import {
  CSV_PREFIX,
  FORM_PREFIX,
  listProfileFields,
  type ProfileValues,
  validateProfileValues,
  writeProfileValues,
} from './profile-fields.ts';

type Tx = Prisma.TransactionClient | Db;

export const USERNAME_RE = /^[a-z0-9._-]{3,50}$/;

export const UserCreateInput = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(USERNAME_RE, 'errors.field.username')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(128),
    locale: optionalLocale,
    timezone: timeZone.optional().or(z.literal('').transform(() => undefined)),
    isSiteAdmin: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
    /** Custom profile fields by short name (see profile-fields.ts). */
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.email || v.username, {
    message: 'errors.users.emailOrUsername',
    path: ['email'],
  });

export type UserCreate = z.input<typeof UserCreateInput>;

export function placeholderEmail(username: string): string {
  return `${username}@users.invalid`;
}

/**
 * Creates a user with a credential account. Used by admin UI, CSV upload and seed; the
 * seed skips the password policy (its passwords come from the environment).
 */
export async function createUserRecord(
  db: Tx,
  raw: UserCreate,
  opts: { passwordPolicy?: boolean } = {},
) {
  const input = UserCreateInput.parse(raw);
  if (opts.passwordPolicy !== false) await assertPasswordAllowed(db, input.password);
  const customFields: ProfileValues = input.customFields
    ? validateProfileValues(await listProfileFields(db), input.customFields)
    : {};
  const email = input.email ?? placeholderEmail(input.username!);
  const dupe = await db.user.findFirst({
    where: {
      OR: [{ email }, ...(input.username ? [{ username: input.username }] : [])],
    },
    select: { email: true, username: true },
  });
  if (dupe) {
    // without an email the address is a placeholder made from the username
    throw new ValidationError(
      input.email && dupe.email === email
        ? { email: [msg('errors.users.emailInUse')] }
        : { username: [msg('errors.users.usernameTaken')] },
    );
  }
  const user = await db.user.create({
    data: {
      email,
      emailPlaceholder: !input.email,
      emailVerified: input.emailVerified ?? false,
      username: input.username,
      displayUsername: input.username,
      name: `${input.firstName} ${input.lastName}`,
      firstName: input.firstName,
      lastName: input.lastName,
      locale: input.locale,
      timezone: input.timezone,
      isSiteAdmin: input.isSiteAdmin ?? false,
      mustChangePassword: input.mustChangePassword ?? false,
      customFields,
    },
  });
  await db.account.create({
    data: {
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await hashPassword(input.password),
    },
  });
  await recordPasswordChange(db, user.id);
  return user;
}

export const UserListInput = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export async function listUsers(ctx: RequestContext, raw: z.input<typeof UserListInput>) {
  await ctx.perm.require('user:update');
  const { q, status, page, pageSize } = UserListInput.parse(raw);
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    kind: 'PERSON',
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { username: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [total, items] = await Promise.all([
    ctx.db.user.count({ where }),
    ctx.db.user.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        emailPlaceholder: true,
        username: true,
        status: true,
        isSiteAdmin: true,
        lastLoginAt: true,
        createdAt: true,
        customFields: true,
      },
    }),
  ]);
  return { total, items, page, pageSize };
}

export const createUser = defineOperation({
  name: 'user.create',
  input: UserCreateInput,
  authorize: (ctx) => ctx.perm.require('user:create'),
  async handler(ctx, input) {
    if (input.isSiteAdmin && !ctx.perm.isSiteAdmin) {
      throw new ValidationError({ isSiteAdmin: [msg('errors.users.adminOnlyCreate')] });
    }
    const user = await createUserRecord(ctx.tx, {
      ...input,
      emailVerified: input.emailVerified ?? true,
    });
    await logEvent(ctx.tx, {
      name: 'user.created',
      actorId: ctx.perm.userId,
      relatedUserId: user.id,
      objectType: 'user',
      objectId: user.id,
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: user.id };
  },
});

export const UserUpdateInput = z.object({
  id: z.string().uuid(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  // a person without an email keeps none: the card sends their empty field
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  locale: localeCode.nullable().optional(),
  /** Null or empty: the site's zone. */
  timezone: timeZone
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  isSiteAdmin: z.boolean().optional(),
  password: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Custom profile fields to change, by short name; others keep their values. */
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export const updateUser = defineOperation({
  name: 'user.update',
  input: UserUpdateInput,
  authorize: (ctx) => ctx.perm.require('user:update'),
  async handler(ctx, input) {
    const user = await ctx.tx.user.findUnique({ where: { id: input.id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    // Managers may edit users but never a site admin (email/password would be a takeover).
    if (user.isSiteAdmin && !ctx.perm.isSiteAdmin)
      throw new ForbiddenError(msg('errors.users.adminOnlyEdit'));
    if (input.isSiteAdmin !== undefined && input.isSiteAdmin !== user.isSiteAdmin) {
      if (!ctx.perm.isSiteAdmin)
        throw new ValidationError({ isSiteAdmin: [msg('errors.users.adminOnly')] });
      if (user.id === ctx.perm.userId && !input.isSiteAdmin) {
        throw new ValidationError({ isSiteAdmin: [msg('errors.users.keepOwnAdmin')] });
      }
    }
    if (input.email && input.email !== user.email) {
      const taken = await ctx.tx.user.findUnique({ where: { email: input.email } });
      if (taken) throw new ValidationError({ email: [msg('errors.users.emailInUse')] });
    }
    const firstName = input.firstName ?? user.firstName;
    const lastName = input.lastName ?? user.lastName;
    await ctx.tx.user.update({
      where: { id: user.id },
      data: {
        firstName,
        lastName,
        name: `${firstName} ${lastName}`,
        ...(input.email ? { email: input.email, emailPlaceholder: false } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.isSiteAdmin !== undefined ? { isSiteAdmin: input.isSiteAdmin } : {}),
      },
    });
    if (input.customFields)
      await writeProfileValues(
        ctx.tx,
        user.id,
        validateProfileValues(await listProfileFields(ctx.tx), input.customFields),
      );
    if (input.password) {
      await setPassword(ctx.tx, user.id, input.password);
      // A password set by someone else signs the user out everywhere.
      if (user.id !== ctx.perm.userId)
        await ctx.tx.session.deleteMany({ where: { userId: user.id } });
    }
    await logEvent(ctx.tx, {
      name: 'user.updated',
      actorId: ctx.perm.userId,
      relatedUserId: user.id,
      origin: ctx.origin,
    });
    return { id: user.id };
  },
});

/** Sets a user's local password after checking it against the password policy. */
export async function setPassword(db: Tx, userId: string, password: string): Promise<void> {
  await assertPasswordAllowed(db, password, { userId });
  const hash = await hashPassword(password);
  const acc = await db.account.findFirst({ where: { userId, providerId: 'credential' } });
  if (acc) await db.account.update({ where: { id: acc.id }, data: { password: hash } });
  else
    await db.account.create({
      data: { userId, providerId: 'credential', accountId: userId, password: hash },
    });
  await recordPasswordChange(db, userId);
}

export const setUserSuspended = defineOperation({
  name: 'user.suspend',
  input: z.object({ id: z.string().uuid(), suspended: z.boolean() }),
  authorize: (ctx) => ctx.perm.require('user:update'),
  async handler(ctx, { id, suspended }) {
    if (id === ctx.perm.userId)
      throw new ValidationError({ id: [msg('errors.users.suspendSelf')] });
    const user = await ctx.tx.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.isSiteAdmin && !ctx.perm.isSiteAdmin)
      throw new ValidationError({ id: [msg('errors.users.suspendAdmin')] });
    await ctx.tx.user.update({
      where: { id },
      data: { status: suspended ? 'SUSPENDED' : 'ACTIVE' },
    });
    if (suspended) await ctx.tx.session.deleteMany({ where: { userId: id } });
    await logEvent(ctx.tx, {
      name: suspended ? 'user.suspended' : 'user.unsuspended',
      actorId: ctx.perm.userId,
      relatedUserId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

/** Lifts a lock after failed sign-ins (auth/lockout.ts). */
export const unlockUser = defineOperation({
  name: 'user.unlock',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('user:update'),
  async handler(ctx, { id }) {
    const user = await ctx.tx.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    await unlockAccount(ctx.tx, id);
    await logEvent(ctx.tx, {
      name: 'user.unlocked',
      actorId: ctx.perm.userId,
      relatedUserId: id,
      objectType: 'user',
      objectId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

/** Soft delete with anonymisation: content stays, personal data goes. */
export const deleteUser = defineOperation({
  name: 'user.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('user:delete'),
  async handler(ctx, { id }) {
    if (id === ctx.perm.userId) throw new ValidationError({ id: [msg('errors.users.deleteSelf')] });
    const user = await ctx.tx.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.isSiteAdmin) throw new ConflictError(msg('errors.users.adminBeforeDelete'));
    await ctx.tx.session.deleteMany({ where: { userId: id } });
    await ctx.tx.account.deleteMany({ where: { userId: id } });
    await erasePersonalData(ctx, ctx.tx, id);
    await ctx.tx.user.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: ctx.now,
        email: `deleted-${id}@users.invalid`,
        emailPlaceholder: true,
        username: null,
        displayUsername: null,
        name: 'Deleted user',
        firstName: 'Deleted',
        lastName: 'user',
        image: null,
        customFields: {},
        twoFactorEnabled: false,
      },
    });
    await logEvent(ctx.tx, {
      name: 'user.deleted',
      actorId: ctx.perm.userId,
      relatedUserId: id,
      origin: ctx.origin,
    });
    return { id };
  },
});

// ── system-level role assignment (manager, course creator) ─────────────────────

/** Gives or takes a role in a context the role may be given at, logged. */
async function setContextRole(
  ctx: MutationContext,
  opts: {
    userId: string;
    roleId: string;
    contextId: string;
    level: 'SYSTEM' | 'CATEGORY' | 'ACTIVITY';
    assigned: boolean;
  },
) {
  const { userId, roleId, contextId, assigned } = opts;
  const role = await ctx.tx.role.findUnique({ where: { id: roleId } });
  if (!role?.assignableLevels.includes(opts.level)) {
    const key = {
      SYSTEM: 'errors.users.roleNotForSite',
      CATEGORY: 'errors.users.roleNotForCategory',
      ACTIVITY: 'errors.users.roleNotForActivity',
    }[opts.level];
    throw new ValidationError({ roleId: [msg(key)] });
  }
  const user = await ctx.tx.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw new NotFoundError('User');
  // Granting and taking away follow the same rule (e.g. managers may not create managers).
  await assertCanAssignRole(ctx, contextId, roleId);
  const key = { userId, roleId, contextId, component: 'MANUAL' as const };
  if (assigned) {
    if (!(await ctx.tx.roleAssignment.findFirst({ where: key })))
      await ctx.tx.roleAssignment.create({ data: key });
  } else {
    await ctx.tx.roleAssignment.deleteMany({ where: key });
  }
  await logEvent(ctx.tx, {
    name: assigned ? 'role.assigned' : 'role.unassigned',
    actorId: ctx.perm.userId,
    relatedUserId: userId,
    contextId,
    data: { roleId },
    origin: ctx.origin,
  });
  return { ok: true };
}

export const assignSystemRole = defineOperation({
  name: 'user.assignSystemRole',
  input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid(), assigned: z.boolean() }),
  authorize: (ctx) => ctx.perm.require('role:assign'),
  handler: (ctx, input) =>
    setContextRole(ctx, { ...input, contextId: SYSTEM_CONTEXT_ID, level: 'SYSTEM' }),
});

/**
 * A role given in a category (a faculty's manager or course creators): it holds for the
 * categories and courses inside it.
 */
export const assignCategoryRole = defineOperation({
  name: 'user.assignCategoryRole',
  input: z.object({
    userId: z.string().uuid(),
    roleId: z.string().uuid(),
    categoryId: z.string().uuid(),
    assigned: z.boolean(),
  }),
  authorize: (ctx, i) => ctx.perm.require('role:assign', i.categoryId),
  async handler(ctx, { categoryId, ...input }) {
    if (!(await ctx.tx.category.findUnique({ where: { id: categoryId }, select: { id: true } })))
      throw new NotFoundError('Category');
    return setContextRole(ctx, { ...input, contextId: categoryId, level: 'CATEGORY' });
  },
});

/**
 * A role given in one activity to someone of its course (a learner who moderates a forum,
 * a teacher who marks one assignment only): it holds in that activity alone.
 */
export const assignActivityRole = defineOperation({
  name: 'user.assignActivityRole',
  input: z.object({
    userId: z.string().uuid(),
    roleId: z.string().uuid(),
    activityId: z.string().uuid(),
    assigned: z.boolean(),
  }),
  authorize: (ctx, i) => ctx.perm.require('role:assign', i.activityId),
  async handler(ctx, { activityId, ...input }) {
    const a = await ctx.tx.activity.findUnique({
      where: { id: activityId },
      select: { courseId: true, deletedAt: true },
    });
    if (!a || a.deletedAt) throw new NotFoundError('Activity');
    if (
      input.assigned &&
      !(await ctx.tx.enrolment.findFirst({
        where: { courseId: a.courseId, userId: input.userId },
        select: { id: true },
      }))
    )
      throw new ValidationError({ userId: [msg('errors.users.notInCourse')] });
    return setContextRole(ctx, { ...input, contextId: activityId, level: 'ACTIVITY' });
  },
});

/** Who holds the roles that may be given in an activity, there itself, by role. */
export async function activityRoleHolders(ctx: RequestContext, activityId: string) {
  return roleHoldersAt(ctx, activityId, 'ACTIVITY');
}

/** Who holds the roles that may be given in a category, there itself, by role. */
export async function categoryRoleHolders(ctx: RequestContext, categoryId: string) {
  return roleHoldersAt(ctx, categoryId, 'CATEGORY');
}

async function roleHoldersAt(
  ctx: RequestContext,
  contextId: string,
  level: 'CATEGORY' | 'ACTIVITY',
) {
  await ctx.perm.require('role:review', contextId);
  const roles = await ctx.db.role.findMany({
    where: { assignableLevels: { has: level } },
    orderBy: { sortOrder: 'asc' },
  });
  const held = await ctx.db.roleAssignment.findMany({
    where: { contextId, roleId: { in: roles.map((r) => r.id) }, component: 'MANUAL' },
    select: { roleId: true, user: { select: { id: true, name: true, deletedAt: true } } },
    orderBy: { user: { lastName: 'asc' } },
  });
  return roles.map((role) => ({
    role,
    users: held
      .filter((h) => h.roleId === role.id && !h.user.deletedAt)
      .map((h) => ({ id: h.user.id, name: h.user.name })),
  }));
}

// ── CSV bulk upload ────────────────────────────────────────────────────────────

export { parseCsv };

export interface BulkUploadResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

/** The status column of a user export: suspended or not. */
const STATUSES: Record<string, boolean> = { active: false, suspended: true };

/** An operation's checks and work in a transaction the caller holds (a row of an upload). */
async function runIn<I extends z.ZodType, O>(
  op: Operation<I, O>,
  ctx: MutationContext,
  raw: unknown,
): Promise<O> {
  const input = parseInput(op.input, raw);
  await op.authorize?.(ctx, input);
  return op.handler(ctx, input);
}

/**
 * Users from a sheet (CSV text, or the rows of a CSV, XLSX or ODS file): a row whose username
 * (or, without one, email) is a user's already updates that user, so a user export edited in
 * a spreadsheet can be uploaded again; any other row creates one.
 */
export const bulkUploadUsers = defineOperation({
  name: 'user.bulkUpload',
  input: z.union([
    z.object({ csv: z.string().min(1).max(5_000_000) }),
    z.object({
      rows: z
        .array(z.array(z.string()))
        .min(1)
        .max(SHEET_LIMITS.rows + 1),
    }),
  ]),
  authorize: (ctx) => ctx.perm.require('user:create'),
  mutation: false,
  async handler(ctx, input): Promise<BulkUploadResult> {
    const [first, ...rows] = 'rows' in input ? input.rows : parseCsv(input.csv);
    const header = (first ?? []).map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const required = ['firstname', 'lastname'];
    const missing = required.filter((r) => col(r) < 0);
    if (missing.length || (col('email') < 0 && col('username') < 0)) {
      throw new ValidationError({
        csv: [msg('errors.users.usersHeader')],
      });
    }
    // profile_field_<shortname> columns fill custom profile fields
    const fields = new Set((await listProfileFields(ctx.db)).map((f) => f.shortName));
    const custom = header.filter((h) => h.startsWith(CSV_PREFIX));
    const unknown = custom.filter((h) => !fields.has(h.slice(CSV_PREFIX.length)));
    if (unknown.length)
      throw new ValidationError({
        csv: [msg('errors.auth.unknownProfileFields', { unknown: unknown.join(', ') })],
      });
    const result: BulkUploadResult = { created: 0, updated: 0, errors: [] };
    for (const [i, r] of rows.entries()) {
      // a sheet keeps its empty rows, so that line numbers are the sheet's
      if (r.every((c) => !c.trim())) continue;
      const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : undefined);
      const customFields = Object.fromEntries(
        custom.map((h) => [h.slice(CSV_PREFIX.length), get(h) ?? '']),
      );
      try {
        const status = get('status')?.toLowerCase();
        if (status && !(status in STATUSES))
          throw new ValidationError({ status: [msg('errors.users.statusValue')] });
        const username = get('username')?.toLowerCase();
        const email = get('email')?.toLowerCase();
        const existing =
          username || email
            ? await ctx.db.user.findFirst({
                where: { deletedAt: null, ...(username ? { username } : { email }) },
                select: { id: true, status: true },
              })
            : null;
        const must = get('mustchangepassword');
        await ctx.db.$transaction(async (tx) => {
          if (existing) {
            const c = { ...ctx, tx };
            // empty cells keep what the user has
            await runIn(updateUser, c, {
              id: existing.id,
              firstName: get('firstname') || undefined,
              lastName: get('lastname') || undefined,
              email: get('email') || undefined,
              locale: get('lang') || undefined,
              ...(custom.length ? { customFields } : {}),
              password: get('password') || undefined,
            });
            if (must === '1' || must === '0')
              await tx.user.update({
                where: { id: existing.id },
                data: { mustChangePassword: must === '1' },
              });
            const suspended = status ? STATUSES[status] : undefined;
            if (suspended !== undefined && suspended !== (existing.status === 'SUSPENDED'))
              await runIn(setUserSuspended, c, { id: existing.id, suspended });
            return;
          }
          if (!get('password'))
            throw new ValidationError({ password: [msg('errors.users.passwordForNew')] });
          const user = await createUserRecord(tx, {
            email: get('email'),
            username: get('username'),
            firstName: get('firstname') ?? '',
            lastName: get('lastname') ?? '',
            password: get('password') ?? '',
            locale: get('lang') || undefined,
            emailVerified: true,
            mustChangePassword: must === '1',
            customFields,
          });
          if (status === 'suspended')
            await tx.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
          await logEvent(tx, {
            name: 'user.created',
            actorId: ctx.perm.userId,
            relatedUserId: user.id,
            data: { source: 'csv' },
            origin: ctx.origin,
          });
        });
        if (existing) result.updated++;
        else result.created++;
      } catch (e) {
        const message =
          e instanceof ValidationError
            ? Object.entries(e.in(ctx.locale).fieldErrors ?? {})
                .map(([k, v]) =>
                  k.startsWith(FORM_PREFIX)
                    ? `${CSV_PREFIX}${k.slice(FORM_PREFIX.length)}: ${v.join(', ')}`
                    : v.join('; '),
                )
                .join('; ')
            : e instanceof z.ZodError
              ? e.issues
                  .map((x) => `${x.path.join('.')}: ${renderMsg(issueMsg(x), ctx.locale)}`)
                  .join('; ')
              : e instanceof AppError
                ? e.in(ctx.locale).message
                : String(e);
        result.errors.push({ line: i + 2, message });
      }
    }
    return result;
  },
});
