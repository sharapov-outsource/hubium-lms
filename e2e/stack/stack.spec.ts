import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login } from '../tests/helpers';

// What only the production images can get wrong: resumable uploads through Caddy into the
// web container, a worker in another container reading them, transcoding by worker-media
// (its own ffmpeg, CPU and memory limits) into S3, and playback of the HLS ladder in a
// browser that decodes H.264. Meant for a throwaway stack: the video and the restored
// course stay.

test.describe
  .serial('production stack', () => {
    let clip = '';
    let courseUrl = '';
    let videoUrl = '';

    test.beforeAll(() => {
      clip = path.join(mkdtempSync(path.join(tmpdir(), 'stack-clip-')), 'lecture.mp4');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=20:size=1920x1080:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:duration=20',
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

    test('teacher uploads a 1080p video and worker-media transcodes it', async ({ page }) => {
      test.setTimeout(330_000);
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.getByRole('link', { name: 'Python для начинающих' }).first().click();
      await page.waitForURL(/\/course\/[^/?]+$/);
      courseUrl = new URL(page.url()).pathname;
      await page.goto(`${courseUrl}?edit=1`);
      await page.getByRole('button', { name: 'Добавить элемент' }).first().click();
      await page
        .getByRole('dialog')
        .getByRole('link', { name: /^Видео/ })
        .click();
      await page.waitForURL(/\/a\/new\?module=video/);
      await page.locator('#f-name').fill(`Видео ${Date.now().toString(36)}`);
      await page.getByRole('button', { name: /^Создать$/ }).click();
      // back on the course outline, scrolled to the new item (#a-<activityId>)
      await page.waitForURL(/\?edit=1#a-/);
      videoUrl = `${courseUrl}/a/${new URL(page.url()).hash.slice('#a-'.length)}`;
      await page.goto(videoUrl);
      await page.locator('#video-file').setInputFiles(clip);
      await expect(page.getByText('Видео загружено и отправлено на обработку')).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText('Готово', { exact: true })).toBeVisible({ timeout: 270_000 });
      await expect(page.getByText('360p · 720p · 1080p')).toBeVisible();
    });

    test('student plays the HLS ladder', async ({ page }) => {
      await login(page, 'student1', DEMO_PASSWORD);
      await page.goto(videoUrl);
      const hls = `${videoUrl.replace(/^\/course\/[^/]+\/a\//, '/api/mod/video/')}/hls`;
      const get = (url: string) =>
        page.evaluate(async (u) => {
          const r = await fetch(u);
          return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
        }, url);
      const master = await get(`${hls}/master.m3u8`);
      expect(master.status).toBe(200);
      expect(master.text).toContain('RESOLUTION=1920x1080');
      expect((await get(`${hls}/poster.jpg`)).type).toBe('image/jpeg');

      const video = page.locator('media-controller video');
      await expect(video).toBeVisible();
      await video.evaluate(async (v: HTMLVideoElement) => {
        v.muted = true;
        await v.play();
      });
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
        .toBeGreaterThan(3);
      const state = await video.evaluate((v: HTMLVideoElement) => ({
        height: v.videoHeight,
        error: v.error?.message ?? null,
        // hls.js feeds the element through Media Source Extensions
        mse: v.src.startsWith('blob:'),
      }));
      expect(state.error).toBeNull();
      expect(state.height).toBeGreaterThanOrEqual(360);
      test.info().annotations.push({
        type: 'playback',
        description: `${state.mse ? 'hls.js' : 'native HLS'}, ${state.height}p`,
      });
    });

    test('admin restores a course backup; the worker reads the upload', async ({ page }, info) => {
      test.setTimeout(180_000);
      await login(page, ADMIN.login, ADMIN.password);
      await page.goto(`${courseUrl}/settings`);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: 'Скачать резервную копию' }).click(),
      ]);
      const file = info.outputPath(download.suggestedFilename());
      await download.saveAs(file);
      await page.goto('/course/import');
      await page.locator('#import-file').setInputFiles(file);
      await page.getByRole('button', { name: 'Импортировать' }).click();
      await expect(page.getByText(/^Готово: разделов \d+, элементов \d+/)).toBeVisible({
        timeout: 120_000,
      });
    });
  });
