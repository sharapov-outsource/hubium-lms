import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// Video upload → HLS transcoding in the media worker → playback page → watch completion;
// a live session page with its join window. Needs ffmpeg and WORKER_QUEUES=default,media.

test.describe
  .serial('media', () => {
    let courseId = '';
    let videoUrl = '';
    let clip = '';

    test.beforeAll(async () => {
      const [c] = await sql<{ id: string }>(
        `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
      );
      courseId = c!.id;
      const dir = mkdtempSync(path.join(tmpdir(), 'e2e-clip-'));
      clip = path.join(dir, 'lecture.mp4');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=12:size=1920x1080:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:duration=12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-shortest',
        clip,
      ]);
    });

    test('teacher uploads a 1080p video and it is transcoded', async ({ page }) => {
      test.setTimeout(330_000);
      await login(page, 'teacher', DEMO_PASSWORD);
      const [section] = await sql<{ id: string }>(
        `SELECT id FROM "CourseSection" WHERE "courseId" = $1 ORDER BY rank LIMIT 1`,
        [courseId],
      );
      await page.goto(`/course/${courseId}/a/new?module=video&section=${section!.id}`);
      await page.locator('#f-name').fill(`Видео ${Date.now().toString(36)}`);
      await page.locator('#f-completionMode').selectOption('AUTO');
      await page.locator('#vc-minPercent').fill('90');
      await page.getByRole('button', { name: /^Создать$/ }).click();
      await page.waitForURL(/\?edit=1/);
      const [act] = await sql<{ id: string }>(
        `SELECT id FROM "Activity" WHERE "courseId" = $1 AND "moduleKey" = 'video' ORDER BY "createdAt" DESC LIMIT 1`,
        [courseId],
      );
      videoUrl = `/course/${courseId}/a/${act!.id}`;
      await page.goto(videoUrl);
      await page.locator('#video-file').setInputFiles(clip);
      await expect(page.getByText('Видео загружено и отправлено на обработку')).toBeVisible({
        timeout: 60_000,
      });
      // three renditions of a 1080p clip; slow CI machines need a few minutes
      await expect(page.getByText('Готово', { exact: true })).toBeVisible({ timeout: 270_000 });
      await expect(page.getByText('360p · 720p · 1080p')).toBeVisible();
      await expectAccessible(page);
    });

    test('student sees the player and completes at 90% watched', async ({ page }) => {
      await login(page, 'student1', DEMO_PASSWORD);
      await page.goto(videoUrl);
      await expect(page.locator('media-controller')).toBeVisible();
      const master = await page.request.get(
        `${videoUrl.replace(/^\/course\/[^/]+\/a\//, '/api/mod/video/')}/hls/master.m3u8`,
      );
      expect(master.status()).toBe(200);
      expect(await master.text()).toContain('RESOLUTION=1920x1080');
      const activityId = videoUrl.split('/').at(-1)!;
      // headless Chromium lacks H.264, so report watching the way the player does
      const send = (intervals: [number, number][]) =>
        page.evaluate(
          async ({ activityId, intervals }) => {
            const fd = new FormData();
            fd.set('activityId', activityId);
            fd.set('action', 'progress');
            fd.set(
              'input',
              JSON.stringify({ intervals, duration: 12, position: intervals.at(-1)![1] }),
            );
            return (await fetch('/api/mod/action', { method: 'POST', body: fd })).json();
          },
          { activityId, intervals },
        );
      expect((await send([[0, 6]])).data.percent).toBe(50);
      expect((await send([[6, 11]])).data.percent).toBeGreaterThanOrEqual(90);
      await page.reload();
      await expect(page.getByRole('progressbar', { name: /Просмотрено 9\d%/ })).toBeVisible();
      await expect(page.getByText('Выполнено').first()).toBeVisible();
      await expectAccessible(page);
    });

    test('live session page shows the schedule and a join button for the host', async ({
      page,
    }) => {
      await login(page, 'teacher', DEMO_PASSWORD);
      const [live] = await sql<{ id: string }>(
        `SELECT id FROM "Activity" WHERE "courseId" = $1 AND "moduleKey" = 'livesession' LIMIT 1`,
        [courseId],
      );
      await page.goto(`/course/${courseId}/a/${live!.id}`);
      await expect(page.getByText('Запланирован')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Начать / подключиться' })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Посещаемость/ })).toBeVisible();
      await expectAccessible(page);
      await logout(page);
      await login(page, 'student1', DEMO_PASSWORD);
      await page.goto(`/course/${courseId}/a/${live!.id}`);
      await expect(page.getByText(/Вход откроется/)).toBeVisible();
    });
  });
