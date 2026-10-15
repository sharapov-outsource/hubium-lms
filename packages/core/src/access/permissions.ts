import { type Db, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { type Capability, capabilities, getCapability } from './capabilities.ts';
import {
  type ActorAccess,
  type Explanation,
  explain,
  type OverridePerm,
  overrideKey,
  type RoleDefinitions,
  type RolePerm,
} from './resolve.ts';

// DB-backed permission checks. Role definitions and context chains are cached in process
// memory; `invalidatePermissionCaches()` is called on the `hubium_cache` NOTIFY channel.

let roleDefsPromise: Promise<RoleDefinitions & { byShortName: Map<string, string> }> | undefined;
const chainCache = new Map<string, readonly string[]>();
const CHAIN_CACHE_MAX = 5000;

export function invalidatePermissionCaches(what: 'roles' | 'contexts' | 'all' = 'all'): void {
  if (what !== 'contexts') roleDefsPromise = undefined;
  if (what !== 'roles') chainCache.clear();
}

export async function loadRoleDefinitions(db: Db) {
  roleDefsPromise ??= (async () => {
    const [roles, caps, overrides] = await Promise.all([
      db.role.findMany({ select: { id: true, shortName: true } }),
      db.roleCapability.findMany(),
      db.roleOverride.findMany(),
    ]);
    const defs: RoleDefinitions & { byShortName: Map<string, string> } = {
      caps: new Map(),
      overrides: new Map(),
      byShortName: new Map(roles.map((r) => [r.shortName, r.id])),
    };
    for (const c of caps) {
      if (!defs.caps.has(c.roleId)) defs.caps.set(c.roleId, new Map());
      defs.caps.get(c.roleId)!.set(c.capability, c.permission as RolePerm);
    }
    for (const o of overrides) {
      const k = overrideKey(o.contextId, o.roleId);
      if (!defs.overrides.has(k)) defs.overrides.set(k, new Map());
      defs.overrides.get(k)!.set(o.capability, o.permission as OverridePerm);
    }
    return defs;
  })().catch((e) => {
    roleDefsPromise = undefined;
    throw e;
  });
  return roleDefsPromise;
}

export async function getContextChain(db: Db, contextId: string): Promise<readonly string[]> {
  const hit = chainCache.get(contextId);
  if (hit) return hit;
  const ctx = await db.context.findUnique({
    where: { id: contextId },
    select: { id: true, ancestorIds: true },
  });
  if (!ctx) throw new NotFoundError('Context');
  const chain = [...ctx.ancestorIds, ctx.id];
  if (chainCache.size >= CHAIN_CACHE_MAX) chainCache.clear();
  chainCache.set(contextId, chain);
  return chain;
}

export interface UserIdentity {
  id: string;
  isSiteAdmin: boolean;
}

/** Loads all role assignments for a user once per request. */
export async function loadUserAccess(
  db: Db,
  user: UserIdentity,
  opts: {
    now?: Date;
    scopes?: string[];
    switchedRole?: { roleId: string; contextId: string };
  } = {},
): Promise<ActorAccess> {
  const now = opts.now ?? new Date();
  const [defs, assignments, guestCourses] = await Promise.all([
    loadRoleDefinitions(db),
    db.roleAssignment.findMany({
      where: { userId: user.id },
      select: { roleId: true, contextId: true, component: true, enrolmentId: true },
    }),
    db.course.findMany({ where: { guestAccess: true, deletedAt: null }, select: { id: true } }),
  ]);

  const enrolmentIds = assignments.map((a) => a.enrolmentId).filter((x): x is string => !!x);
  const enrolments = enrolmentIds.length
    ? await db.enrolment.findMany({
        where: { id: { in: enrolmentIds } },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          method: { select: { enabled: true } },
        },
      })
    : [];
  const activeEnrolment = new Map(
    enrolments.map((e) => [
      e.id,
      e.status === 'ACTIVE' &&
        e.method.enabled &&
        (!e.startsAt || e.startsAt <= now) &&
        (!e.endsAt || e.endsAt > now),
    ]),
  );

  return {
    kind: opts.scopes ? 'token' : 'user',
    userId: user.id,
    isSiteAdmin: user.isSiteAdmin,
    assignments: assignments.map((a) => ({
      roleId: a.roleId,
      contextId: a.contextId,
      active: a.enrolmentId ? (activeEnrolment.get(a.enrolmentId) ?? false) : true,
    })),
    userRoleId: defs.byShortName.get('user'),
    guestRoleId: defs.byShortName.get('guest'),
    guestContextIds: guestCourses.map((c) => c.id),
    scopes: opts.scopes,
    switchedRole: opts.switchedRole,
  };
}

export async function anonymousAccess(db: Db): Promise<ActorAccess> {
  const defs = await loadRoleDefinitions(db);
  return { kind: 'anonymous', guestRoleId: defs.byShortName.get('guest') };
}

/** Per-request permission helper bound to one actor. */
export class Permissions {
  constructor(
    private readonly db: Db,
    readonly access: ActorAccess,
  ) {}

  async explain(cap: Capability, contextId: string = SYSTEM_CONTEXT_ID): Promise<Explanation> {
    const def = getCapability(cap);
    const [chain, defs] = await Promise.all([
      getContextChain(this.db, contextId),
      loadRoleDefinitions(this.db),
    ]);
    return explain({ actor: this.access, cap, def, chain, defs });
  }

  async can(cap: Capability, contextId: string = SYSTEM_CONTEXT_ID): Promise<boolean> {
    return (await this.explain(cap, contextId)).result;
  }

  async require(cap: Capability, contextId: string = SYSTEM_CONTEXT_ID): Promise<void> {
    if (!(await this.can(cap, contextId))) {
      throw new ForbiddenError(`Missing capability ${cap}`, { capability: cap, contextId });
    }
  }

  async canAny(caps: Capability[], contextId?: string): Promise<boolean> {
    for (const c of caps) if (await this.can(c, contextId)) return true;
    return false;
  }

  get isSiteAdmin(): boolean {
    return (
      this.access.kind !== 'anonymous' && this.access.kind !== 'system' && this.access.isSiteAdmin
    );
  }

  get userId(): string | undefined {
    return this.access.kind === 'user' || this.access.kind === 'token'
      ? this.access.userId
      : undefined;
  }
}

/**
 * Roles (ids) that would be allowed `cap` at the context, independent of the user.
 * Feeds "users with capability" queries without looping can().
 */
export async function rolesWithCap(db: Db, cap: Capability, contextId: string): Promise<string[]> {
  const def = getCapability(cap);
  const [chain, defs] = await Promise.all([
    getContextChain(db, contextId),
    loadRoleDefinitions(db),
  ]);
  const out: string[] = [];
  for (const roleId of defs.byShortName.values()) {
    const r = explain({
      actor: {
        kind: 'user',
        userId: '',
        isSiteAdmin: false,
        assignments: [{ roleId, contextId: chain[0]!, active: true }],
      },
      cap,
      def,
      chain,
      defs,
    });
    if (r.result) out.push(roleId);
  }
  return out;
}

/** Active users in a course holding a capability (optionally limited to a group). */
export async function usersWithCap(
  db: Db,
  cap: Capability,
  courseId: string,
  opts: { groupId?: string; contextId?: string } = {},
): Promise<string[]> {
  const contextId = opts.contextId ?? courseId;
  const roleIds = await rolesWithCap(db, cap, contextId);
  if (!roleIds.length) return [];
  const chain = await getContextChain(db, contextId);
  const now = new Date();
  const rows = await db.roleAssignment.findMany({
    where: {
      roleId: { in: roleIds },
      contextId: { in: [...chain] },
      user: {
        status: 'ACTIVE',
        ...(opts.groupId ? { groupMembers: { some: { groupId: opts.groupId } } } : {}),
      },
      OR: [
        { enrolmentId: null },
        {
          enrolmentId: { not: null },
          user: {
            enrolments: {
              some: {
                courseId,
                status: 'ACTIVE',
                method: { enabled: true },
                AND: [
                  { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                  { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
                ],
              },
            },
          },
        },
      ],
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return allowedAmong(
    db,
    rows.map((r) => r.userId),
    cap,
    chain,
    now,
  );
}

/**
 * Those of `userIds` whom can() would allow `cap` along `chain`, from their own assignments:
 * a PROHIBIT from another of their roles leaves them out, and a role given by an enrolment
 * counts only while that enrolment is active.
 */
async function allowedAmong(
  db: Db,
  userIds: string[],
  cap: Capability,
  chain: readonly string[],
  now: Date,
): Promise<string[]> {
  if (!userIds.length) return [];
  const [defs, assignments] = await Promise.all([
    loadRoleDefinitions(db),
    db.roleAssignment.findMany({
      where: { userId: { in: userIds }, contextId: { in: [...chain] } },
      select: { userId: true, roleId: true, contextId: true, enrolmentId: true },
    }),
  ]);
  const enrolmentIds = [
    ...new Set(assignments.flatMap((a) => (a.enrolmentId ? [a.enrolmentId] : []))),
  ];
  const enrolments = enrolmentIds.length
    ? await db.enrolment.findMany({
        where: { id: { in: enrolmentIds } },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          method: { select: { enabled: true } },
        },
      })
    : [];
  const active = new Set(
    enrolments
      .filter(
        (e) =>
          e.status === 'ACTIVE' &&
          e.method.enabled &&
          (!e.startsAt || e.startsAt <= now) &&
          (!e.endsAt || e.endsAt > now),
      )
      .map((e) => e.id),
  );
  const def = getCapability(cap);
  return userIds.filter(
    (userId) =>
      explain({
        actor: {
          kind: 'user',
          userId,
          isSiteAdmin: false,
          assignments: assignments
            .filter((a) => a.userId === userId)
            .map((a) => ({
              roleId: a.roleId,
              contextId: a.contextId,
              active: a.enrolmentId ? active.has(a.enrolmentId) : true,
            })),
          userRoleId: defs.byShortName.get('user'),
        },
        cap,
        def,
        chain,
        defs,
      }).result,
  );
}

export { capabilities };
