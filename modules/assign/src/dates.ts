import type { Prisma } from '@hubium/db';
import type { ActivityRef } from '@hubium/module-sdk';
import type { AssignSettingsT } from './config.ts';

// A student's dates: their own override first, then the override of their group with the
// highest priority (the lowest sortOrder, as Moodle's assignment), then the settings.

export interface EffectiveDates {
  openAt: Date | null;
  dueAt: Date | null;
  cutoffAt: Date | null;
  /** The dates come from an override. */
  extended: boolean;
  /** Which override: the student's own or a group's. */
  source: 'user' | 'group' | null;
}

type Override = {
  dueAt: Date | null;
  cutoffAt: Date | null;
  allowSubmissionsFrom: Date | null;
};

export function datesFrom(
  settings: Pick<AssignSettingsT, 'openAt' | 'dueAt' | 'cutoffAt'>,
  o: Override | null,
  source: EffectiveDates['source'],
): EffectiveDates {
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  const dueAt = o?.dueAt ?? d(settings.dueAt);
  let cutoffAt = o?.cutoffAt ?? d(settings.cutoffAt);
  // An extension past the course-wide cut-off moves the cut-off with it.
  if (o?.dueAt && !o.cutoffAt && cutoffAt && cutoffAt < o.dueAt) cutoffAt = o.dueAt;
  return {
    openAt: o?.allowSubmissionsFrom ?? d(settings.openAt),
    dueAt,
    cutoffAt,
    extended: !!o,
    source: o ? source : null,
  };
}

/** The override that applies to a student: theirs, or their groups' with the highest priority. */
export async function overrideFor(
  db: Prisma.TransactionClient,
  activityId: string,
  userId: string,
) {
  const own = await db.assignOverride.findUnique({
    where: { activityId_userId: { activityId, userId } },
  });
  if (own) return { override: own, source: 'user' as const };
  const group = await db.assignOverride.findFirst({
    where: { activityId, group: { members: { some: { userId } } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return group ? { override: group, source: 'group' as const } : { override: null, source: null };
}

/** Activity dates with the student's override applied. */
export async function effectiveDates(
  db: Prisma.TransactionClient,
  a: ActivityRef<AssignSettingsT>,
  userId: string,
): Promise<EffectiveDates> {
  const { override, source } = await overrideFor(db, a.id, userId);
  return datesFrom(a.settings, override, source);
}
