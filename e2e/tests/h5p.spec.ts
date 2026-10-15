import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { h5pFixture } from '@hubium/mod-h5p/fixtures';
import { expect, test } from '@playwright/test';
import { addActivity, newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, expectNoSideScroll, login } from './helpers';

// An .h5p package runs in the real h5p-standalone player on the content origin; the
// content's xAPI result becomes the learner's attempt and grade.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('H5P: a package uploaded, previewed by the teacher, answered by a learner', async ({
  page,
}) => {
  let courseId = '';
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `H5P ${stamp}`, `H5P-${stamp}`);
    await openSelfEnrolment(page, courseId);
    const id = await addActivity(page, courseId, /^H5P/, 'Устный счёт');
    const url = `/course/${courseId}/a/${id}`;

    await page.goto(url);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'h5p-')), 'check.h5p');
    writeFileSync(file, h5pFixture());
    await page.locator('#h5p-file').setInputFiles(file);
    await expect(page.getByText('Проверка · H5P.HubiumCheck')).toBeVisible({ timeout: 60_000 });
    // the teacher previews: nothing is recorded
    await expect(page.getByText('Просмотр: ваши результаты не сохраняются.')).toBeVisible();
    const preview = page.frameLocator('iframe[title="Проверка"]').frameLocator('iframe.h5p-iframe');
    await expect(preview.getByText('Дважды два — четыре?')).toBeVisible();
    await expectAccessible(page);

    await page.context().clearCookies();
    await login(page, 'student1', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await page.goto(url);
    const content = page.frameLocator('iframe[title="Проверка"]').frameLocator('iframe.h5p-iframe');
    await content.getByRole('button', { name: 'Да' }).click();
    await expect(content.getByText('Верно!')).toBeVisible();
    // the result comes back as an attempt and the grade
    const mine = page.getByRole('region', { name: 'Мои попытки' });
    await expect(mine.getByRole('row', { name: /1 \/ 1 \(100%\)/ })).toBeVisible();
    await expect(mine.getByText('Сдано')).toBeVisible();
    await expect(page.getByText('Оценка: 100 из 100')).toBeVisible();
    await expectAccessible(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoSideScroll(page, url);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.context().clearCookies();
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(url);
    const report = page.getByRole('region', { name: 'Отчёт по попыткам' });
    await expect(report.getByRole('row', { name: /Иван Петров.*1.*100/ })).toBeVisible();
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
