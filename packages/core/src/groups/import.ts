import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { AppError, ValidationError } from '../errors.ts';
import { defineOperation } from '../operation.ts';
import { parseCsv } from '../users/users.ts';
import {
  createCohort,
  createGroup,
  createGrouping,
  setCohortMembers,
  setGroupingGroups,
  setGroupMembers,
} from './groups.ts';

// Groups and cohorts from a CSV file, with a preview first. Course groups: columns group,
// grouping and user (username or email) — every line may create a group or grouping and
// add one enrolled person. Cohorts: name, idnumber, description and user. Lines with a
// problem are reported and skipped; the others are applied through the usual operations.

export interface ImportLine {
  line: number;
  /** The group or cohort the line is about. */
  target: string;
  user: string;
  error?: string;
}

export interface ImportPlan {
  lines: ImportLine[];
  created: string[];
  /** Groupings to create (course groups only). */
  createdGroupings: string[];
  memberships: number;
  errors: number;
  applied: boolean;
}

const MAX_CSV = 5_000_000;
const MAX_LINES = 10_000;

function columns(header: string[], names: Record<string, string[]>) {
  const lower = header.map((h) => h.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(names).map(([key, aliases]) => [
      key,
      lower.findIndex((h) => aliases.includes(h)),
    ]),
  ) as Record<string, number>;
}

async function usersByLogin(ctx: RequestContext, logins: string[]) {
  const wanted = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return new Map<string, { id: string; name: string }>();
  const rows = await ctx.db.user.findMany({
    where: {
      deletedAt: null,
      OR: [{ username: { in: wanted } }, { email: { in: wanted } }],
    },
    select: { id: true, name: true, username: true, email: true },
  });
  const out = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    if (r.username) out.set(r.username.toLowerCase(), r);
    out.set(r.email.toLowerCase(), r);
  }
  return out;
}

function errorText(e: unknown): string {
  if (e instanceof AppError) return Object.values(e.fieldErrors ?? {}).flat()[0] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

function readRows(csv: string, names: Record<string, string[]>, required: string) {
  const rows = parseCsv(csv);
  const header = rows.shift() ?? [];
  const col = columns(header, names);
  if (col[required]! < 0)
    throw new ValidationError({ csv: [`The header must have a "${names[required]![0]}" column`] });
  if (rows.length > MAX_LINES) throw new ValidationError({ csv: [`At most ${MAX_LINES} lines`] });
  const get = (r: string[], key: string) => (col[key]! >= 0 ? (r[col[key]!] ?? '').trim() : '');
  return rows.map((r, i) => ({ line: i + 2, get: (key: string) => get(r, key) }));
}

export const importCourseGroups = defineOperation({
  name: 'group.import',
  input: z.object({
    courseId: z.string().uuid(),
    csv: z.string().min(1).max(MAX_CSV),
    apply: z.boolean().default(false),
  }),
  mutation: false,
  authorize: (ctx, i) => ctx.perm.require('group:manage', i.courseId),
  async handler(ctx, { courseId, csv, apply }): Promise<ImportPlan> {
    const rows = readRows(
      csv,
      {
        group: ['group', 'groupname', 'группа'],
        grouping: ['grouping', 'groupingname', 'группировка'],
        user: ['user', 'username', 'email', 'пользователь'],
        description: ['description', 'описание'],
        idnumber: ['idnumber', 'groupidnumber'],
      },
      'group',
    );
    const [groups, groupings, enrolled] = await Promise.all([
      ctx.db.group.findMany({ where: { courseId }, select: { id: true, name: true } }),
      ctx.db.grouping.findMany({ where: { courseId }, select: { id: true, name: true } }),
      ctx.db.enrolment.findMany({ where: { courseId }, select: { userId: true } }),
    ]);
    const groupIds = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]));
    const groupingIds = new Map(groupings.map((g) => [g.name.toLowerCase(), g.id]));
    const inCourse = new Set(enrolled.map((e) => e.userId));
    const users = await usersByLogin(
      ctx,
      rows.map((r) => r.get('user')),
    );

    const plan: ImportPlan = {
      lines: [],
      created: [],
      createdGroupings: [],
      memberships: 0,
      errors: 0,
      applied: apply,
    };
    const newGroups = new Map<string, { name: string; description: string; idNumber: string }>();
    const newGroupings = new Map<string, string>();
    const links = new Map<string, Set<string>>(); // grouping key → group keys
    const members = new Map<string, Set<string>>(); // group key → user ids
    for (const r of rows) {
      const name = r.get('group');
      const login = r.get('user');
      const line: ImportLine = { line: r.line, target: name, user: login };
      plan.lines.push(line);
      if (!name) {
        line.error = 'No group name';
        continue;
      }
      const user = login ? users.get(login.toLowerCase()) : undefined;
      if (login && !user) line.error = 'No such user';
      else if (user && !inCourse.has(user.id)) line.error = 'Not enrolled in the course';
      if (line.error) continue;
      const key = name.toLowerCase();
      if (!groupIds.has(key) && !newGroups.has(key))
        newGroups.set(key, {
          name,
          description: r.get('description'),
          idNumber: r.get('idnumber'),
        });
      const grouping = r.get('grouping');
      if (grouping) {
        const gk = grouping.toLowerCase();
        if (!groupingIds.has(gk) && !newGroupings.has(gk)) newGroupings.set(gk, grouping);
        if (!links.has(gk)) links.set(gk, new Set());
        links.get(gk)!.add(key);
      }
      if (user) {
        if (!members.has(key)) members.set(key, new Set());
        members.get(key)!.add(user.id);
      }
    }
    plan.created = [...newGroups.values()].map((g) => g.name);
    plan.createdGroupings = [...newGroupings.values()];
    plan.memberships = [...members.values()].reduce((n, s) => n + s.size, 0);
    plan.errors = plan.lines.filter((l) => l.error).length;
    if (!apply) return plan;

    for (const [key, g] of newGroups) {
      const { id } = await createGroup.run(ctx, {
        courseId,
        name: g.name,
        description: g.description,
        idNumber: g.idNumber || undefined,
      });
      groupIds.set(key, id);
    }
    for (const [key, name] of newGroupings) {
      const { id } = await createGrouping.run(ctx, { courseId, name });
      groupingIds.set(key, id);
    }
    for (const [gk, groupKeys] of links) {
      const groupingId = groupingIds.get(gk)!;
      const current = await ctx.db.groupingGroup.findMany({
        where: { groupingId },
        select: { groupId: true },
      });
      const ids = new Set([
        ...current.map((c) => c.groupId),
        ...[...groupKeys].map((k) => groupIds.get(k)!),
      ]);
      await setGroupingGroups.run(ctx, { groupingId, groupIds: [...ids] });
    }
    for (const [key, ids] of members)
      await setGroupMembers.run(ctx, { groupId: groupIds.get(key)!, add: [...ids] });
    return plan;
  },
});

export const importCohorts = defineOperation({
  name: 'cohort.import',
  input: z.object({ csv: z.string().min(1).max(MAX_CSV), apply: z.boolean().default(false) }),
  mutation: false,
  authorize: (ctx) => ctx.perm.require('cohort:manage'),
  async handler(ctx, { csv, apply }): Promise<ImportPlan> {
    const rows = readRows(
      csv,
      {
        name: ['name', 'cohort', 'cohortname', 'название'],
        idnumber: ['idnumber', 'cohortidnumber'],
        description: ['description', 'описание'],
        user: ['user', 'username', 'email', 'пользователь'],
      },
      'name',
    );
    const cohorts = await ctx.db.cohort.findMany({
      select: { id: true, name: true, idNumber: true },
    });
    const byIdNumber = new Map(
      cohorts.filter((c) => c.idNumber).map((c) => [c.idNumber!.toLowerCase(), c.id]),
    );
    const byName = new Map(cohorts.map((c) => [c.name.toLowerCase(), c.id]));
    const users = await usersByLogin(
      ctx,
      rows.map((r) => r.get('user')),
    );
    const plan: ImportPlan = {
      lines: [],
      created: [],
      createdGroupings: [],
      memberships: 0,
      errors: 0,
      applied: apply,
    };
    const fresh = new Map<string, { name: string; idNumber: string; description: string }>();
    const members = new Map<string, Set<string>>();
    const lineKey = new Map<ImportLine, string>();
    // a cohort is the one with the line's idnumber, else the one with its name
    const keyOf = (name: string, idNumber: string) =>
      idNumber ? `id:${idNumber.toLowerCase()}` : `name:${name.toLowerCase()}`;
    const existing = (name: string, idNumber: string) =>
      idNumber ? byIdNumber.get(idNumber.toLowerCase()) : byName.get(name.toLowerCase());
    for (const r of rows) {
      const name = r.get('name');
      const idNumber = r.get('idnumber');
      const login = r.get('user');
      const line: ImportLine = { line: r.line, target: name || idNumber, user: login };
      plan.lines.push(line);
      if (!name && !(idNumber && byIdNumber.has(idNumber.toLowerCase()))) {
        line.error = 'No cohort name';
        continue;
      }
      const user = login ? users.get(login.toLowerCase()) : undefined;
      if (login && !user) {
        line.error = 'No such user';
        continue;
      }
      const key = keyOf(name, idNumber);
      lineKey.set(line, key);
      if (!existing(name, idNumber) && !fresh.has(key))
        fresh.set(key, { name, idNumber, description: r.get('description') });
      if (user) {
        if (!members.has(key)) members.set(key, new Set());
        members.get(key)!.add(user.id);
      }
    }
    plan.created = [...fresh.values()].map((c) => c.name);
    plan.memberships = [...members.values()].reduce((n, s) => n + s.size, 0);
    plan.errors = plan.lines.filter((l) => l.error).length;
    if (!apply) return plan;

    const ids = new Map<string, string>();
    for (const [key, c] of fresh) {
      try {
        const { id } = await createCohort.run(ctx, {
          name: c.name,
          idNumber: c.idNumber || undefined,
          description: c.description,
        });
        ids.set(key, id);
      } catch (e) {
        for (const l of plan.lines) if (lineKey.get(l) === key) l.error ??= errorText(e);
      }
    }
    for (const [key, add] of members) {
      const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const cohortId = ids.get(key) ?? (kind === 'id' ? byIdNumber.get(value) : byName.get(value));
      if (cohortId) await setCohortMembers.run(ctx, { cohortId, add: [...add] });
    }
    plan.errors = plan.lines.filter((l) => l.error).length;
    return plan;
  },
});

// ── auto-create ─────────────────────────────────────────────────────────────

/** Moodle's naming scheme: "@" becomes A, B, … Z, AA…; "#" becomes 1, 2, 3… */
export function groupName(pattern: string, i: number): string {
  let letters = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return pattern.replaceAll('@', letters).replaceAll('#', String(i + 1));
}

export const autoCreateGroups = defineOperation({
  name: 'group.autocreate',
  input: z
    .object({
      courseId: z.string().uuid(),
      roleId: z.string().uuid(),
      /** "count": this many groups; "size": groups of this many people. */
      by: z.enum(['count', 'size']),
      number: z.coerce.number().int().min(1).max(1000),
      pattern: z.string().trim().min(1).max(100),
      order: z.enum(['random', 'name']).default('random'),
      grouping: z.string().trim().max(255).default(''),
    })
    .refine((v) => v.pattern.includes('@') || v.pattern.includes('#'), {
      message: 'The name needs @ or #',
      path: ['pattern'],
    }),
  mutation: false,
  authorize: (ctx, i) => ctx.perm.require('group:manage', i.courseId),
  async handler(ctx, input) {
    const people = await ctx.db.user.findMany({
      where: {
        deletedAt: null,
        enrolments: { some: { courseId: input.courseId, status: 'ACTIVE' } },
        // a course's context has the course's id
        roleAssignments: { some: { roleId: input.roleId, contextId: input.courseId } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true },
    });
    if (!people.length) throw new ValidationError({ roleId: ['Nobody has this role here'] });
    const ids = people.map((p) => p.id);
    if (input.order === 'random')
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
    const count =
      input.by === 'count'
        ? Math.min(input.number, ids.length)
        : Math.ceil(ids.length / input.number);
    const taken = new Set(
      (
        await ctx.db.group.findMany({ where: { courseId: input.courseId }, select: { name: true } })
      ).map((g) => g.name.toLowerCase()),
    );
    const names = Array.from({ length: count }, (_, i) => groupName(input.pattern, i));
    const clash = names.find((n) => taken.has(n.toLowerCase()));
    if (clash) throw new ValidationError({ pattern: [`A group named "${clash}" already exists`] });
    // people dealt in turn, so sizes differ by at most one
    const buckets = names.map(() => [] as string[]);
    for (const [i, id] of ids.entries()) buckets[i % count]!.push(id);
    const groupIds: string[] = [];
    for (const [i, name] of names.entries()) {
      const { id } = await createGroup.run(ctx, { courseId: input.courseId, name });
      await setGroupMembers.run(ctx, { groupId: id, add: buckets[i]! });
      groupIds.push(id);
    }
    if (input.grouping) {
      const existing = await ctx.db.grouping.findFirst({
        where: { courseId: input.courseId, name: input.grouping },
        include: { groups: true },
      });
      const groupingId =
        existing?.id ??
        (await createGrouping.run(ctx, { courseId: input.courseId, name: input.grouping })).id;
      await setGroupingGroups.run(ctx, {
        groupingId,
        groupIds: [...(existing?.groups.map((g) => g.groupId) ?? []), ...groupIds],
      });
    }
    return { groups: names, people: ids.length };
  },
});
