import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcodeAsset } from '@hubium/mod-video/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { appendUploadChunk, createUpload, getUpload } from '../files/uploads.ts';
import { runModuleAction } from './actions.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { getModule } from './registry.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('mod-video: upload, transcode, stream, progress', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let videoId: string;
  let clip: Buffer;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'VIDEO1');
    videoId = (
      await f.addActivity(
        'video',
        'Лекция 1',
        { source: 'upload', noSeekAhead: true },
        { completionMode: 'AUTO', completionRules: { module: { minPercent: 90 } } },
      )
    ).id;
    const dir = mkdtempSync(path.join(tmpdir(), 'clip-'));
    const file = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=8:size=1280x720:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=8',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
    clip = readFileSync(file);
  }, 60_000);

  it('resumable upload: chunks must arrive at the current offset', async () => {
    const teacher = f.users.teacher!;
    const up = await createUpload(t.db, teacher, {
      name: 'clip.mp4',
      size: clip.length,
      mimeType: 'video/mp4',
    });
    const half = Math.floor(clip.length / 2);
    expect(await appendUploadChunk(t.db, teacher, up.id, 0, clip.subarray(0, half))).toEqual({
      received: half,
    });
    // a retried or out-of-order chunk is rejected with the server position
    expect(await appendUploadChunk(t.db, teacher, up.id, 0, clip.subarray(0, 10))).toEqual({
      received: half,
      conflict: true,
    });
    await expect(
      appendUploadChunk(t.db, f.users.student1!, up.id, half, clip.subarray(half)),
    ).rejects.toThrow();
    await appendUploadChunk(t.db, teacher, up.id, half, clip.subarray(half));
    expect(await getUpload(t.db, teacher, up.id)).toMatchObject({
      received: clip.length,
      done: false,
    });

    capturedJobs.length = 0;
    // students cannot attach videos
    await expect(
      runModuleAction(await ctxFor(t.db, f.users.student1!), videoId, 'attachUpload', {
        uploadId: up.id,
      }),
    ).rejects.toThrow();
    const r = (await runModuleAction(await ctxFor(t.db, teacher), videoId, 'attachUpload', {
      uploadId: up.id,
    })) as { assetId: string };
    expect(capturedJobs.map((j) => j.name)).toEqual(['video.transcode']);
    expect(await getUpload(t.db, teacher, up.id)).toMatchObject({ done: true });

    // run the job as the worker would
    const sys = buildModuleCtx(await ctxFor(t.db, 'system'));
    const outputs = await transcodeAsset(sys, r.assetId);
    expect(outputs.renditions?.map((x) => x.height)).toEqual([360, 720]);
    expect(outputs.files).toEqual(
      expect.arrayContaining([
        'master.m3u8',
        'v0/index.m3u8',
        'v1/init_1.mp4',
        'poster.jpg',
        'sprite.vtt',
      ]),
    );
    const asset = await t.db.videoAsset.findUniqueOrThrow({ where: { id: r.assetId } });
    expect(asset).toMatchObject({ status: 'READY', progress: 100, width: 1280, height: 720 });
    expect(asset.durationSec).toBeGreaterThan(7.5);
  }, 120_000);

  it('serves HLS only to people who can open the activity', async () => {
    const http = getModule('video')!.http!;
    const get = async (user: string, file: string) =>
      http(
        buildModuleCtx(await ctxFor(t.db, user)),
        new Request(`http://x/api/mod/video/${videoId}/hls/${file}`),
        [videoId, 'hls', ...file.split('/')],
      );
    const master = await get(f.users.student1!, 'master.m3u8');
    expect(master.status).toBe(200);
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await master.text();
    expect(text).toContain('#EXT-X-STREAM-INF');
    expect(text).toContain('v1/index.m3u8');
    const variant = await (await get(f.users.student1!, 'v0/index.m3u8')).text();
    expect(variant).toContain('#EXT-X-MAP:URI="init_0.mp4"');
    expect((await get(f.users.student1!, '../../etc/passwd')).status).toBe(400);
    expect((await get(f.users.student1!, 'missing.m4s')).status).toBe(404);
    const outsider = await t.db.user.create({
      data: { email: 'outsider@test.local', name: 'Посторонний' },
    });
    expect((await get(outsider.id, 'master.m3u8')).status).toBe(403);
  });

  it('merges watched intervals and completes at 90%', async () => {
    const s1 = await ctxFor(t.db, f.users.student1!);
    const send = (intervals: [number, number][]) =>
      runModuleAction(s1, videoId, 'progress', {
        intervals,
        duration: 999,
        position: intervals.at(-1)![1],
      });
    // the client-reported duration is ignored for uploads
    expect(await send([[0, 4]])).toEqual({ percent: expect.closeTo(50, 0) });
    expect(await send([[3, 6]])).toEqual({ percent: expect.closeTo(75, 0) });
    const c0 = await t.db.activityCompletion.findUnique({
      where: { activityId_userId: { activityId: videoId, userId: f.users.student1! } },
    });
    expect(c0?.state ?? 'INCOMPLETE').not.toBe('COMPLETE');
    await send([[6, 7.6]]);
    const p = await t.db.videoProgress.findUniqueOrThrow({
      where: { activityId_userId: { activityId: videoId, userId: f.users.student1! } },
    });
    expect(p.intervals).toEqual([[0, 7.6]]);
    const c = await t.db.activityCompletion.findUniqueOrThrow({
      where: { activityId_userId: { activityId: videoId, userId: f.users.student1! } },
    });
    expect(c.state).toBe('COMPLETE');
  });

  it('converts SRT captions and serves them as files', async () => {
    const teacher = await ctxFor(t.db, f.users.teacher!);
    await runModuleAction(teacher, videoId, 'addCaption', {
      lang: 'ru',
      label: 'Русский',
      files: [
        {
          name: 'ru.srt',
          mimeType: 'application/x-subrip',
          data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nПривет\n'),
        },
      ],
    });
    const cap = await t.db.videoCaption.findFirstOrThrow({ where: { lang: 'ru' } });
    const file = await t.db.file.findUniqueOrThrow({ where: { id: cap.fileId } });
    expect(file.mimeType).toBe('text/vtt');
    expect(file.name).toBe('ru.vtt');
  });
});
