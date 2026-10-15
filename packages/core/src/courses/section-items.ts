import type { Prisma } from '@hubium/db';
import { compareRank, rankBetween } from '../lib/rank.ts';

// What a section holds, in order. Its activities and its subsections share one order
// (rank), so a subsection sits among the activities as in Moodle; moving either one
// moves it past the other.

export interface SectionItem {
  kind: 'activity' | 'subsection';
  id: string;
  rank: string;
}

type Tx = Prisma.TransactionClient;

/** The section's activities (live ones unless `withDeleted`) and subsections, in order. */
export async function sectionItems(
  tx: Tx,
  sectionId: string,
  opts: { withDeleted?: boolean } = {},
): Promise<SectionItem[]> {
  const [activities, subsections] = await Promise.all([
    tx.activity.findMany({
      where: { sectionId, ...(opts.withDeleted ? {} : { deletedAt: null }) },
      select: { id: true, rank: true },
    }),
    tx.courseSection.findMany({ where: { parentId: sectionId }, select: { id: true, rank: true } }),
  ]);
  return [
    ...activities.map((a) => ({ kind: 'activity' as const, ...a })),
    ...subsections.map((s) => ({ kind: 'subsection' as const, ...s })),
  ].sort(compareRank);
}

/** A rank after everything in the section (deleted activities too: they may come back). */
export async function rankAtEnd(tx: Tx, sectionId: string): Promise<string> {
  const items = await sectionItems(tx, sectionId, { withDeleted: true });
  return rankBetween(items.at(-1)?.rank ?? null, null);
}

/** The rank that moves item `id` one place up or down among `items`; null at either end. */
export function rankForStep(
  items: SectionItem[],
  id: string,
  direction: 'up' | 'down',
): string | null {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  if (direction === 'up' && i > 0)
    return rankBetween(items[i - 2]?.rank ?? null, items[i - 1]!.rank);
  if (direction === 'down' && i < items.length - 1)
    return rankBetween(items[i + 1]!.rank, items[i + 2]?.rank ?? null);
  return null;
}
