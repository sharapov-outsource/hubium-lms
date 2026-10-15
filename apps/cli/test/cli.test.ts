import { createTestDatabase, type TestDatabase } from '@hubium/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli } from '../src/main.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function run(...argv: string[]) {
  const c = capture();
  const code = await cli(argv, c.io);
  return { code, out: c.out.join('\n'), err: c.err.join('\n') };
}

describe('hubium', () => {
  let t: TestDatabase;
  const saved = process.env.DATABASE_URL;

  beforeAll(async () => {
    t = await createTestDatabase();
    process.env.DATABASE_URL = t.url;
  });
  afterAll(async () => {
    process.env.DATABASE_URL = saved;
    await t?.drop();
  });

  it('prints its version and help, and refuses unknown commands', async () => {
    const v = await run('version', '--json');
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out)).toMatchObject({ node: process.version });
    expect((await run('help')).out).toContain('migrate --seed <profile>');
    const bad = await run('frobnicate');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('Unknown command "frobnicate"');
    const noProfile = await run('migrate');
    expect(noProfile.code).toBe(1);
    expect(noProfile.err).toContain('Choose --seed minimal, demo or none');
  });

  it('checks a migrated database', async () => {
    const r = await run('doctor', 'db', '--json');
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { state: string; pending: string[] };
    expect(report).toMatchObject({ state: 'hubium', pending: [] });
    expect((await run('doctor', 'db')).out).toContain('Everything is in order.');
  });

  it('turns activity types off and on', async () => {
    const off = await run('modules', 'disable', 'video', 'livesession');
    expect(off).toMatchObject({ code: 0, out: 'Turned off: livesession, video' });
    const list = JSON.parse((await run('modules', 'list', '--json')).out) as {
      key: string;
      enabled: boolean;
    }[];
    expect(list.find((m) => m.key === 'video')?.enabled).toBe(false);
    expect(list.find((m) => m.key === 'quiz')?.enabled).toBe(true);
    expect((await run('modules', 'disable', 'page')).err).toContain('cannot be turned off');
    expect((await run('modules', 'disable', 'nosuchmodule')).err).toContain(
      'Unknown activity type: nosuchmodule',
    );
    expect(await run('modules', 'enable', 'video', 'livesession')).toMatchObject({
      code: 0,
      out: 'All activity types are on.',
    });
  });

  it('turns maintenance mode on and off', async () => {
    expect((await run('maintenance')).out).toBe('Maintenance mode is off.');
    const on = await run(
      'maintenance',
      'on',
      '--message',
      'Обновление до 18:00',
      '--until',
      '2030-01-01T18:00:00+03:00',
    );
    expect(on.code).toBe(0);
    expect(on.out).toContain('Maintenance mode is on');
    expect(JSON.parse((await run('maintenance', 'status', '--json')).out)).toEqual({
      enabled: true,
      message: 'Обновление до 18:00',
      until: '2030-01-01T15:00:00.000Z',
    });
    expect((await run('maintenance', 'on', '--until', 'soon')).err).toContain('--until takes');
    expect((await run('maintenance', 'off')).out).toBe('Maintenance mode is off.');
    expect(JSON.parse((await run('maintenance', 'status', '--json')).out)).toMatchObject({
      enabled: false,
      until: null,
    });
  });

  it('seeds the first administrator only with a password in production', async () => {
    const env = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.SEED_ADMIN_EMAIL = 'first@hubium.test';
    delete process.env.SEED_ADMIN_PASSWORD;
    try {
      const refused = await run('seed', '--profile', 'minimal');
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('Set SEED_ADMIN_PASSWORD');
      process.env.SEED_ADMIN_PASSWORD = 'Strong-Passw0rd!';
      const ok = await run('seed', '--profile', 'minimal');
      expect(ok).toMatchObject({
        code: 0,
        out: 'Seed (minimal): administrator first@hubium.test created',
      });
      // later runs need no password: the administrator exists
      delete process.env.SEED_ADMIN_PASSWORD;
      expect((await run('seed', '--profile', 'minimal')).code).toBe(0);
      // nor once the administrator has changed their email
      await t.db.user.update({
        where: { email: 'first@hubium.test' },
        data: { email: 'owner@hubium.test' },
      });
      expect(await run('seed', '--profile', 'minimal')).toMatchObject({
        code: 0,
        out: 'Seed (minimal): administrator exists',
      });
    } finally {
      process.env = env;
    }
  });

  it('takes the embedding endpoint from the environment once and reindexes', async () => {
    const env = { ...process.env };
    Object.assign(process.env, {
      AI_EMBEDDINGS_URL: 'http://ollama.test:11434/v1',
      AI_EMBEDDINGS_MODEL: 'bge-m3',
    });
    try {
      // an internal host has to be allowed first
      const refused = await run('seed', '--profile', 'minimal');
      expect(refused.err).toContain('AI_EMBEDDINGS_URL is not used');
      expect(await t.db.aiEmbeddingConfig.count()).toBe(0);
      process.env.SSRF_ALLOW_HOSTS = 'ollama.test';
      const seeded = await run('seed', '--profile', 'minimal');
      expect(seeded.out).toContain('embeddings: bge-m3 at http://ollama.test:11434/v1');
      expect(await t.db.aiEmbeddingConfig.findUnique({ where: { id: 'default' } })).toMatchObject({
        kind: 'OPENAI_COMPAT',
        model: 'bge-m3',
        dims: 1024,
      });
      // what the administrator chose later stays
      await t.db.aiEmbeddingConfig.update({
        where: { id: 'default' },
        data: { kind: 'MOCK', model: 'mock-hash', baseUrl: null },
      });
      process.env.AI_EMBEDDINGS_MODEL = 'nomic-embed-text';
      expect((await run('seed', '--profile', 'demo')).out).not.toContain('embeddings');
      expect(
        (await t.db.aiEmbeddingConfig.findUniqueOrThrow({ where: { id: 'default' } })).model,
      ).toBe('mock-hash');

      const courses = await t.db.course.count({ where: { deletedAt: null } });
      expect(courses).toBeGreaterThan(0);
      const queued = await run('ai', 'reindex');
      expect(queued).toMatchObject({ code: 0, out: `Queued ${courses} course(s) for the worker.` });
      const [jobs] = await t.db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pgboss.job WHERE name = 'ai.index.course'`;
      expect(Number(jobs!.n)).toBe(courses);

      const course = await t.db.course.findFirstOrThrow({ where: { shortName: 'DEMO-PY' } });
      const sync = await run('ai', 'reindex', '--course', course.id, '--sync');
      expect(sync.code).toBe(0);
      expect(sync.out).toMatch(
        /^DEMO-PY: \d+ activities, \d+ chunks\nIndexed 1 of 1 course\(s\)\.$/,
      );
      const [vectors] = await t.db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "ContentChunk"
        WHERE "courseId" = ${course.id}::uuid AND "embedding" IS NOT NULL`;
      expect(Number(vectors!.n)).toBeGreaterThan(0);

      expect((await run('ai', 'reindex', '--course', 'nope')).err).toContain('a course id');
      expect((await run('ai', 'forget')).err).toContain('Unknown action "ai forget"');
    } finally {
      process.env = env;
    }
  });

  it('installs into an empty database', async () => {
    const name = `hubium_cli_${Date.now().toString(36)}`;
    await t.db.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    const url = new URL(t.url);
    url.pathname = `/${name}`;
    const env = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      SEED_ADMIN_EMAIL: 'owner@hubium.test',
      SEED_ADMIN_PASSWORD: 'Strong-Passw0rd!',
    });
    try {
      const r = await run('migrate', '--seed', 'minimal', '--disable-modules', 'video,lti');
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Activity types turned off: lti, video');
      expect(r.out).toContain('administrator owner@hubium.test created');
      // a second run changes nothing
      const again = await run('migrate', '--seed', 'minimal');
      expect(again.out).toContain('Migrations: up to date');
      expect(again.out).toContain('administrator exists');
      expect(JSON.parse((await run('doctor', 'db', '--json')).out)).toMatchObject({
        state: 'hubium',
        pending: [],
      });
    } finally {
      process.env = env;
      await t.db.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });
});
