import { createHash } from 'node:crypto';
import { chunkText, htmlToText } from '@hubium/ai';
import { type Db, Prisma, uuidv7 } from '@hubium/db';
import { Permissions } from '../access/permissions.ts';
import type { RequestContext } from '../context.ts';
import { buildModuleCtx, toActivityRef } from '../modules/module-ctx.ts';
import { getModule } from '../modules/registry.ts';
import { embeddingProvider } from './config.ts';

// Course content → ContentChunk rows (text, tsvector, optional embedding) for the tutor
// and quiz generation. Each activity is one source; re-indexing replaces its chunks only
// when the text (or the embedding model) changed.

export const INDEX_JOB = 'ai.index.activity';
export const INDEX_COURSE_JOB = 'ai.index.course';

function systemCtx(db: Db): RequestContext {
  return {
    db,
    actor: { kind: 'system' },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: 'ru',
    origin: 'WORKER',
  };
}

const toText = (s: string) => (/<[a-z][\s\S]*>/i.test(s) ? htmlToText(s) : s.trim());
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

interface ChunkRow {
  courseId: string;
  activityId: string | null;
  sourceType: 'activity' | 'course';
  sourceId: string;
  title: string;
  chunks: { heading: string; text: string; tokenCount: number }[];
}

async function replaceChunks(db: Db, src: ChunkRow) {
  const embedder = await embeddingProvider(db);
  const model = embedder?.model ?? 'none';
  const hashes = src.chunks.map((c) => hash(`${c.heading}\n${c.text}`));
  const existing = await db.contentChunk.findMany({
    where: { sourceType: src.sourceType, sourceId: src.sourceId },
    orderBy: { chunkIndex: 'asc' },
    select: { contentHash: true, embeddingModel: true },
  });
  if (
    existing.length === hashes.length &&
    existing.every((e, i) => e.contentHash === hashes[i] && e.embeddingModel === model)
  )
    return { changed: false, chunks: hashes.length };

  const vectors = embedder
    ? await embedder.embed(
        src.chunks.map((c) => `${c.heading}\n${c.text}`),
        'document',
      )
    : null;
  await db.$transaction(async (tx) => {
    await tx.contentChunk.deleteMany({
      where: { sourceType: src.sourceType, sourceId: src.sourceId },
    });
    for (const [i, c] of src.chunks.entries()) {
      const vec = vectors ? `[${vectors[i]!.join(',')}]` : null;
      const doc = `${c.heading}\n${c.text}`;
      await tx.$executeRaw`
        INSERT INTO "ContentChunk"
          ("id", "courseId", "activityId", "sourceType", "sourceId", "chunkIndex", "title", "text",
           "tokenCount", "contentHash", "embeddingModel", "embedding", "tsv")
        VALUES (
          ${uuidv7()}::uuid, ${src.courseId}::uuid, ${src.activityId}::uuid, ${src.sourceType}, ${src.sourceId},
          ${i}, ${c.heading || src.title}, ${c.text}, ${c.tokenCount}, ${hashes[i]}, ${model},
          ${vec}::vector,
          to_tsvector('russian', ${doc}) || to_tsvector('english', ${doc})
        )`;
    }
  });
  return { changed: true, chunks: src.chunks.length };
}

/** Rebuilds the chunks of one activity (or removes them when it should not be indexed). */
export async function indexActivity(db: Db, activityId: string) {
  const a = await db.activity.findUnique({ where: { id: activityId } });
  const drop = () =>
    db.contentChunk.deleteMany({ where: { sourceType: 'activity', sourceId: activityId } });
  if (!a || a.deletedAt) return { removed: (await drop()).count };
  const mod = getModule(a.moduleKey);
  if (!mod || (mod.ai?.tutorPolicy ?? 'include') !== 'include')
    return { removed: (await drop()).count };

  const ref = toActivityRef(a);
  const parts: { title?: string; text: string }[] = [];
  if (a.intro.trim()) parts.push({ text: a.intro });
  if (mod.ai?.extract) parts.push(...(await mod.ai.extract(buildModuleCtx(systemCtx(db)), ref)));
  else if (mod.extractText) parts.push({ text: mod.extractText(ref) });
  const chunks = parts.flatMap((p) =>
    chunkText(toText(p.text), { title: p.title ? `${a.name} › ${p.title}` : a.name }),
  );
  return replaceChunks(db, {
    courseId: a.courseId,
    activityId: a.id,
    sourceType: 'activity',
    sourceId: a.id,
    title: a.name,
    chunks,
  });
}

/** Indexes the course summary and every activity (admin "reindex", first enable). */
export async function indexCourse(db: Db, courseId: string) {
  const course = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  await replaceChunks(db, {
    courseId,
    activityId: null,
    sourceType: 'course',
    sourceId: courseId,
    title: course.fullName,
    chunks: chunkText(toText(course.summary), { title: course.fullName }),
  });
  const acts = await db.activity.findMany({ where: { courseId }, select: { id: true } });
  let chunks = 0;
  for (const a of acts) {
    const r = await indexActivity(db, a.id);
    chunks += 'chunks' in r ? r.chunks : 0;
  }
  return { activities: acts.length, chunks };
}

export interface RetrievedChunk {
  id: string;
  activityId: string | null;
  title: string;
  text: string;
  score: number;
}

/**
 * Hybrid retrieval restricted to `activityIds` (plus the course summary): vector
 * similarity when embeddings are configured, full-text otherwise, merged with reciprocal
 * rank fusion.
 */
export async function retrieveChunks(
  db: Db,
  courseId: string,
  query: string,
  opts: { activityIds: string[]; k?: number },
): Promise<RetrievedChunk[]> {
  const k = opts.k ?? 6;
  const ids = opts.activityIds;
  // An empty array would make the IN list invalid; course-level chunks stay reachable.
  const allowed = ids.length
    ? Prisma.sql`("activityId" IS NULL OR "activityId" IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))}))`
    : Prisma.sql`"activityId" IS NULL`;
  const lists: { id: string }[][] = [];

  const text = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ContentChunk",
      websearch_to_tsquery('russian', ${query}) qr, websearch_to_tsquery('english', ${query}) qe
    WHERE "courseId" = ${courseId}::uuid AND ${allowed} AND ("tsv" @@ qr OR "tsv" @@ qe)
    ORDER BY ts_rank("tsv", qr) + ts_rank("tsv", qe) DESC
    LIMIT ${k * 3}`;
  lists.push(text);

  const embedder = await embeddingProvider(db);
  if (embedder) {
    const [q] = await embedder.embed([query], 'query');
    const vec = `[${q!.join(',')}]`;
    const near = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ContentChunk"
      WHERE "courseId" = ${courseId}::uuid AND ${allowed}
        AND "embedding" IS NOT NULL AND "embeddingModel" = ${embedder.model}
      ORDER BY "embedding" <=> ${vec}::vector
      LIMIT ${k * 3}`;
    lists.push(near);
  }

  const score = new Map<string, number>();
  for (const list of lists)
    for (const [rank, r] of list.entries())
      score.set(r.id, (score.get(r.id) ?? 0) + 1 / (60 + rank + 1));
  const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (!top.length) return [];
  const rows = await db.contentChunk.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, activityId: true, title: true, text: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return top.flatMap(([id, s]) => {
    const r = byId.get(id);
    return r ? [{ ...r, score: s }] : [];
  });
}
