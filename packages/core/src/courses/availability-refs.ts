import { Prisma } from '@hubium/db';
import {
  type AvailabilityTree,
  type Condition,
  parseAvailability,
  pruneAvailability,
} from './availability.ts';

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

/**
 * Points the conditions on a custom profile field (`cf:<shortName>`) in every course at its
 * new short name, when the field is renamed: the values move with it (profile-fields.ts).
 */
export async function renameProfileFieldConditions(
  tx: Prisma.TransactionClient,
  from: string,
  to: string,
): Promise<void> {
  const [before, after] = [`cf:${from}`, `cf:${to}`];
  const rename = (node: AvailabilityTree['c'][number]): AvailabilityTree['c'][number] =>
    'c' in node
      ? { ...node, c: node.c.map(rename) }
      : node.type === 'profile' && node.field === before
        ? { ...node, field: after }
        : node;
  // only the rows whose JSON names the field at all are read
  const like = `%${JSON.stringify(before)}%`;
  const [activities, sections] = await Promise.all([
    tx.$queryRaw<{ id: string; availability: unknown }[]>`
      SELECT id, availability FROM "Activity" WHERE availability::text LIKE ${like}`,
    tx.$queryRaw<{ id: string; availability: unknown }[]>`
      SELECT id, availability FROM "CourseSection" WHERE availability::text LIKE ${like}`,
  ]);
  const renamed = (raw: unknown) => {
    const tree = parseAvailability(raw);
    if (!tree) return undefined;
    const next = rename(tree) as AvailabilityTree;
    return JSON.stringify(next) === JSON.stringify(tree)
      ? undefined
      : (next as unknown as Prisma.InputJsonValue);
  };
  for (const a of activities) {
    const availability = renamed(a.availability);
    if (availability !== undefined)
      await tx.activity.update({ where: { id: a.id }, data: { availability } });
  }
  for (const s of sections) {
    const availability = renamed(s.availability);
    if (availability !== undefined)
      await tx.courseSection.update({ where: { id: s.id }, data: { availability } });
  }
}
