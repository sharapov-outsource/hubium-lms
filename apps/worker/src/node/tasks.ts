import { getDb, withWriteScope } from '@hubium/db';
import { log } from '@hubium/log';
import type { JobHandlerDef } from '../handlers.ts';
import { allHandlers } from '../registry.ts';

// What a node working alone does on its own database besides what people do: the scheduled
// tasks whose results people see within the hour. Overdue quiz and lesson attempts close,
// workshops move on, enrolments end, announcements appear. None goes to the journal: the
// cloud does the same by itself (docs/architecture.md §1.7). Tasks that reach outside
// (mail, push, webhooks, the directory, AI, webinars) wait for the cloud.

const logger = log('node-agent');

export const OFFLINE_TASKS = [
  'quiz.overdue.sweep',
  'lesson.overdue.sweep',
  'workshop.phase.switch',
  'enrol.expire',
  'announcements.publish',
];

const tasks: JobHandlerDef[] = allHandlers.filter((h) => OFFLINE_TASKS.includes(h.name));

/** One round of the tasks on the node's own database. */
export async function runOfflineTasks(): Promise<void> {
  const db = getDb();
  for (const def of tasks) {
    try {
      await withWriteScope(
        'job',
        def.name,
        () => def.handler({} as never, { db, jobId: `node-${def.name}` }),
        { now: new Date() },
      );
    } catch (err) {
      logger.warn({ err, task: def.name }, 'task on the node database failed');
    }
  }
}
