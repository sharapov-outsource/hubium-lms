import { Prisma } from '@hubium/db';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { useTestDb } from '../../test/helpers.ts';
import { nearestChunks } from './indexing.ts';

describe('nearest chunks of a course', () => {
  const t = useTestDb();

  // (x, 1 − x, 0, …): the query (1, 0, …) is nearest to x = 1
  const vector = (x: number) =>
    `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? x : i === 1 ? 1 - x : 0)).join(',')}]`;
  const chunks = (courseId: string, n: number, x: number) => t.db.$executeRaw`
    INSERT INTO "ContentChunk" (id, "courseId", "sourceType", "sourceId", "chunkIndex", title,
                                text, "tokenCount", "contentHash", "embeddingModel", embedding)
    SELECT gen_random_uuid(), ${courseId}::uuid, 'course', ${courseId} || '-' || g, g, 't', 't',
           1, 'h', 'nearest-test', ${vector(x)}::vector
      FROM generate_series(1, ${n}::int) g`;

  it('are found among many nearer ones of other courses, with an iterative scan or without', async () => {
    const mine = await courseFixture(t.db, 'NEARA');
    const other = await courseFixture(t.db, 'NEARB');
    await chunks(other.courseId, 400, 1);
    await chunks(mine.courseId, 5, 0.5);
    for (const iterative of [true, false]) {
      const found = await nearestChunks(t.db, {
        courseId: mine.courseId,
        allowed: Prisma.sql`TRUE`,
        model: 'nearest-test',
        vector: vector(1),
        limit: 5,
        iterative,
      });
      expect(found).toHaveLength(5);
    }
  });
});
