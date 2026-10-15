import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// A course certificate laid out on a background, issued by hand, downloaded as a PDF by
// the learner, checked by code without an account, and revoked.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

/** A small pale PNG to lay the certificate on. */
function backgroundPng(): string {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const row = Buffer.from([0, 0xf5, 0xf0, 0xe6, 0xf5, 0xf0, 0xe6]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cert-')), 'paper.png');
  writeFileSync(file, png);
  return file;
}

test('certificates: laid out, issued by hand, downloaded, verified by code and revoked', async ({
  page,
}) => {
  let courseId = '';
  const name = `Слушатель ${stamp}`;
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Сертификаты ${stamp}`, `CERT-${stamp}`);
    await openSelfEnrolment(page, courseId);
    await logout(page);
    await login(page, 'student3', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await logout(page);

    // the template: the default layout on a background
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${courseId}/certificates`);
    await expect(page.getByText('Сертификатов пока нет')).toBeVisible();
    await page.getByRole('link', { name: 'Новый сертификат' }).click();
    await page.locator('#cert-name').fill(name);
    await page.locator('#cert-background').setInputFiles(backgroundPng());
    await expect(page.getByText(/Примерный вид страницы 297×210 мм/)).toBeVisible();
    await expect(page.locator('#cf-0-text')).toHaveValue('Сертификат');
    // a line of its own at the bottom
    await page.getByRole('button', { name: 'Добавить поле' }).click();
    await page.locator('#cf-8-text').fill('Учебный центр');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForURL(/\/certificates\/[0-9a-f-]{36}$/);
    const certId = page.url().split('/').pop()!;
    await expect(page.getByText('Черновик')).toBeVisible();
    await expect(page.locator('#cf-8-text')).toHaveValue('Учебный центр');
    await expectAccessible(page);

    // a sample to look at
    const preview = await page.request.get(`/api/certificates/${certId}/preview`);
    expect(preview.headers()['content-type']).toBe('application/pdf');
    expect((await preview.body()).subarray(0, 5).toString()).toBe('%PDF-');

    // switched on, issued to the learner
    await page.getByRole('button', { name: 'Включить выдачу' }).click();
    await expect(page.getByText('Сертификат выдаётся').first()).toBeVisible();
    await chooseOption(page.locator('#issue-user'), { label: 'Пётр Иванов' });
    await page.getByRole('button', { name: 'Выдать', exact: true }).click();
    await expect(page.getByText('Сертификат выдан').first()).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Пётр Иванов' });
    const code = (await row.getByRole('link').first().textContent())!.trim();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const csv = await (await page.request.get(`/api/certificates/${certId}/issues`)).text();
    expect(csv).toContain(code);
    expect(csv).toContain('Пётр Иванов');
    await logout(page);

    // the learner downloads it
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto('/certificates');
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByText(code)).toBeVisible();
    await expectAccessible(page);
    // the file a browser saves: a PDF named after the certificate and the learner
    const href = (await page.getByRole('link', { name: 'Скачать PDF' }).getAttribute('href'))!;
    const pdf = await page.request.get(href);
    expect(pdf.headers()['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent(`${name} Пётр Иванов.pdf`)}`,
    );
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Скачать PDF' }).click();
    const file = await download;
    expect(
      readFileSync(await file.path())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await page.goto(`/course/${courseId}`);
    await expect(page.getByRole('link', { name: 'Сертификаты', exact: true })).toBeVisible();
    await logout(page);

    // anyone checks the code, typed loosely
    await page.goto('/verify');
    await page.locator('#verify-code').fill('not a code');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText(/Код состоит из 12 букв и цифр/)).toBeVisible();
    await page.locator('#verify-code').fill(code.toLowerCase().replace(/-/g, ' '));
    await page.getByRole('button', { name: 'Проверить' }).click();
    await page.waitForURL(`**/verify/${code}`);
    await expect(page.getByText('Действителен')).toBeVisible();
    await expect(page.getByText('Пётр Иванов')).toBeVisible();
    await expect(page.getByText(name)).toBeVisible();
    await expectAccessible(page);

    // revoked with a reason
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${courseId}/certificates/${certId}`);
    await page.getByRole('button', { name: 'Отозвать: Пётр Иванов' }).click();
    await page.getByLabel('Причина').fill('Выдан по ошибке');
    await page.getByRole('dialog').getByRole('button', { name: 'Отозвать' }).click();
    await expect(page.getByText('Сертификат отозван').first()).toBeVisible();
    await page.goto(`/verify/${code}`);
    await expect(page.getByText('Отозван', { exact: true })).toBeVisible();
    await expect(page.getByText(/Выдан по ошибке/)).toBeVisible();
  } finally {
    if (courseId) await deleteCourse(courseId);
  }
});
