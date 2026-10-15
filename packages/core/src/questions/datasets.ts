import type { Db, Prisma } from '@hubium/db';
import { type Dataset, datasetFromRow, type QuestionType } from '@hubium/questions';

// Datasets of calculated questions. A question's own datasets live in its data; datasets
// shared by the questions of a category live in QuestionDataset.

type Tx = Db | Prisma.TransactionClient;

export const calculatedTypes: QuestionType[] = [
  'CALCULATED',
  'CALCULATEDSIMPLE',
  'CALCULATEDMULTI',
];
export const isCalculated = (t: string) => (calculatedTypes as string[]).includes(t);

/** The datasets a category of the course (context) shares; none from another course's. */
export async function sharedDatasets(
  db: Tx,
  categoryId: string,
  contextId: string,
): Promise<Dataset[]> {
  const rows = await db.questionDataset.findMany({
    where: { categoryId, category: { contextId } },
    orderBy: { name: 'asc' },
  });
  return rows.map(datasetFromRow);
}

/** Creates or replaces datasets a category shares (by name). */
export async function saveSharedDatasets(db: Tx, categoryId: string, sets: Dataset[]) {
  for (const d of sets) {
    const values = {
      min: d.min,
      max: d.max,
      decimals: d.decimals,
      distribution:
        d.distribution === 'loguniform' ? ('LOGUNIFORM' as const) : ('UNIFORM' as const),
      items: d.items,
    };
    await db.questionDataset.upsert({
      where: { categoryId_name: { categoryId, name: d.name } },
      create: { categoryId, name: d.name, ...values },
      update: values,
    });
  }
}
