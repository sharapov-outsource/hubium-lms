import type pg from 'pg';

// What the agent reads of the journal on the node's own database (B) while it is in use.

/** Journal entries the cloud has not taken yet. */
export async function pendingJournal(b: pg.Pool): Promise<number> {
  const { rows } = await b.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "NodeOp" WHERE status = 'PENDING'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Quizzes with a time limit (or closing time) someone is still answering: the sync waits
 * for them, so a timed attempt does not end half here and half in the cloud.
 */
export async function runningTimedAttempts(b: pg.Pool): Promise<number> {
  const { rows } = await b.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "QuizAttempt"
      WHERE state = 'IN_PROGRESS' AND preview = false AND "dueAt" > now()`,
  );
  return Number(rows[0]?.n ?? 0);
}
