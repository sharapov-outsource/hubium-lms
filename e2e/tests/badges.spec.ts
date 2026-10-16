import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { newCourse, openSelfEnrolment, selfEnrol } from './courses';
import { deleteCourse, setSetting } from './db';
import { ADMIN, chooseOption, DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// A course badge awarded by hand: set up, switched on, given to a learner, checked by
// anyone at its public addresses (Open Badges 2.0), downloaded baked, and revoked.

const stamp = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

test('badges: a course badge awarded by hand, verified in public and revoked', async ({ page }) => {
  let courseId = '';
  const name = `Активист ${stamp}`;
  try {
    await login(page, ADMIN.login, ADMIN.password);
    courseId = await newCourse(page, `Значки ${stamp}`, `BADGE-${stamp}`);
    await openSelfEnrolment(page, courseId);
    await logout(page);
    await login(page, 'student3', DEMO_PASSWORD);
    await selfEnrol(page, courseId);
    await logout(page);

    // the badge: a picture, and given by hand by a teacher
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${courseId}/badges`);
    await expect(page.getByText('Значков пока нет')).toBeVisible();
    await page.getByRole('link', { name: 'Новый значок' }).click();
    await page.locator('#f-name').fill(name);
    await page.locator('#f-description').fill('За помощь группе');
    const svg = path.join(mkdtempSync(path.join(tmpdir(), 'badge-')), 'star.svg');
    writeFileSync(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="gold"/></svg>',
    );
    await page.locator('#f-image').setInputFiles(svg);
    await page.getByLabel('Выдача вручную ролями').check();
    await page
      .getByRole('group', { name: 'Выдача вручную ролями' })
      .getByLabel('Преподаватель')
      .check();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForURL(/\/badges\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Черновик')).toBeVisible();
    await expectAccessible(page);

    // switched on, then given to the learner
    await page.getByRole('button', { name: 'Включить выдачу' }).click();
    await expect(page.getByText('Значок выдаётся').first()).toBeVisible();
    await chooseOption(page.locator('#mark-user'), { label: 'Пётр Иванов' });
    await page.getByRole('button', { name: 'Выдать', exact: true }).click();
    await expect(page.getByText('Отмечено').first()).toBeVisible();
    const awardLink = page.getByRole('link', { name: 'Пётр Иванов' });
    await expect(awardLink).toBeVisible();
    const awardId = (await awardLink.getAttribute('href'))!.split('/').pop()!;
    // the editor says the criteria are fixed now
    await expect(page.getByText('Значок уже выдавался')).toBeVisible();

    // the Open Badges documents
    const assertion = await (await page.request.get(`/api/badges/assertions/${awardId}`)).json();
    expect(assertion).toMatchObject({
      type: 'Assertion',
      recipient: { type: 'email', hashed: true },
      verification: { type: 'hosted' },
    });
    const cls = await (await page.request.get(assertion.badge)).json();
    expect(cls).toMatchObject({ type: 'BadgeClass', name, description: 'За помощь группе' });
    expect(cls.criteria.narrative).toContain('Преподаватель');
    expect((await page.request.get(cls.issuer)).ok()).toBe(true);

    // the issuer the site's badges name
    await page.goto('/admin/badges');
    await page.locator('#issuer-name').fill(`Академия ${stamp}`);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();
    await expectAccessible(page);
    expect((await (await page.request.get('/api/badges/issuer')).json()).name).toBe(
      `Академия ${stamp}`,
    );
    await logout(page);

    // the learner has it, and downloads it with the assertion baked in
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto('/badges');
    await expect(page.getByRole('link', { name })).toBeVisible();
    await expectAccessible(page);
    const download = page.waitForEvent('download');
    // the demo gave the learner a badge of their own already: this award's link
    await page
      .getByRole('link', { name: 'Скачать значок' })
      .and(page.locator(`[href*="/assertions/${awardId}/"]`))
      .click();
    const baked = readFileSync(await (await download).path(), 'utf8');
    expect(baked).toContain(`<openbadges:assertion verify="`);
    expect(baked).toContain(awardId);
    await page.goto(`/course/${courseId}/badges`);
    await expect(page.getByText(/Получен/)).toBeVisible();
    await logout(page);

    // anyone checks it, without signing in
    await page.goto(`/badge/${awardId}`);
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Действителен')).toBeVisible();
    await expect(page.getByText('Пётр Иванов')).toBeVisible();
    await expect(page.getByText(`Академия ${stamp}`)).toBeVisible();
    await expectAccessible(page);

    // revoked with a reason
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto(`/course/${courseId}/badges`);
    await page.getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Отозвать: Пётр Иванов' }).click();
    await page.getByLabel('Причина').fill('Выдан по ошибке');
    await page.getByRole('dialog').getByRole('button', { name: 'Отозвать' }).click();
    await expect(page.getByText('Значок отозван').first()).toBeVisible();
    const gone = await page.request.get(`/api/badges/assertions/${awardId}`);
    expect(gone.status()).toBe(410);
    expect(await gone.json()).toMatchObject({ revoked: true, revocationReason: 'Выдан по ошибке' });
    await page.goto(`/badge/${awardId}`);
    await expect(page.getByText('Отозван', { exact: true })).toBeVisible();
    await expect(page.getByText(/Выдан по ошибке/)).toBeVisible();
  } finally {
    await setSetting('badges.issuerName', '');
    if (courseId) await deleteCourse(courseId);
  }
});
