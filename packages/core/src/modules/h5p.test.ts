import { h5pFixture } from '@hubium/mod-h5p/fixtures';
import { extractPackage, key } from '@hubium/mod-h5p/server';
import { PermanentJobError } from '@hubium/module-sdk';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { getStorage } from '../files/storage.ts';
import { appendUploadChunk, createUpload } from '../files/uploads.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { getModule } from './registry.ts';

describe('mod-h5p', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let h5pId: string;
  let packageId: string;

  const upload = async (activityId: string, data: Uint8Array) => {
    const teacher = f.users.teacher!;
    const up = await createUpload(t.db, teacher, {
      name: 'check.h5p',
      size: data.length,
      mimeType: 'application/zip',
    });
    await appendUploadChunk(t.db, teacher, up.id, 0, Buffer.from(data));
    capturedJobs.length = 0;
    const r = (await runModuleAction(await ctxFor(t.db, teacher), activityId, 'attachUpload', {
      uploadId: up.id,
    })) as { packageId: string };
    expect(capturedJobs.map((j) => j.name)).toEqual(['h5p.extract']);
    return r.packageId;
  };

  const content = async (
    grant: { userId: string; data: Record<string, string | number> },
    path: string[],
    init?: RequestInit,
    activityId = h5pId,
  ) =>
    getModule('h5p')!.content!(
      buildModuleCtx(await ctxFor(t.db, 'system')),
      { activityId, token: 'x', ...grant },
      new Request(`http://content.test/c/x/${path.join('/')}`, init),
      path,
    );

  const statement = (raw: number, more: object = {}) => ({
    method: 'POST',
    body: JSON.stringify({
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      result: { score: { raw, max: 4 }, completion: true, success: raw >= 3, duration: 'PT45S' },
      ...more,
    }),
  });

  beforeAll(async () => {
    f = await courseFixture(t.db, 'H5P1');
    h5pId = (
      await f.addActivity(
        'h5p',
        'Таблица умножения',
        { gradeMax: 10, gradeMethod: 'HIGHEST' },
        { completionMode: 'AUTO', completionRules: { module: { passed: true } } },
      )
    ).id;
  });

  it('unpacks a package with its libraries', async () => {
    packageId = await upload(h5pId, h5pFixture());
    const info = await extractPackage(buildModuleCtx(await ctxFor(t.db, 'system')), packageId);
    expect(info.libraries).toEqual(['H5P.HubiumCheck-1.0']);
    const pkg = await t.db.h5pPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg).toMatchObject({
      status: 'READY',
      title: 'Проверка',
      mainLibrary: 'H5P.HubiumCheck',
    });
    expect([...(pkg.files as string[])].sort()).toEqual([
      'H5P.HubiumCheck-1.0/check.js',
      'H5P.HubiumCheck-1.0/library.json',
      'content/content.json',
      'h5p.json',
    ]);
  });

  it('serves the player, the package and the player scripts', async () => {
    const g = { userId: f.users.student1!, data: { track: 1 } };
    const page = await content(g, ['player']);
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors');
    const html = await page.text();
    expect(html).toContain('new H5PStandalone.H5P');
    expect(html).toContain('"track":true');
    const json = await content(g, ['pkg', 'content', 'content.json']);
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.json()).toMatchObject({ yes: 'Да' });
    expect((await content(g, ['pkg', '..', 'h5p.json'])).status).toBe(404);
    const main = await content(g, ['runtime', 'main.bundle.js']);
    expect(main.status).toBe(200);
    expect(main.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await content(g, ['runtime', 'styles', 'h5p.css'])).status).toBe(200);
    expect((await content(g, ['runtime', 'h5p.d.ts'])).status).toBe(404);
    expect((await content(g, ['runtime', '..', 'package.json'])).status).toBe(404);
  });

  it('each top-level result is an attempt; the grade follows the grading method', async () => {
    const g = { userId: f.users.student1!, data: { track: 1 } };
    // a question inside a set reports to its parent: not an attempt
    const inner = await content(
      g,
      ['xapi'],
      statement(4, { context: { contextActivities: { parent: [{ id: 'set' }] } } }),
    );
    expect(await inner.json()).toEqual({ recorded: false });
    expect(await (await content(g, ['xapi'], statement(2))).json()).toEqual({ recorded: true });
    expect(await (await content(g, ['xapi'], statement(3))).json()).toEqual({ recorded: true });
    const attempts = await t.db.h5pAttempt.findMany({
      where: { activityId: h5pId, userId: f.users.student1! },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts.map((x) => [x.attemptNumber, x.scaled, x.success, x.durationSec])).toEqual([
      [1, 0.5, false, 45],
      [2, 0.75, true, 45],
    ]);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: h5pId } });
    const grade = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(grade.finalGrade)).toBe(7.5);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: h5pId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE_PASS');
  });

  it('records nothing when the frame was opened without tracking, or for junk', async () => {
    const preview = { userId: f.users.teacher!, data: { track: 0 } };
    expect(await (await content(preview, ['xapi'], statement(4))).json()).toEqual({
      recorded: false,
    });
    const g = { userId: f.users.student2!, data: { track: 1 } };
    expect((await content(g, ['xapi'], { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await content(g, ['xapi'], { method: 'POST', body: 'x'.repeat(70_000) })).status).toBe(
      413,
    );
    expect(await t.db.h5pAttempt.count({ where: { userId: f.users.teacher! } })).toBe(0);
    expect(await t.db.h5pAttempt.count({ where: { userId: f.users.student2! } })).toBe(0);
    // with tracking off in the settings, a tracked frame records nothing either
    const { id } = await f.addActivity('h5p', 'Без учёта', { tracking: false });
    await extractPackage(
      buildModuleCtx(await ctxFor(t.db, 'system')),
      await upload(id, h5pFixture()),
    );
    const r = await content(g, ['xapi'], statement(4), id);
    expect(await r.json()).toEqual({ recorded: false });
    expect(await t.db.gradeItem.count({ where: { activityId: id } })).toBe(0);
  });

  it('says what is wrong with a package, and leaves out files H5P does not accept', async () => {
    const { id } = await f.addActivity('h5p', 'Без библиотек', {});
    const sys = buildModuleCtx(await ctxFor(t.db, 'system'));
    const bare = await upload(id, h5pFixture({ withLibrary: false }));
    await expect(extractPackage(sys, bare)).rejects.toThrow(
      'does not include the library H5P.HubiumCheck-1.0',
    );
    // what the package is fails at every try: the job is not retried, and what it stored goes
    await expect(extractPackage(sys, bare)).rejects.toBeInstanceOf(PermanentJobError);
    expect(await getStorage().head(key(bare, 'h5p.json'))).toBeNull();
    expect(await t.db.h5pPackage.findUniqueOrThrow({ where: { id: bare } })).toMatchObject({
      status: 'FAILED',
    });
    // a page smuggled into the package is not stored
    const files = unzipSync(h5pFixture());
    const pkg = await upload(id, zipSync({ ...files, 'content/evil.html': strToU8('<p>x</p>') }));
    await extractPackage(sys, pkg);
    const row = await t.db.h5pPackage.findUniqueOrThrow({ where: { id: pkg } });
    expect(row.status).toBe('READY');
    expect(row.files).not.toContain('content/evil.html');
  });

  it('reset removes the attempts', async () => {
    await getModule('h5p')!.reset!.userData!(
      buildModuleCtx(await ctxFor(t.db, 'system')),
      (await t.db.activity.findUniqueOrThrow({ where: { id: h5pId } })) as never,
    );
    expect(await t.db.h5pAttempt.count({ where: { activityId: h5pId } })).toBe(0);
  });
});
