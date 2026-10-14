import { connect } from 'node:net';
import { expect, test } from '@playwright/test';
import { sql } from './db';
import { ADMIN, expectAccessible, login } from './helpers';

// Sign-in through the OpenLDAP of e2e/ldap (CI starts it; locally:
// `docker compose -f docker/compose.dev.yml --profile ldap up -d`).

const LDAP_URL = process.env.LDAP_URL ?? 'ldap://127.0.0.1:1389';

test.beforeAll(async () => {
  const u = new URL(LDAP_URL);
  const up = await new Promise<boolean>((resolve) => {
    const s = connect(Number(u.port || 389), u.hostname);
    s.once('connect', () => resolve(!!s.end()));
    s.once('error', () => resolve(false));
  });
  if (!up && process.env.CI) throw new Error(`OpenLDAP is not running at ${LDAP_URL}`);
  test.skip(!up, `OpenLDAP is not running at ${LDAP_URL}`);
});

test('LDAP: settings, connection check and sign-in', async ({ page }) => {
  await sql(
    `INSERT INTO "UserProfileField" (id, "shortName", name, type, "updatedAt")
     VALUES (gen_random_uuid(), 'faculty', '{"ru":"Факультет"}', 'text', now())
     ON CONFLICT ("shortName") DO NOTHING`,
  );
  try {
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/ldap');
    await expectAccessible(page);
    await page.getByLabel('Включить вход через LDAP').check();
    await page.getByLabel('Адрес сервера').fill(LDAP_URL);
    await page.getByLabel('DN служебной учётной записи').fill('cn=admin,dc=hubium,dc=test');
    await page.getByLabel('Пароль служебной учётной записи').fill('ldap-admin');
    await page.getByLabel('Базовый DN').fill('ou=people,dc=hubium,dc=test');
    await page.getByLabel('Фильтр поиска').fill('(&(objectClass=inetOrgPerson)(uid={login}))');
    await page.getByLabel('Факультет').fill('departmentNumber');
    await page.getByLabel('Создавать учётную запись при первом входе').check();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    await page.reload();
    await page.getByLabel('Логин для проверки (необязательно)').fill('lena');
    await page.getByRole('button', { name: 'Проверить подключение' }).click();
    await expect(page.getByText(/Найден: Лена Лебедева, lena@example\.org/)).toBeVisible();
    await page.context().clearCookies();

    // a directory person without an account gets one; local accounts still work
    await login(page, 'lena', 'Ldap-pass-123');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Лена');
    const [lena] = await sql<{ username: string; customFields: { faculty?: string } }>(
      `SELECT username, "customFields" FROM "User" WHERE email = 'lena@example.org'`,
    );
    expect(lena).toEqual({ username: 'lena', customFields: { faculty: 'Матфак' } });
    await page.context().clearCookies();

    await page.goto('/login');
    await page.locator('#login').fill('lena');
    await page.locator('#password').fill('wrong-password');
    await page.locator('form button[type=submit]').click();
    await expect(page.getByRole('alert').first()).toContainText('Неверный');

    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/ldap');
    await page.getByRole('button', { name: 'Синхронизировать сейчас' }).click();
    await expect(page.getByText('Синхронизация поставлена в очередь')).toBeVisible();
    await expect
      .poll(
        async () =>
          (await sql<{ at: Date | null }>(`SELECT "lastSyncAt" AS at FROM "LdapServer"`))[0]?.at,
        { timeout: 30_000 },
      )
      .not.toBeNull();
  } finally {
    await sql(`DELETE FROM "LdapServer"`);
    await sql(`DELETE FROM "Account" WHERE "providerId" = 'ldap'`);
    await sql(`DELETE FROM "User" WHERE email = 'lena@example.org'`);
    await sql(`DELETE FROM "UserProfileField" WHERE "shortName" = 'faculty'`);
  }
});
