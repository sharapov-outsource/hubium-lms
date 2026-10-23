import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import pg from 'pg';
import { sql } from '../tests/db';
import { nodeState, WORK } from './stack';

/** Waits until node i is in a mode (its agent decides once a second). */
export async function waitForMode(i: number, mode: string, timeout = 120_000) {
  await expect
    .poll(async () => (await nodeState(i).catch(() => ({ mode: '?' }))).mode, {
      timeout,
      intervals: [500, 1000],
    })
    .toBe(mode);
}

/** The demo course and its activities, as the cloud has them. */
export async function demoCourse() {
  const [row] = await sql<{ courseId: string; quizId: string; forumId: string; assignId: string }>(
    `SELECT c.id AS "courseId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'quiz' LIMIT 1) AS "quizId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'forum' LIMIT 1) AS "forumId",
            (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'assign' LIMIT 1) AS "assignId"
       FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  if (!row?.quizId) throw new Error('The demo course is missing (seed --profile demo)');
  return row;
}

/** A query on node i's own database (B), which holds what the node did without a connection. */
export async function nodeSql<T = Record<string, unknown>>(
  i: number,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const node = JSON.parse(readFileSync(path.join(WORK, `n${i}`, 'node.json'), 'utf8')) as {
    env: { NODE_DATABASE_B_URL: string };
  };
  const c = new pg.Client({ connectionString: node.env.NODE_DATABASE_B_URL });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}

/**
 * What a quiz attempt left: the attempt, its questions and their steps, the person's grade
 * and completion of the quiz. The cloud replaying the node's journal must come to the same.
 */
export const ATTEMPT_RESULT = `
  SELECT json_build_object(
    'attempt', (SELECT row_to_json(a) FROM "QuizAttempt" a WHERE a.id = $1),
    'questions', (SELECT json_agg(q ORDER BY q.slot) FROM "QuestionAttempt" q WHERE q."attemptId" = $1),
    'steps', (SELECT json_agg(s ORDER BY s.id) FROM "QuestionAttemptStep" s
                JOIN "QuestionAttempt" q ON q.id = s."questionAttemptId" WHERE q."attemptId" = $1),
    'grade', (SELECT row_to_json(g) FROM "Grade" g JOIN "GradeItem" i ON i.id = g."gradeItemId"
               JOIN "QuizAttempt" a ON a.id = $1
               WHERE i."activityId" = a."activityId" AND g."userId" = a."userId"),
    'completion', (SELECT row_to_json(c) FROM "ActivityCompletion" c JOIN "QuizAttempt" a ON a.id = $1
                    WHERE c."activityId" = a."activityId" AND c."userId" = a."userId")
  ) AS result`;
