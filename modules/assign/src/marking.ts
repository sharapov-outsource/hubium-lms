import { randomInt } from 'node:crypto';
import type { Prisma } from '@hubium/db';
import type { ActivityRef, ModuleCtx } from '@hubium/module-sdk';
import { type GradeRange, type GradingMethod, Guide, Rubric } from '@hubium/module-sdk/grading';
import type { AssignSettingsT } from './config.ts';

// Marking, as Moodle's assignment: a workflow of marking stages (grades reach students and
// the gradebook once released), markers allocated to students, blind marking (participant
// numbers instead of names until identities are revealed), and the rubric or marking guide
// grades are given with.

type Assign = ActivityRef<AssignSettingsT>;
type Db = Prisma.TransactionClient;

export const workflowStates = [
  'NOTMARKED',
  'INMARKING',
  'READYFORREVIEW',
  'INREVIEW',
  'READYFORRELEASE',
  'RELEASED',
] as const;
export type WorkflowState = (typeof workflowStates)[number];

/** Who may put a student in a stage: markers mark, reviewers review, releasing is apart. */
const stageCapability: Record<Exclude<WorkflowState, 'NOTMARKED'>, string> = {
  INMARKING: 'mod.assign:grade',
  READYFORREVIEW: 'mod.assign:grade',
  INREVIEW: 'mod.assign:reviewgrades',
  READYFORRELEASE: 'mod.assign:reviewgrades',
  RELEASED: 'mod.assign:releasegrades',
};

/** The stages the user may set ("not marked" is where everyone starts, not a choice). */
export async function settableStates(ctx: ModuleCtx, a: Assign): Promise<WorkflowState[]> {
  const out: WorkflowState[] = [];
  for (const [state, cap] of Object.entries(stageCapability))
    if (await ctx.perm.can(cap, a.id)) out.push(state as WorkflowState);
  return out;
}

/** May the user move a student from one stage to another? A released grade takes releasing. */
export async function canMoveStage(
  ctx: ModuleCtx,
  a: Assign,
  from: WorkflowState,
  to: WorkflowState,
): Promise<boolean> {
  if (from === to) return true;
  if (to === 'NOTMARKED') return false;
  if (from === 'RELEASED' && from !== to && !(await ctx.perm.can('mod.assign:releasegrades', a.id)))
    return false;
  return ctx.perm.can(stageCapability[to], a.id);
}

/** Markers are allocated when the assignment asks for that (with the marking workflow). */
export const allocating = (a: Assign) => a.settings.markingWorkflow && a.settings.markingAllocation;

export interface Flags {
  workflowState: WorkflowState;
  allocatedMarkerId: string | null;
}

export async function flagsFor(db: Db, a: Assign, userIds: string[]) {
  const rows = await db.assignUserFlags.findMany({
    where: { activityId: a.id, userId: { in: userIds } },
  });
  const out = new Map<string, Flags>();
  for (const id of userIds) {
    const r = rows.find((x) => x.userId === id);
    out.set(id, {
      workflowState: r?.workflowState ?? 'NOTMARKED',
      allocatedMarkerId: r?.allocatedMarkerId ?? null,
    });
  }
  return out;
}

export async function setFlags(db: Db, a: Assign, userIds: string[], data: Partial<Flags>) {
  for (const userId of userIds)
    await db.assignUserFlags.upsert({
      where: { activityId_userId: { activityId: a.id, userId } },
      create: { activityId: a.id, userId, ...data },
      update: data,
    });
}

/** When identities were revealed; null while marking is blind (or was never blind). */
export async function revealedAt(db: Db, a: Assign) {
  if (!a.settings.blindMarking) return null;
  return (
    (await db.assignState.findUnique({ where: { activityId: a.id } }))?.identitiesRevealedAt ?? null
  );
}

/** Marking is blind now: the assignment asks for it and identities are not revealed yet. */
export async function isBlind(db: Db, a: Assign) {
  return a.settings.blindMarking && !(await revealedAt(db, a));
}

/** Does the user see participant numbers instead of names? */
export async function hidesNames(ctx: ModuleCtx, a: Assign) {
  return (await isBlind(ctx.db, a)) && !(await ctx.perm.can('mod.assign:viewblinddetails', a.id));
}

/**
 * Whether the student and the gradebook get the grade: released (with the marking workflow)
 * and no longer blind.
 */
export function gradeReleased(a: Assign, state: WorkflowState, blind: boolean) {
  return (!a.settings.markingWorkflow || state === 'RELEASED') && !blind;
}

/**
 * The students' participant numbers, given out once per assignment as Moodle does: six
 * random digits, so the order of the list tells nothing either.
 */
export async function participantNumbers(db: Db, activityId: string, userIds: string[]) {
  const out = new Map<string, number>();
  for (let round = 0; round < 10; round++) {
    const rows = await db.assignParticipant.findMany({ where: { activityId } });
    for (const r of rows) if (userIds.includes(r.userId)) out.set(r.userId, r.number);
    const missing = userIds.filter((id) => !out.has(id));
    if (!missing.length) break;
    const taken = new Set(rows.map((r) => r.number));
    const data = missing.map((userId) => {
      let number = randomInt(100_000, 1_000_000);
      while (taken.has(number)) number = randomInt(100_000, 1_000_000);
      taken.add(number);
      return { activityId, userId, number };
    });
    // a number taken meanwhile skips the row, and the next round tries again
    await db.assignParticipant.createMany({ data, skipDuplicates: true });
  }
  return out;
}

/** The one way markers see a student: the name, or the participant number while blind. */
export function participantLabel(
  user: { name: string },
  number: number | undefined,
  hide: boolean,
  word: (n: number) => string,
): string {
  return hide ? word(number ?? 0) : user.name;
}

/** Students the user marks: everyone, or with allocation only those allocated to them. */
export async function markedBy(ctx: ModuleCtx, a: Assign, userIds: string[]) {
  if (!allocating(a) || (await ctx.perm.can('mod.assign:manageallocations', a.id))) return userIds;
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const flags = await flagsFor(ctx.db, a, userIds);
  return userIds.filter((id) => flags.get(id)?.allocatedMarkerId === me);
}

// ── rubrics and marking guides ─────────────────────────────────────────────────────

export type GradingForm =
  | { method: 'rubric'; id: string; definition: Rubric }
  | { method: 'guide'; id: string; definition: Guide };

/** The rubric or marking guide grades are given with, when the assignment uses one. */
export async function gradingForm(db: Db, a: Assign): Promise<GradingForm | null> {
  const method = a.settings.gradingMethod;
  if (method === 'simple') return null;
  const row = await db.gradingDefinition.findUnique({
    where: {
      activityId_area_method: {
        activityId: a.id,
        area: 'submission',
        method: method === 'rubric' ? 'RUBRIC' : 'GUIDE',
      },
    },
  });
  if (!row) return null;
  if (method === 'rubric') {
    const d = Rubric.safeParse(row.definition);
    return d.success ? { method, id: row.id, definition: d.data } : null;
  }
  const d = Guide.safeParse(row.definition);
  return d.success ? { method, id: row.id, definition: d.data } : null;
}

/** The grades the assignment takes, for the form's formula. */
export const gradeRange = (a: Assign, scale: string[] | null): GradeRange =>
  scale
    ? { min: 1, max: scale.length, decimals: false }
    : { min: 0, max: a.settings.gradeMax, decimals: true };

export const methodKey = (m: GradingMethod) =>
  m === 'rubric' ? ('RUBRIC' as const) : ('GUIDE' as const);
