import { scormFixture } from '@hubium/mod-scorm/fixtures';
import { extractPackage } from '@hubium/mod-scorm/server';
import { strToU8, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { signContentToken, verifyContentToken } from '../content.ts';
import { appendUploadChunk, createUpload } from '../files/uploads.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { getModule } from './registry.ts';

describe('mod-scorm', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let scormId: string;
  let packageId: string;

  const upload = async (activityId: string, data: Uint8Array) => {
    const teacher = f.users.teacher!;
    const up = await createUpload(t.db, teacher, {
      name: 'course.zip',
      size: data.length,
      mimeType: 'application/zip',
    });
    await appendUploadChunk(t.db, teacher, up.id, 0, Buffer.from(data));
    capturedJobs.length = 0;
    const r = (await runModuleAction(await ctxFor(t.db, teacher), activityId, 'attachUpload', {
      uploadId: up.id,
    })) as { packageId: string };
    expect(capturedJobs.map((j) => j.name)).toEqual(['scorm.extract']);
    return r.packageId;
  };

  const content = async (
    grant: { userId: string; data: Record<string, string | number> },
    path: string[],
    init?: RequestInit,
  ) =>
    getModule('scorm')!.content!(
      buildModuleCtx(await ctxFor(t.db, 'system')),
      { activityId: scormId, token: 'x', ...grant },
      new Request(`http://content.test/c/x/${path.join('/')}`, init),
      path,
    );

  beforeAll(async () => {
    f = await courseFixture(t.db, 'SCORM1');
    scormId = (
      await f.addActivity(
        'scorm',
        'Охрана труда',
        { gradeMax: 10 },
        { completionMode: 'AUTO', completionRules: { module: { passed: true } } },
      )
    ).id;
  });

  it('signs content tokens', () => {
    const tok = signContentToken({ a: 'act', u: 'usr', d: { attempt: 'x' } });
    expect(verifyContentToken(tok)).toMatchObject({ a: 'act', u: 'usr', d: { attempt: 'x' } });
    expect(verifyContentToken(`${tok}x`)).toBeNull();
    expect(verifyContentToken(signContentToken({ a: 'a', u: 'u' }, -10))).toBeNull();
  });

  it('extracts the package and its SCOs', async () => {
    packageId = await upload(scormId, scormFixture('1.2'));
    const m = await extractPackage(buildModuleCtx(await ctxFor(t.db, 'system')), packageId);
    expect(m.version).toBe('SCORM_12');
    const pkg = await t.db.scormPackage.findUniqueOrThrow({
      where: { id: packageId },
      include: { scos: true },
    });
    expect(pkg).toMatchObject({ status: 'READY', title: 'Тестовый курс SCORM' });
    expect(pkg.files).toEqual(['imsmanifest.xml', 'sco/index.html']);
    expect(pkg.scos[0]).toMatchObject({ href: 'sco/index.html', masteryScore: 80 });
  });

  it('serves the runtime page, package files and the runtime script', async () => {
    const sco = await t.db.scormSco.findFirstOrThrow({ where: { packageId } });
    const ctx = buildModuleCtx(await ctxFor(t.db, f.users.student1!));
    const { currentAttempt } = await import('@hubium/mod-scorm/server');
    const attempt = await currentAttempt(ctx.db, scormId, f.users.student1!);
    const g = { userId: f.users.student1!, data: { attempt: attempt!.id, sco: sco.id } };
    const page = await (await content(g, ['player'])).text();
    expect(page).toContain('new Scorm12API');
    expect(page).toContain('"sco":"pkg/sco/index.html"');
    expect(page).toContain('"entry":"ab-initio"');
    const html = await content(g, ['pkg', 'sco', 'index.html']);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toContain('frame-ancestors');
    expect((await content(g, ['pkg', '..', 'imsmanifest.xml'])).status).toBe(404);
    const rt = await content(g, ['runtime', 'scorm12.min.js']);
    expect(rt.status).toBe(200);
    expect((await rt.text()).startsWith('this.Scorm12API=')).toBe(true);
  });

  it('records commits, resumes and grades', async () => {
    const sco = await t.db.scormSco.findFirstOrThrow({ where: { packageId } });
    const attempt = await t.db.scormAttempt.findFirstOrThrow({
      where: { activityId: scormId, userId: f.users.student1 },
    });
    const g = { userId: f.users.student1!, data: { attempt: attempt.id, sco: sco.id } };
    const commit = (cmi: object) =>
      content(g, ['commit'], {
        method: 'POST',
        body: JSON.stringify({ cmi }),
        headers: { 'content-type': 'text/plain' },
      });
    const r1 = await commit({
      core: {
        lesson_status: 'incomplete',
        lesson_location: 'page-2',
        exit: 'suspend',
        session_time: '00:01:30',
      },
      suspend_data: 'visited=1',
    });
    expect(await r1.json()).toEqual({ result: true, errorCode: 0 });
    // the same session commits again (autocommit): time is not double counted
    await commit({
      core: {
        lesson_status: 'incomplete',
        lesson_location: 'page-2',
        exit: 'suspend',
        session_time: '00:01:30',
      },
      suspend_data: 'visited=1',
    });
    let track = await t.db.scormTrack.findFirstOrThrow({ where: { attemptId: attempt.id } });
    expect(track).toMatchObject({
      location: 'page-2',
      suspendData: 'visited=1',
      totalTimeSec: 90,
      completionStatus: 'incomplete',
    });

    // relaunch resumes where the learner stopped
    const page = await (await content(g, ['player'])).text();
    expect(page).toContain('"entry":"resume"');
    expect(page).toContain('"lesson_location":"page-2"');
    await commit({
      core: { lesson_status: 'passed', exit: '', session_time: '00:00:30', score: { raw: '85' } },
    });
    track = await t.db.scormTrack.findFirstOrThrow({ where: { attemptId: attempt.id } });
    expect(track).toMatchObject({ completionStatus: 'passed', scoreRaw: 85, totalTimeSec: 120 });
    const done = await t.db.scormAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done.finishedAt).not.toBeNull();
    expect(done.score).toBe(85);
    const item = await t.db.gradeItem.findFirstOrThrow({ where: { activityId: scormId } });
    const grade = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(grade.finalGrade)).toBe(8.5);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: scormId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE_PASS');
  });

  it('rejects malformed commits and foreign attempts', async () => {
    const sco = await t.db.scormSco.findFirstOrThrow({ where: { packageId } });
    const attempt = await t.db.scormAttempt.findFirstOrThrow({
      where: { activityId: scormId, userId: f.users.student1 },
    });
    const bad = await content(
      { userId: f.users.student1!, data: { attempt: attempt.id, sco: sco.id } },
      ['commit'],
      { method: 'POST', body: 'not json' },
    );
    expect(await bad.json()).toEqual({ result: false, errorCode: 101 });
    const foreign = await content(
      { userId: f.users.student2!, data: { attempt: attempt.id, sco: sco.id } },
      ['commit'],
      { method: 'POST', body: JSON.stringify({ cmi: { core: { lesson_status: 'failed' } } }) },
    );
    expect(await foreign.json()).toEqual({ result: false, errorCode: 101 });
  });

  it('new attempts after finishing, within the limit', async () => {
    const s1 = await ctxFor(t.db, f.users.student1!);
    expect(await runModuleAction(s1, scormId, 'newAttempt', {})).toEqual({ attempt: 2 });
    await expect(runModuleAction(s1, scormId, 'newAttempt', {})).rejects.toThrow(
      'Finish the current attempt',
    );
  });

  it('marks unsafe packages as failed', async () => {
    const { id } = await f.addActivity('scorm', 'Плохой пакет', {});
    const evil = zipSync({ 'imsmanifest.xml': strToU8('<manifest/>'), '../evil.js': strToU8('x') });
    const pkg = await upload(id, evil);
    await expect(extractPackage(buildModuleCtx(await ctxFor(t.db, 'system')), pkg)).rejects.toThrow(
      'Unsafe path',
    );
    expect((await t.db.scormPackage.findUniqueOrThrow({ where: { id: pkg } })).status).toBe(
      'FAILED',
    );
  });
});
