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
    // the menu leads nowhere else until then, though its links do not reload the page
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/my-courses'),
      page.getByRole('link', { name: 'Мои курсы' }).first().click(),
    ]);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/settings\/security\?required=password/);
    await expect(page.getByText('Срок действия вашего пароля истёк')).toBeVisible();
    await expect(
      page.getByText('Не короче 12 символов; нужны: спецсимвол, например ! или %'),
    ).toBeVisible();

    await page.locator('#f-currentPassword').fill(DEMO_PASSWORD);
    await page.locator('#f-newPassword').fill('Longer12345');
    await page.locator('#f-newPassword2').fill('Longer12345');
    await page.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(page.getByText('Добавьте символ, например ! или %').first()).toBeVisible();

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

test('a sign-in from a new device is notified, and "it wasn\'t me" ends all sessions', async ({
  page,
  browser,
}) => {
  // the usual browser is known (signed in before or now)
  await login(page, 'student2', DEMO_PASSWORD);
  await page.context().clearCookies();

  const after = new Date(Date.now() - 1000);
  const other = await browser.newContext({
    locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  });
  const intruder = await other.newPage();
  await login(intruder, 'student2', DEMO_PASSWORD);

  const mail = await waitForMail('student2@hubium.local', {
    subject: /Вход с нового устройства/,
    after,
  });
  expect(mail.Text).toContain('Firefox · Linux');

  // the owner sees it in the app too and follows it
  await login(page, 'student2', DEMO_PASSWORD);
  await page.goto('/notifications');
  await page
    .getByRole('link', { name: /Вход с нового устройства/ })
    .first()
    .click();
  await page.waitForURL(/\/not-me\?token=/);
  await expect(page.getByText('Firefox · Linux')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: /Это был не я/ }).click();
  await expect(page.getByText(/Все сеансы завершены/)).toBeVisible();
  await waitForMail('student2@hubium.local', { subject: /Сброс/, after });

  // every session is gone (browsers drop theirs once the 60-second cookie cache expires)
  const [{ n }] = (await sql<{ n: string }>(
    `SELECT count(*) AS n FROM "Session" s JOIN "User" u ON u.id = s."userId"
     WHERE u.username = 'student2'`,
  )) as [{ n: string }];
  expect(Number(n)).toBe(0);
  await other.close();
});

test('recovery phrase instead of a code, and new backup codes', async ({ page }) => {
  await login(page, 'teacher', DEMO_PASSWORD);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: /Включить 2FA/ }).click();
  await page.locator('#tf-password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  const secret = (await page.locator('code.select-all').innerText()).trim();
  await page.locator('#tf-code').fill(totp(secret));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('backup-codes')).toBeVisible();
  const first = await page.getByTestId('backup-codes').innerText();
  await page.getByRole('button', { name: 'OK' }).click();

  try {
    // backup codes can be issued again
    await page.getByRole('button', { name: 'Новые резервные коды' }).click();
    await page.locator('#tf-password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByTestId('backup-codes')).not.toHaveText(first);
    await page.getByRole('button', { name: 'OK' }).click();

    await expect(page.getByRole('heading', { name: 'Фразы восстановления' })).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel('Название').fill('Сейф дома');
    await page.getByLabel('Фраза', { exact: true }).fill('Зелёный чайник поёт по утрам');
    await page.getByLabel('Повторите фразу').fill('Зелёный чайник поёт по утрам');
    await page.getByLabel('Подтвердите паролем').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Добавить фразу' }).click();
    await expect(page.getByText('Сейф дома')).toBeVisible();

    const after = new Date(Date.now() - 1000);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.locator('#login').fill('teacher');
    await page.locator('#password').fill(DEMO_PASSWORD);
    await page.locator('form button[type=submit]').click();
    await page.waitForURL(/\/two-factor/);
    await page.getByRole('button', { name: 'Ввести фразу восстановления' }).click();
    await page.getByLabel('Фраза восстановления').fill('не та фраза совсем никак');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByText('Фраза не подошла')).toBeVisible();
    await page.getByLabel('Фраза восстановления').fill('зелёный  ЧАЙНИК поёт по утрам');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await page.waitForURL(/\/dashboard/);
    await waitForMail('teacher@hubium.local', { subject: /фраза восстановления/, after });

    // used once: it is gone from the list
    await page.goto('/settings/security');
    await expect(page.getByText('Фраз пока нет.')).toBeVisible();
  } finally {
    await sql(`UPDATE "User" SET "twoFactorEnabled"=false WHERE username='teacher'`);
    await sql(
      `DELETE FROM "TwoFactor" WHERE "userId"=(SELECT id FROM "User" WHERE username='teacher')`,
    );
    await sql(
      `DELETE FROM "RecoveryPassphrase" WHERE "userId"=(SELECT id FROM "User" WHERE username='teacher')`,
    );
  }
});
