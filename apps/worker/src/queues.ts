import type { JobHandlerDef } from './handlers.ts';

// The parts of the worker's start that decide what happens to jobs and schedules, apart
// from pg-boss itself so that they can be tested.

interface Job {
  id: string;
  data: unknown;
}

/** What settling a batch needs of pg-boss. */
export interface JobSettler {
  complete(name: string, id: string, data?: object | null): Promise<unknown>;
  fail(name: string, id: string, data?: object | null): Promise<unknown>;
}

/**
 * Runs a batch of jobs, settling each on its own: one failure must not retry (and so
 * repeat, e.g. re-send) the jobs that already succeeded.
 */
export async function runBatch(
  boss: JobSettler,
  def: Pick<JobHandlerDef, 'name'>,
  batch: Job[],
  run: (job: Job) => Promise<unknown>,
): Promise<void> {
  for (const job of batch) {
    try {
      const out = await run(job);
      await boss.complete(def.name, job.id, (out ?? null) as object | null);
    } catch (e) {
      await boss.fail(def.name, job.id, { message: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** What dropping schedules needs of pg-boss. */
export interface ScheduleStore {
  getSchedules(): Promise<{ name: string; key: string }[]>;
  unschedule(name: string, key?: string): Promise<unknown>;
}

/**
 * Removes the cron schedules of jobs no handler runs on a schedule any more: a renamed or
 * removed task would otherwise go on making jobs that nothing takes. Returns their names.
 */
export async function dropStaleSchedules(
  boss: ScheduleStore,
  handlers: Pick<JobHandlerDef, 'name' | 'cron'>[],
): Promise<string[]> {
  const scheduled = new Set(handlers.filter((h) => h.cron).map((h) => h.name));
  const stale = (await boss.getSchedules()).filter((s) => !scheduled.has(s.name));
  for (const s of stale) await boss.unschedule(s.name, s.key);
  return stale.map((s) => s.name);
}
