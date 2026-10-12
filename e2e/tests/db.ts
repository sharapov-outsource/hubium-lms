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
