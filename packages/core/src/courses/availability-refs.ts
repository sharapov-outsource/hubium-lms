import { Prisma } from '@hubium/db';
import { type Condition, parseAvailability, pruneAvailability } from './availability.ts';

/**
 * Removes conditions on something deleted for good (an activity purged from the recycle
 * bin, a group or grouping) from the restrictions of the course's activities and sections,
 * those in the recycle bin included, so nothing stays locked by a condition that can no
 * longer be met. Evaluation already leaves such conditions out (AvailabilityFacts.exists);
 * this keeps the stored trees and the forms that edit them clean.
 */
export async function dropAvailabilityRefs(
  tx: Prisma.TransactionClient,
  courseId: string,
  gone: (c: Condition) => boolean,
): Promise<void> {
  const withRestrictions = { courseId, availability: { not: Prisma.AnyNull } };
  const [activities, sections] = await Promise.all([
    tx.activity.findMany({ where: withRestrictions, select: { id: true, availability: true } }),
    tx.courseSection.findMany({
      where: withRestrictions,
      select: { id: true, availability: true },
    }),
  ]);
  const pruned = (raw: unknown) => {
    const tree = parseAvailability(raw);
    const next = pruneAvailability(tree, gone);
    if (JSON.stringify(next) === JSON.stringify(tree)) return undefined;
    return next ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  };
  for (const a of activities) {
    const availability = pruned(a.availability);
    if (availability !== undefined)
      await tx.activity.update({ where: { id: a.id }, data: { availability } });
  }
  for (const s of sections) {
    const availability = pruned(s.availability);
    if (availability !== undefined)
      await tx.courseSection.update({ where: { id: s.id }, data: { availability } });
  }
}

export const namesActivity = (activityId: string) => (c: Condition) =>
  (c.type === 'completion' || c.type === 'grade') && c.activityId === activityId;

export const namesGroups = (groupIds: ReadonlySet<string>) => (c: Condition) =>
  c.type === 'group' && !!c.groupId && groupIds.has(c.groupId);

export const namesGroupings = (groupingIds: ReadonlySet<string>) => (c: Condition) =>
  c.type === 'grouping' && groupingIds.has(c.groupingId);
