import { describe, expect, it } from 'vitest';
import { type CapabilityDef, getCapability } from './capabilities.ts';
import {
  type ActorAccess,
  type OverridePerm,
  overrideKey,
  type RoleDefinitions,
  type RolePerm,
  resolveCan,
  scopeAllows,
} from './resolve.ts';

const SYS = 'sys';
const CAT = 'cat';
const SUBCAT = 'subcat';
const COURSE = 'course';
const OTHER_COURSE = 'course2';
const ACT = 'act';

const chainCourse = [SYS, CAT, SUBCAT, COURSE];
const chainAct = [...chainCourse, ACT];
const chainOther = [SYS, CAT, OTHER_COURSE];

const R = {
  manager: 'r-manager',
  teacher: 'r-editingteacher',
  assistant: 'r-teacher',
  student: 'r-student',
  observer: 'r-observer',
  guest: 'r-guest',
  user: 'r-user',
};

function makeDefs(
  caps: Record<string, Record<string, RolePerm>>,
  overrides: [ctx: string, role: string, cap: string, perm: OverridePerm][] = [],
): RoleDefinitions {
  const d: RoleDefinitions = { caps: new Map(), overrides: new Map() };
  for (const [role, m] of Object.entries(caps)) d.caps.set(role, new Map(Object.entries(m)));
  for (const [ctx, role, cap, perm] of overrides) {
    const k = overrideKey(ctx, role);
    if (!d.overrides.has(k)) d.overrides.set(k, new Map());
    d.overrides.get(k)!.set(cap, perm);
  }
  return d;
}

const baseCaps: Record<string, Record<string, RolePerm>> = {
  [R.manager]: { 'course:update': 'ALLOW', 'course:viewhidden': 'ALLOW', 'grade:viewall': 'ALLOW' },
  [R.teacher]: {
    'course:update': 'ALLOW',
    'grade:edit': 'ALLOW',
    'grade:viewall': 'ALLOW',
    'mod.assign:grade': 'ALLOW',
  },
  [R.assistant]: { 'grade:edit': 'ALLOW', 'grade:viewall': 'ALLOW' },
  [R.student]: {
    'mod.assign:submit': 'ALLOW',
    'mod.quiz:attempt': 'ALLOW',
    'grade:view': 'ALLOW',
    'activity:view': 'ALLOW',
  },
  [R.observer]: { 'grade:viewall': 'ALLOW', 'activity:view': 'ALLOW' },
  [R.guest]: { 'activity:view': 'ALLOW' },
  [R.user]: { 'message:send': 'ALLOW', 'enrol:self': 'ALLOW' },
};

function user(
  assignments: { roleId: string; contextId: string; active?: boolean }[] = [],
  extra: Partial<Extract<ActorAccess, { userId: string }>> = {},
): ActorAccess {
  return {
    kind: 'user',
    userId: 'u1',
    isSiteAdmin: false,
    assignments: assignments.map((a) => ({ active: true, ...a })),
    userRoleId: R.user,
    ...extra,
  };
}

function can(
  actor: ActorAccess,
  cap: string,
  chain: readonly string[] = chainCourse,
  defs: RoleDefinitions = makeDefs(baseCaps),
): boolean {
  const def: CapabilityDef = getCapability(cap);
  return resolveCan({ actor, cap, def, chain, defs });
}

describe('can(): basics', () => {
  it('system actor can do anything', () => {
    expect(can({ kind: 'system' }, 'site:config')).toBe(true);
  });
  it('user with no assignments is denied course caps', () => {
    expect(can(user(), 'course:update')).toBe(false);
  });
  it('implicit authenticated user role grants system-level caps', () => {
    expect(can(user(), 'message:send', [SYS])).toBe(true);
  });
  it('implicit user role applies at any depth in the chain', () => {
    expect(can(user(), 'enrol:self', chainCourse)).toBe(true);
  });
  it('without implicit user role, message:send is denied', () => {
    expect(can(user([], { userRoleId: undefined }), 'message:send', [SYS])).toBe(false);
  });
  it('anonymous without guest role is denied', () => {
    expect(can({ kind: 'anonymous' }, 'activity:view', chainAct)).toBe(false);
  });
  it('anonymous with guest role can view activities', () => {
    expect(can({ kind: 'anonymous', guestRoleId: R.guest }, 'activity:view', chainAct)).toBe(true);
  });
  it('anonymous guest cannot submit', () => {
    expect(can({ kind: 'anonymous', guestRoleId: R.guest }, 'mod.assign:submit', chainAct)).toBe(
      false,
    );
  });
  it('unknown capability throws', () => {
    expect(() => can(user(), 'nope:nothing')).toThrow(/Unknown capability/);
  });
});

describe('can(): assignments and inheritance', () => {
  it('teacher assigned at course can update it', () => {
    expect(can(user([{ roleId: R.teacher, contextId: COURSE }]), 'course:update')).toBe(true);
  });
  it('teacher assignment applies to activities inside the course', () => {
    expect(
      can(user([{ roleId: R.teacher, contextId: COURSE }]), 'mod.assign:grade', chainAct),
    ).toBe(true);
  });
  it('teacher at one course cannot update another course', () => {
    expect(can(user([{ roleId: R.teacher, contextId: COURSE }]), 'course:update', chainOther)).toBe(
      false,
    );
  });
  it('manager assigned at category inherits into nested courses', () => {
    expect(can(user([{ roleId: R.manager, contextId: CAT }]), 'course:update')).toBe(true);
  });
  it('manager at subcategory does not reach a sibling branch', () => {
    expect(can(user([{ roleId: R.manager, contextId: SUBCAT }]), 'course:update', chainOther)).toBe(
      false,
    );
  });
  it('manager at system reaches every course', () => {
    expect(can(user([{ roleId: R.manager, contextId: SYS }]), 'course:update', chainOther)).toBe(
      true,
    );
  });
  it('assignment at an activity does not grant course-level caps', () => {
    expect(can(user([{ roleId: R.teacher, contextId: ACT }]), 'course:update', chainCourse)).toBe(
      false,
    );
  });
  it('assignment at an activity grants caps within that activity', () => {
    expect(can(user([{ roleId: R.teacher, contextId: ACT }]), 'mod.assign:grade', chainAct)).toBe(
      true,
    );
  });
  it('student can submit an assignment', () => {
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'mod.assign:submit', chainAct),
    ).toBe(true);
  });
  it('student cannot grade', () => {
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'mod.assign:grade', chainAct),
    ).toBe(false);
  });
  it('observer can view all grades but not edit', () => {
    const u = user([{ roleId: R.observer, contextId: COURSE }]);
    expect(can(u, 'grade:viewall')).toBe(true);
    expect(can(u, 'grade:edit')).toBe(false);
  });
  it('any one allowing role suffices (student + assistant)', () => {
    const u = user([
      { roleId: R.student, contextId: COURSE },
      { roleId: R.assistant, contextId: COURSE },
    ]);
    expect(can(u, 'grade:edit')).toBe(true);
  });
  it('a role without the capability defined does not allow it', () => {
    expect(can(user([{ roleId: R.assistant, contextId: COURSE }]), 'course:update')).toBe(false);
  });
});

describe('can(): enrolment state', () => {
  it('suspended enrolment drops the student role', () => {
    expect(
      can(
        user([{ roleId: R.student, contextId: COURSE, active: false }]),
        'mod.assign:submit',
        chainAct,
      ),
    ).toBe(false);
  });
  it('expired enrolment drops the role', () => {
    expect(can(user([{ roleId: R.teacher, contextId: COURSE, active: false }]), 'grade:edit')).toBe(
      false,
    );
  });
  it('one inactive and one active assignment: active wins', () => {
    const u = user([
      { roleId: R.student, contextId: COURSE, active: false },
      { roleId: R.student, contextId: COURSE, active: true },
    ]);
    expect(can(u, 'mod.assign:submit', chainAct)).toBe(true);
  });
  it('inactive teacher enrolment still leaves implicit user role', () => {
    expect(can(user([{ roleId: R.teacher, contextId: COURSE, active: false }]), 'enrol:self')).toBe(
      true,
    );
  });
});

describe('can(): overrides', () => {
  it('ALLOW override at course grants a cap the role lacks', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.student, 'grade:viewall', 'ALLOW']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'grade:viewall', chainCourse, defs),
    ).toBe(true);
  });
  it('ALLOW override at another course does not apply', () => {
    const defs = makeDefs(baseCaps, [[OTHER_COURSE, R.student, 'grade:viewall', 'ALLOW']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'grade:viewall', chainCourse, defs),
    ).toBe(false);
  });
  it('DENY override at activity removes a cap', () => {
    const defs = makeDefs(baseCaps, [[ACT, R.student, 'mod.assign:submit', 'DENY']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'mod.assign:submit', chainAct, defs),
    ).toBe(false);
  });
  it('DENY at category, ALLOW deeper at course: deeper wins', () => {
    const defs = makeDefs(baseCaps, [
      [CAT, R.teacher, 'course:update', 'DENY'],
      [COURSE, R.teacher, 'course:update', 'ALLOW'],
    ]);
    expect(
      can(user([{ roleId: R.teacher, contextId: COURSE }]), 'course:update', chainCourse, defs),
    ).toBe(true);
  });
  it('ALLOW at category, DENY deeper at course: deeper wins', () => {
    const defs = makeDefs(baseCaps, [
      [CAT, R.student, 'grade:viewall', 'ALLOW'],
      [COURSE, R.student, 'grade:viewall', 'DENY'],
    ]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'grade:viewall', chainCourse, defs),
    ).toBe(false);
  });
  it('DENY for one role does not block another allowing role', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.assistant, 'grade:edit', 'DENY']]);
    const u = user([
      { roleId: R.assistant, contextId: COURSE },
      { roleId: R.teacher, contextId: COURSE },
    ]);
    expect(can(u, 'grade:edit', chainCourse, defs)).toBe(true);
  });
  it('PROHIBIT override is sticky even if a deeper override allows', () => {
    const defs = makeDefs(baseCaps, [
      [CAT, R.teacher, 'course:update', 'PROHIBIT'],
      [COURSE, R.teacher, 'course:update', 'ALLOW'],
    ]);
    expect(
      can(user([{ roleId: R.teacher, contextId: COURSE }]), 'course:update', chainCourse, defs),
    ).toBe(false);
  });
  it('PROHIBIT on one role blocks even when another role allows', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.student, 'grade:edit', 'PROHIBIT']]);
    const u = user([
      { roleId: R.student, contextId: COURSE },
      { roleId: R.teacher, contextId: COURSE },
    ]);
    expect(can(u, 'grade:edit', chainCourse, defs)).toBe(false);
  });
  it('PROHIBIT in role definition blocks regardless of overrides', () => {
    const defs = makeDefs(
      { ...baseCaps, [R.student]: { ...baseCaps[R.student], 'message:send': 'PROHIBIT' } },
      [[COURSE, R.student, 'message:send', 'ALLOW']],
    );
    const u = user([{ roleId: R.student, contextId: COURSE }]);
    expect(can(u, 'message:send', chainCourse, defs)).toBe(false);
  });
  it('PROHIBIT on the implicit user role blocks everyone below that context', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.user, 'enrol:self', 'PROHIBIT']]);
    expect(can(user(), 'enrol:self', chainCourse, defs)).toBe(false);
    expect(can(user(), 'enrol:self', chainOther, defs)).toBe(true);
  });
  it('override for a role the user does not hold has no effect', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.observer, 'course:update', 'ALLOW']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'course:update', chainCourse, defs),
    ).toBe(false);
  });
  it('override applies at activity level for an activity check', () => {
    const defs = makeDefs(baseCaps, [[ACT, R.student, 'mod.assign:grade', 'ALLOW']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'mod.assign:grade', chainAct, defs),
    ).toBe(true);
  });
  it('activity-level override does not leak into the course check', () => {
    const defs = makeDefs(baseCaps, [[ACT, R.student, 'grade:viewall', 'ALLOW']]);
    expect(
      can(user([{ roleId: R.student, contextId: COURSE }]), 'grade:viewall', chainCourse, defs),
    ).toBe(false);
  });
});

describe('can(): site admins', () => {
  const admin = user([], { isSiteAdmin: true });
  it('site admin bypasses ordinary caps', () => {
    expect(can(admin, 'course:update', chainOther)).toBe(true);
  });
  it('site admin bypasses even site:config which no role has', () => {
    expect(can(admin, 'site:config', [SYS])).toBe(true);
  });
  it('site admin bypass ignores PROHIBIT overrides', () => {
    const defs = makeDefs(baseCaps, [[COURSE, R.user, 'course:update', 'PROHIBIT']]);
    expect(can(admin, 'course:update', chainCourse, defs)).toBe(true);
  });
  it('excludeAdmin: site admin does not implicitly get mod.assign:submit', () => {
    expect(can(admin, 'mod.assign:submit', chainAct)).toBe(false);
  });
  it('excludeAdmin: site admin does not implicitly get mod.quiz:attempt', () => {
    expect(can(admin, 'mod.quiz:attempt', chainAct)).toBe(false);
  });
  it('excludeAdmin: admin enrolled as student does get to submit', () => {
    const a = user([{ roleId: R.student, contextId: COURSE }], { isSiteAdmin: true });
    expect(can(a, 'mod.assign:submit', chainAct)).toBe(true);
  });
});

describe('can(): tokens', () => {
  const tokenActor = (scopes: string[], isSiteAdmin = false): ActorAccess => ({
    kind: 'token',
    userId: 'u1',
    isSiteAdmin,
    assignments: [{ roleId: R.teacher, contextId: COURSE, active: true }],
    userRoleId: R.user,
    scopes,
  });
  it('token with matching exact scope and role is allowed', () => {
    expect(can(tokenActor(['course:update']), 'course:update')).toBe(true);
  });
  it('token without the scope is denied even if role allows', () => {
    expect(can(tokenActor(['grade:edit']), 'course:update')).toBe(false);
  });
  it('wildcard prefix scope covers the component', () => {
    expect(can(tokenActor(['course:*']), 'course:update')).toBe(true);
  });
  it('wildcard prefix scope does not cover other components', () => {
    expect(can(tokenActor(['course:*']), 'grade:edit')).toBe(false);
  });
  it('global * scope defers to roles', () => {
    expect(can(tokenActor(['*']), 'grade:edit')).toBe(true);
    expect(can(tokenActor(['*']), 'course:update', chainOther)).toBe(false);
  });
  it('scope does not elevate beyond roles', () => {
    expect(can(tokenActor(['*']), 'site:config', [SYS])).toBe(false);
  });
  it('admin token still limited by scope', () => {
    expect(can(tokenActor([], true), 'course:update')).toBe(false);
    expect(can(tokenActor(['course:*'], true), 'course:update', chainOther)).toBe(true);
  });
  it('scopeAllows handles nested module prefixes', () => {
    expect(scopeAllows(['mod.assign:*'], 'mod.assign:submit')).toBe(true);
    expect(scopeAllows(['mod.assign:*'], 'mod.quiz:attempt')).toBe(false);
  });
});

describe('can(): role switch and guest access', () => {
  it('switched role limits a teacher to student caps', () => {
    const u = user([{ roleId: R.teacher, contextId: COURSE }], {
      switchedRole: { roleId: R.student, contextId: COURSE },
    });
    expect(can(u, 'course:update')).toBe(false);
    expect(can(u, 'mod.assign:submit', chainAct)).toBe(true);
  });
  it('switched role disables site admin bypass', () => {
    const u = user([], {
      isSiteAdmin: true,
      switchedRole: { roleId: R.student, contextId: COURSE },
    });
    expect(can(u, 'course:update')).toBe(false);
  });
  it('switched role does not apply outside its course', () => {
    const u = user([{ roleId: R.teacher, contextId: OTHER_COURSE }], {
      switchedRole: { roleId: R.student, contextId: COURSE },
    });
    expect(can(u, 'course:update', chainOther)).toBe(false);
  });
  it('logged-in non-enrolled user gets guest role on guest-access courses', () => {
    const u = user([], { guestRoleId: R.guest, guestContextIds: [COURSE] });
    expect(can(u, 'activity:view', chainAct)).toBe(true);
  });
  it('guest role does not apply to other courses', () => {
    const u = user([], { guestRoleId: R.guest, guestContextIds: [COURSE] });
    expect(can(u, 'activity:view', [...chainOther, 'act2'])).toBe(false);
  });
});
