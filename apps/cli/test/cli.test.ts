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
    expect((await run('modules', 'disable', 'wiki')).err).toContain('Unknown activity type: wiki');
    expect(await run('modules', 'enable', 'video', 'livesession')).toMatchObject({
      code: 0,
      out: 'All activity types are on.',
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
