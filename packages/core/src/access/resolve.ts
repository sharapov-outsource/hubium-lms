import type { Capability, CapabilityDef } from './capabilities.ts';

// Pure capability resolution. No I/O: callers load the data (see ./permissions.ts),
// which keeps the rules unit-testable. Algorithm: docs/architecture.md §3.4.

export type RolePerm = 'ALLOW' | 'PROHIBIT';
export type OverridePerm = 'ALLOW' | 'DENY' | 'PROHIBIT';

export interface RoleDefinitions {
  /** roleId → capability → permission */
  caps: Map<string, Map<string, RolePerm>>;
  /** `${contextId}|${roleId}` → capability → permission */
  overrides: Map<string, Map<string, OverridePerm>>;
}

export interface Assignment {
  roleId: string;
  contextId: string;
  /** False when the backing enrolment is suspended or outside its time window. */
  active: boolean;
}

export type ActorAccess =
  | { kind: 'system' }
  | { kind: 'anonymous'; guestRoleId?: string }
  | {
      kind: 'user' | 'token';
      userId: string;
      isSiteAdmin: boolean;
      assignments: Assignment[];
      /** Implicit "authenticated user" role, assigned at the system context. */
      userRoleId?: string;
      /** Implicit guest role for non-enrolled users on guest-access courses. */
      guestRoleId?: string;
      guestContextIds?: string[];
      /** Token scopes; '*' or 'prefix:*' wildcards. Only for kind 'token'. */
      scopes?: string[];
      /** "View as role": only this role, at this course context. */
      switchedRole?: { roleId: string; contextId: string };
    };

export function overrideKey(contextId: string, roleId: string): string {
  return `${contextId}|${roleId}`;
}

export function scopeAllows(scopes: readonly string[], cap: string): boolean {
  for (const s of scopes) {
    if (s === '*' || s === cap) return true;
    if (s.endsWith(':*') && cap.startsWith(s.slice(0, -1))) return true;
  }
  return false;
}

export interface ResolveInput {
  actor: ActorAccess;
  cap: Capability | string;
  def: CapabilityDef;
  /** Context chain root → leaf, including the target context. */
  chain: readonly string[];
  defs: RoleDefinitions;
}

export interface Explanation {
  result: boolean;
  reason:
    | 'system'
    | 'site-admin'
    | 'token-scope'
    | 'no-roles'
    | 'prohibit-role'
    | 'prohibit-override'
    | 'allowed'
    | 'not-allowed';
  roles: {
    roleId: string;
    at: string;
    base?: RolePerm;
    final?: OverridePerm | RolePerm;
    via?: string;
  }[];
}

/** Roles that apply to the actor anywhere in the chain. */
function rolesInChain(
  actor: ActorAccess,
  chain: readonly string[],
): { roleId: string; at: string }[] {
  if (actor.kind === 'system') return [];
  const leaf = chain[chain.length - 1] ?? '';
  if (actor.kind === 'anonymous') {
    return actor.guestRoleId ? [{ roleId: actor.guestRoleId, at: leaf }] : [];
  }
  if (actor.switchedRole) {
    return chain.includes(actor.switchedRole.contextId)
      ? [{ roleId: actor.switchedRole.roleId, at: actor.switchedRole.contextId }]
      : [];
  }
  const inChain = new Set(chain);
  const out: { roleId: string; at: string }[] = [];
  const seen = new Set<string>();
  for (const a of actor.assignments) {
    if (!a.active || !inChain.has(a.contextId) || seen.has(a.roleId)) continue;
    seen.add(a.roleId);
    out.push({ roleId: a.roleId, at: a.contextId });
  }
  if (actor.userRoleId && !seen.has(actor.userRoleId) && chain.length > 0) {
    seen.add(actor.userRoleId);
    out.push({ roleId: actor.userRoleId, at: chain[0]! });
  }
  if (
    actor.guestRoleId &&
    !seen.has(actor.guestRoleId) &&
    actor.guestContextIds?.some((c) => inChain.has(c))
  ) {
    out.push({ roleId: actor.guestRoleId, at: leaf });
  }
  return out;
}

export function explain(input: ResolveInput): Explanation {
  const { actor, cap, def, chain, defs } = input;
  if (actor.kind === 'system') return { result: true, reason: 'system', roles: [] };
  if (actor.kind === 'token' && !scopeAllows(actor.scopes ?? [], cap)) {
    return { result: false, reason: 'token-scope', roles: [] };
  }
  if (actor.kind !== 'anonymous' && actor.isSiteAdmin && !def.excludeAdmin && !actor.switchedRole) {
    return { result: true, reason: 'site-admin', roles: [] };
  }

  const roles = rolesInChain(actor, chain);
  if (roles.length === 0) return { result: false, reason: 'no-roles', roles: [] };

  const trace: Explanation['roles'] = [];
  let allowed = false;
  for (const r of roles) {
    const base = defs.caps.get(r.roleId)?.get(cap);
    let p: RolePerm | OverridePerm | undefined = base;
    const entry: Explanation['roles'][number] = { roleId: r.roleId, at: r.at, base };
    trace.push(entry);
    if (base === 'PROHIBIT') {
      entry.final = 'PROHIBIT';
      return { result: false, reason: 'prohibit-role', roles: trace };
    }
    for (const c of chain) {
      const o = defs.overrides.get(overrideKey(c, r.roleId))?.get(cap);
      if (!o) continue;
      if (o === 'PROHIBIT') {
        entry.final = 'PROHIBIT';
        entry.via = c;
        return { result: false, reason: 'prohibit-override', roles: trace };
      }
      p = o;
      entry.via = c;
    }
    entry.final = p;
    if (p === 'ALLOW') allowed = true;
  }
  return { result: allowed, reason: allowed ? 'allowed' : 'not-allowed', roles: trace };
}

export function resolveCan(input: ResolveInput): boolean {
  return explain(input).result;
}
