import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';
import { firstLink, waitForMail } from './mail';
import { totp } from './totp';

const stamp = Date.now();

test('self-registration sends a verification email that signs the user in', async ({ page }) => {
  // Enable registration through the admin UI.
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/settings/registration');
  await page.getByLabel(/самостоятельную регистрацию|self-registration/i).check();
  await page.getByRole('button', { name: /Сохранить|Save/ }).click();
  await expect(page.getByText(/Сохранено|Saved/).first()).toBeVisible();
  await page.context().clearCookies();

  const email = `reg${stamp}@example.com`;
  await page.goto('/register');
  await page.locator('#firstName').fill('Регина');
  await page.locator('#lastName').fill('Тестова');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('Password123');
  await page.locator('#password2').fill('Password123');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: /Зарегистрироваться|Sign up/ }).click();
  await expect(page.getByText(/Проверьте почту|Check your email/)).toBeVisible();

  const mail = await waitForMail(email, { subject: /Подтвердите|Confirm/ });
  await page.goto(firstLink(mail.Text));
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Регина');
});

test('password reset via email', async ({ page }) => {
  const after = new Date(Date.now() - 1000);
  await page.goto('/forgot-password');
  await page.locator('#email').fill('assistant@hubium.local');
  await page
    .getByRole('button')
    .filter({ hasText: /Отправить|Send/ })
    .click();
  await expect(page.getByRole('status')).toBeVisible();
  const mail = await waitForMail('assistant@hubium.local', { subject: /Сброс|Reset/, after });
  await page.goto(firstLink(mail.Text));
  await page.locator('#password').fill('NewPass12345');
  await page.locator('#password2').fill('NewPass12345');
  await page.locator('form button[type=submit]').click();
  await expect(page.getByRole('status')).toContainText(/Пароль изменён|Password changed/);
  await login(page, 'assistant', 'NewPass12345');
  // restore for other tests
  await page.goto('/settings/security');
  await page.locator('#f-currentPassword').fill('NewPass12345');
  await page.locator('#f-newPassword').fill('Demo12345!');
  await page.locator('#f-newPassword2').fill('Demo12345!');
  await page
    .getByRole('button', { name: /Сохранить|Save/ })
    .first()
    .click();
  await expect(page.getByText(/Пароль изменён|Password changed/).first()).toBeVisible();
});

test('TOTP enrolment and sign-in with a code', async ({ page }) => {
  await login(page, 'student3', 'Demo12345!');
  await page.goto('/settings/security');
  await expectAccessible(page);
  await page.getByRole('button', { name: /Включить 2FA|Enable 2FA/ }).click();
  await page.locator('#tf-password').fill('Demo12345!');
  await page.getByRole('button', { name: /Подтвердить|Verify/ }).click();
  const secret = (await page.locator('code.select-all').innerText()).trim();
  await page.locator('#tf-code').fill(totp(secret));
  await page.getByRole('button', { name: /Подтвердить|Verify/ }).click();
  await expect(page.getByTestId('backup-codes')).toBeVisible();

  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#login').fill('student3');
  await page.locator('#password').fill('Demo12345!');
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(/\/two-factor/);
  await page.locator('#code').fill(totp(secret));
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(/\/dashboard/);

  // cleanup: disable 2FA directly
  await sql(`UPDATE "User" SET "twoFactorEnabled"=false WHERE username='student3'`);
  await sql(
    `DELETE FROM "TwoFactor" WHERE "userId"=(SELECT id FROM "User" WHERE username='student3')`,
  );
});
