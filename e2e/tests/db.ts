import pg from 'pg';

export async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function setSetting(key: string, value: unknown) {
  await sql(
    `INSERT INTO "SiteSetting"(key, value, "updatedAt") VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
    [key, JSON.stringify(value)],
  );
  await sql(`SELECT pg_notify('hubium_cache', 'settings')`);
}

/** Removes a course a test created, with everything below it and its question bank. */
export async function deleteCourse(id: string) {
  await sql(`DELETE FROM "Context" WHERE id = $1`, [id]);
  // categories are keyed by context id without a foreign key
  await sql(`DELETE FROM "QuestionCategory" WHERE "contextId" = $1`, [id]);
}
