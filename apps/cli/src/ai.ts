import { parseArgs } from 'node:util';
import { embeddingProvider, INDEX_COURSE_JOB, indexCourse } from '@hubium/core';
import { enqueue } from '@hubium/core/jobs/jobs';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { loadApp, withDb } from './system.ts';

// `hubium ai reindex`: rebuilds the course text (and its embeddings) that the AI tutor and
// quiz generation retrieve from, e.g. after changing the embedding model. By default the
// worker does it (one job per course); --sync does it here and reports each course.

export async function aiCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { course: { type: 'string' }, sync: { type: 'boolean' } },
  });
  const [action] = positionals;
  if (action !== 'reindex')
    throw new UsageError(action ? `Unknown action "ai ${action}".` : 'Use: hubium ai reindex');
  if (values.course && !/^[0-9a-f-]{36}$/i.test(values.course))
    throw new UsageError('--course takes a course id (a UUID).');
  return withDb(async (db) => {
    await loadApp();
    const courses = await db.course.findMany({
      where: { deletedAt: null, ...(values.course ? { id: values.course } : {}) },
      select: { id: true, shortName: true },
      orderBy: { createdAt: 'asc' },
    });
    if (values.course && !courses.length)
      throw new UsageError(`No course with id ${values.course}.`);
    const embedder = await embeddingProvider(db);
    if (!embedder)
      io.err('No embedding endpoint is configured: only full-text search will be indexed.');
    if (!values.sync) {
      for (const c of courses) await enqueue(INDEX_COURSE_JOB, { courseId: c.id });
      io.out(`Queued ${courses.length} course(s) for the worker.`);
      return 0;
    }
    let failed = 0;
    for (const c of courses) {
      try {
        const r = await indexCourse(db, c.id);
        io.out(`${c.shortName}: ${r.activities} activities, ${r.chunks} chunks`);
      } catch (e) {
        failed++;
        io.err(`${c.shortName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    io.out(`Indexed ${courses.length - failed} of ${courses.length} course(s).`);
    return failed ? 1 : 0;
  });
}
