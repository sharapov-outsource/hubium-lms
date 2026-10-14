import { expect, test } from '@playwright/test';
import { setSetting, sql } from './db';
import { ADMIN, DEMO_PASSWORD, expectAccessible, login } from './helpers';
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

test('password policy: rules in the forms, refusals and expiry', async ({ page }) => {
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/settings/security');
  await expectAccessible(page);
  await page.getByLabel('Минимальная длина').fill('12');
  await page.getByLabel('Требовать спецсимвол').check();
  await page.getByLabel('Срок действия пароля, дней').fill('30');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено').first()).toBeVisible();
  await page.context().clearCookies();

  try {
    // a password set long ago has expired: the user must pick a new one
    await sql(
      `UPDATE "User" SET "passwordChangedAt" = now() - interval '60 days' WHERE username = 'student2'`,
    );
    await page.goto('/login');
    await page.locator('#login').fill('student2');
    await page.locator('#password').fill(DEMO_PASSWORD);
    await page.locator('form button[type=submit]').click();
    await page.waitForURL(/\/settings\/security\?required=password/);
    await expect(page.getByText('Срок действия вашего пароля истёк')).toBeVisible();
    await expect(
      page.getByText('Не короче 12 символов; нужны: спецсимвол, например ! или %'),
    ).toBeVisible();

    await page.locator('#f-currentPassword').fill(DEMO_PASSWORD);
    await page.locator('#f-newPassword').fill('Longer12345');
    await page.locator('#f-newPassword2').fill('Longer12345');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText('Include a symbol such as ! or %').first()).toBeVisible();

    await page.locator('#f-newPassword').fill('Longer-12345');
    await page.locator('#f-newPassword2').fill('Longer-12345');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText(/Пароль изменён/).first()).toBeVisible();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  } finally {
    for (const [k, v] of [
      ['password.minLength', 8],
      ['password.requireSymbol', false],
      ['password.maxAgeDays', 0],
    ] as const)
      await setSetting(k, v);
    // back to the demo password for other tests (the policy is off again)
    await page.context().clearCookies();
    await login(page, 'student2', 'Longer-12345').catch(() => undefined);
    if (page.url().includes('/dashboard')) {
      await page.goto('/settings/security');
      await page.locator('#f-currentPassword').fill('Longer-12345');
      await page.locator('#f-newPassword').fill(DEMO_PASSWORD);
      await page.locator('#f-newPassword2').fill(DEMO_PASSWORD);
      await page.getByRole('button', { name: 'Сохранить' }).first().click();
      await expect(page.getByText(/Пароль изменён/).first()).toBeVisible();
    }
  }
});

test('lockout after failed sign-ins: email link and administrator unlock', async ({ page }) => {
  const tryLogin = async (password: string) => {
    await page.goto('/login');
    await page.locator('#login').fill('student3');
    await page.locator('#password').fill(password);
    await page.locator('form button[type=submit]').click();
  };
  await login(page, ADMIN.login, ADMIN.password);
  await page.goto('/admin/settings/security');
  await page.getByLabel('Неудачных попыток до блокировки').fill('2');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено').first()).toBeVisible();
  await page.context().clearCookies();

  try {
    const after = new Date(Date.now() - 1000);
    for (let i = 0; i < 2; i++) {
      await tryLogin('wrong-password');
      await expect(page.getByRole('alert').first()).toContainText('Неверный');
    }
    await tryLogin(DEMO_PASSWORD);
    await expect(page.getByRole('alert').first()).toContainText('временно заблокирован');

    // the owner unlocks from the email
    const mail = await waitForMail('student3@hubium.local', { subject: /заблокирован/, after });
    await page.goto(firstLink(mail.Text));
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Разблокировать' }).click();
    await expect(page.getByText('Учётная запись разблокирована, можно войти.')).toBeVisible();
    await login(page, 'student3', DEMO_PASSWORD);
    await page.context().clearCookies();

    // locked again, an administrator unlocks from the user's page
    for (let i = 0; i < 2; i++) await tryLogin('wrong-password');
    await login(page, ADMIN.login, ADMIN.password);
    const [u] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = 'student3'`);
    await page.goto(`/admin/users/${u!.id}`);
    await expect(page.getByText(/Вход заблокирован после неудачных попыток до/)).toBeVisible();
    await page.getByRole('button', { name: 'Разблокировать' }).click();
    await expect(page.getByText('Учётная запись разблокирована').first()).toBeVisible();
    await page.context().clearCookies();
    await login(page, 'student3', DEMO_PASSWORD);
  } finally {
    await setSetting('lockout.threshold', 0);
    await sql(
      `UPDATE "User" SET "lockedUntil" = NULL, "failedLoginCount" = 0 WHERE username = 'student3'`,
    );
  }
});
