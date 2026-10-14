import { type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { assertPasswordAllowed, recordPasswordChange } from '../auth/password-policy.ts';
import type { RequestContext } from '../context.ts';
import { assertCanAssignRole } from '../enrol/enrol.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { localeCode, optionalLocale } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
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
      .regex(USERNAME_RE, 'username: 3–50 chars, a-z 0-9 . _ -')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(128),
    locale: optionalLocale,
    timezone: z
      .string()
      .trim()
      .max(64)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    isSiteAdmin: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
    /** Custom profile fields by short name (see profile-fields.ts). */
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.email || v.username, {
    message: 'Email or username is required',
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
        ? { email: ['Email already in use'] }
        : { username: ['Username taken'] },
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
      throw new ValidationError({ isSiteAdmin: ['Only site admins can create site admins'] });
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
  email: z.string().trim().toLowerCase().email().optional(),
  locale: localeCode.nullable().optional(),
  timezone: z.string().nullable().optional(),
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
      throw new ForbiddenError('Only site admins can edit an admin account');
    if (input.isSiteAdmin !== undefined && input.isSiteAdmin !== user.isSiteAdmin) {
      if (!ctx.perm.isSiteAdmin) throw new ValidationError({ isSiteAdmin: ['Only site admins'] });
      if (user.id === ctx.perm.userId && !input.isSiteAdmin) {
        throw new ValidationError({ isSiteAdmin: ['You cannot remove your own admin rights'] });
      }
    }
    if (input.email && input.email !== user.email) {
      const taken = await ctx.tx.user.findUnique({ where: { email: input.email } });
      if (taken) throw new ValidationError({ email: ['Email already in use'] });
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
    if (id === ctx.perm.userId) throw new ValidationError({ id: ['You cannot suspend yourself'] });
    const user = await ctx.tx.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.isSiteAdmin && !ctx.perm.isSiteAdmin)
      throw new ValidationError({ id: ['Cannot suspend an admin'] });
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

/** Soft delete with anonymisation: content stays, personal data goes. */
export const deleteUser = defineOperation({
  name: 'user.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: (ctx) => ctx.perm.require('user:delete'),
  async handler(ctx, { id }) {
    if (id === ctx.perm.userId) throw new ValidationError({ id: ['You cannot delete yourself'] });
    const user = await ctx.tx.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    if (user.isSiteAdmin) throw new ConflictError('Remove admin rights before deleting');
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

export const assignSystemRole = defineOperation({
  name: 'user.assignSystemRole',
  input: z.object({ userId: z.string().uuid(), roleId: z.string().uuid(), assigned: z.boolean() }),
  authorize: (ctx) => ctx.perm.require('role:assign'),
  async handler(ctx, { userId, roleId, assigned }) {
    const role = await ctx.tx.role.findUnique({ where: { id: roleId } });
    if (!role?.assignableLevels.includes('SYSTEM')) {
      throw new ValidationError({ roleId: ['Role cannot be assigned at site level'] });
    }
    const user = await ctx.tx.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundError('User');
    // Granting and taking away follow the same rule (e.g. managers may not create managers).
    await assertCanAssignRole(ctx, SYSTEM_CONTEXT_ID, roleId);
    const key = { userId, roleId, contextId: SYSTEM_CONTEXT_ID, component: 'MANUAL' as const };
    if (assigned) {
      if (!(await ctx.tx.roleAssignment.findFirst({ where: key })))
        await ctx.tx.roleAssignment.create({ data: key });
    } else {
      await ctx.tx.roleAssignment.deleteMany({
        where: { userId, roleId, contextId: SYSTEM_CONTEXT_ID, component: 'MANUAL' },
      });
    }
    await logEvent(ctx.tx, {
      name: assigned ? 'role.assigned' : 'role.unassigned',
      actorId: ctx.perm.userId,
      relatedUserId: userId,
      contextId: SYSTEM_CONTEXT_ID,
      data: { roleId },
      origin: ctx.origin,
    });
    return { ok: true };
  },
});

// ── CSV bulk upload ────────────────────────────────────────────────────────────

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). Separator auto-detected (, or ;). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export interface BulkUploadResult {
  created: number;
  errors: { line: number; message: string }[];
}

export const bulkUploadUsers = defineOperation({
  name: 'user.bulkUpload',
  input: z.object({ csv: z.string().min(1).max(5_000_000) }),
  authorize: (ctx) => ctx.perm.require('user:create'),
  mutation: false,
  async handler(ctx, { csv }): Promise<BulkUploadResult> {
    const rows = parseCsv(csv);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    const required = ['firstname', 'lastname', 'password'];
    const missing = required.filter((r) => col(r) < 0);
    if (missing.length || (col('email') < 0 && col('username') < 0)) {
      throw new ValidationError({
        csv: [`Header must include: firstname, lastname, password and email or username`],
      });
    }
    // profile_field_<shortname> columns fill custom profile fields
    const fields = new Set((await listProfileFields(ctx.db)).map((f) => f.shortName));
    const custom = header.filter((h) => h.startsWith(CSV_PREFIX));
    const unknown = custom.filter((h) => !fields.has(h.slice(CSV_PREFIX.length)));
    if (unknown.length)
      throw new ValidationError({ csv: [`Unknown profile fields: ${unknown.join(', ')}`] });
    const result: BulkUploadResult = { created: 0, errors: [] };
    for (const [i, r] of rows.entries()) {
      const get = (n: string) => (col(n) >= 0 ? (r[col(n)] ?? '').trim() : undefined);
      const customFields = Object.fromEntries(
        custom.map((h) => [h.slice(CSV_PREFIX.length), get(h) ?? '']),
      );
      try {
        await ctx.db.$transaction(async (tx) => {
          const user = await createUserRecord(tx, {
            email: get('email'),
            username: get('username'),
            firstName: get('firstname') ?? '',
            lastName: get('lastname') ?? '',
            password: get('password') ?? '',
            locale: get('lang') || undefined,
            emailVerified: true,
            mustChangePassword: get('mustchangepassword') === '1',
            customFields,
          });
          await logEvent(tx, {
            name: 'user.created',
            actorId: ctx.perm.userId,
            relatedUserId: user.id,
            data: { source: 'csv' },
            origin: ctx.origin,
          });
        });
        result.created++;
      } catch (e) {
        const message =
          e instanceof ValidationError
            ? Object.entries(e.fieldErrors ?? {})
                .map(([k, v]) =>
                  k.startsWith(FORM_PREFIX)
                    ? `${CSV_PREFIX}${k.slice(FORM_PREFIX.length)}: ${v.join(', ')}`
                    : v.join('; '),
                )
                .join('; ')
            : e instanceof z.ZodError
              ? e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')
              : String(e);
        result.errors.push({ line: i + 2, message });
      }
    }
    return result;
  },
});
