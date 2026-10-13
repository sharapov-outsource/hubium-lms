import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scormFixture } from '@hubium/mod-scorm/fixtures';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// A SCORM 1.2 package runs in the real scorm-again runtime on the content origin
// (CONTENT_HOST): status, suspend data and score are saved, the second launch resumes,
// and the SCO cannot see the LMS session cookie.

test.describe
  .serial('SCORM', () => {
    let url = '';

    test('teacher uploads a package', async ({ page }) => {
      const [c] = await sql<{ id: string }>(
        `SELECT id FROM "Course" WHERE "shortName" = 'DEMO-PY'`,
      );
      const [section] = await sql<{ id: string }>(
        `SELECT id FROM "CourseSection" WHERE "courseId" = $1 ORDER BY rank LIMIT 1`,
        [c!.id],
      );
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${c!.id}/a/new?module=scorm&section=${section!.id}`);
      await page.locator('#f-name').fill(`SCORM ${Date.now().toString(36)}`);
      await chooseOption(page.locator('#f-completionMode'), 'AUTO');
      await page.locator('#scc-passed').check();
      await page.getByRole('button', { name: /^Создать$/ }).click();
      await page.waitForURL(/\?edit=1/);
      const [act] = await sql<{ id: string }>(
        `SELECT id FROM "Activity" WHERE "courseId" = $1 AND "moduleKey" = 'scorm' ORDER BY "createdAt" DESC LIMIT 1`,
        [c!.id],
      );
      url = `/course/${c!.id}/a/${act!.id}`;
      await page.goto(url);
      const file = path.join(mkdtempSync(path.join(tmpdir(), 'scorm-')), 'course.zip');
      writeFileSync(file, scormFixture('1.2'));
      await page.locator('#scorm-file').setInputFiles(file);
      await expect(page.getByText('Тестовый курс SCORM · SCORM 1.2')).toBeVisible({
        timeout: 60_000,
      });
      await expectAccessible(page);
      await logout(page);
    });

    test('student runs, suspends and resumes the SCO', async ({ page }) => {
      await login(page, 'student2', DEMO_PASSWORD);
      await page.goto(url);
      const sco = page.frameLocator('iframe[title="Урок 1"]').frameLocator('#sco');
      await expect(
        sco.getByText('entry=ab-initio location= learner=Сидорова, Мария'),
      ).toBeVisible();
      // the content origin has no access to LMS cookies
      await expect(sco.getByText('cookie=[]')).toBeVisible();
      await page.reload();
      await expect(page.getByText('В процессе')).toBeVisible();
      const again = page.frameLocator('iframe[title="Урок 1"]').frameLocator('#sco');
      await expect(again.getByText('entry=resume location=page-2')).toBeVisible();
      await page.reload();
      await expect(page.getByText('Завершено')).toBeVisible();
      await expect(page.getByText('Балл: 85%')).toBeVisible();
      await expect(page.getByText('Выполнено').first()).toBeVisible();
      await expectAccessible(page);
    });
  });
