import type { Db, Prisma } from '@hubium/db';

// Reports name custom profile and course fields by their short names
// (`user.custom.<shortName>`, `course.custom.<shortName>`): when a field is renamed, the
// reports that use it follow. Fields deleted are left out when a report loads (engine.ts).

type Tx = Prisma.TransactionClient | Db;

/** Points the columns, conditions and filters on a custom field at its new short name. */
export async function renameReportField(
  db: Tx,
  kind: 'user' | 'course',
  from: string,
  to: string,
): Promise<void> {
  const [before, after] = [`${kind}.custom.${from}`, `${kind}.custom.${to}`];
  const follow = <T extends { field: string }>(x: T): T =>
    x.field === before ? { ...x, field: after } : x;
  const reports = await db.customReport.findMany({
    select: { id: true, columns: true, conditions: true, filters: true },
  });
  for (const r of reports) {
    const columns = r.columns as { field: string }[];
    const conditions = r.conditions as { field: string }[];
    const filters = r.filters as string[];
    if (!filters.includes(before) && ![...columns, ...conditions].some((x) => x.field === before))
      continue;
    await db.customReport.update({
      where: { id: r.id },
      data: {
        columns: columns.map(follow) as Prisma.InputJsonValue,
        conditions: conditions.map(follow) as Prisma.InputJsonValue,
        filters: filters.map((k) => (k === before ? after : k)),
      },
    });
  }
}
