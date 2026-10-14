import { expect, type Page, test } from '@playwright/test';
import { setSetting, sql } from './db';
import { ADMIN, chooseOption, expectAccessible, login } from './helpers';

// Single sign-on against the Keycloak of e2e/keycloak/hubium-realm.json (CI starts it;
// locally: `docker compose -f docker/compose.dev.yml --profile sso up -d`).

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:8080';
const REALM = `${KEYCLOAK}/realms/hubium`;

test.beforeAll(async () => {
  const up = await fetch(`${REALM}/.well-known/openid-configuration`).then(
    (r) => r.ok,
    () => false,
  );
  // CI always starts it; elsewhere the scenario is skipped without it
  if (!up && process.env.CI) throw new Error(`Keycloak is not running at ${KEYCLOAK}`);
  test.skip(!up, `Keycloak is not running at ${KEYCLOAK}`);
});

async function keycloakSignIn(page: Page, username: string) {
  await page.waitForURL(new RegExp(`^${KEYCLOAK.replace(/[.]/g, '\\.')}`));
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('Kc-pass-123');
  await page.locator('#kc-login').click();
}

async function addProvider(page: Page, fill: () => Promise<void>) {
  await page.goto('/admin/sso/new');
  await fill();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Провайдер сохранён')).toBeVisible();
}

test('OIDC and SAML sign-in through Keycloak', async ({ page }) => {
  test.slow();
  await sql(
    `INSERT INTO "UserProfileField" (id, "shortName", name, type, "updatedAt")
     VALUES (gen_random_uuid(), 'department', '{"ru":"Факультет"}', 'text', now())
     ON CONFLICT ("shortName") DO NOTHING`,
  );
  // Kira already has an account; Nikita has none
  await sql(
    `INSERT INTO "User" (id, email, name, "firstName", "lastName", "emailVerified", "updatedAt")
     VALUES (gen_random_uuid(), 'kira@example.org', 'Кира К', 'Кира', 'К', true, now())
     ON CONFLICT (email) DO NOTHING`,
  );

  try {
    await login(page, ADMIN.login, ADMIN.password);
    await addProvider(page, async () => {
      await page.getByLabel('Название').fill('Keycloak OIDC');
      await page.getByLabel('Идентификатор').fill('kc-oidc');
      await expect(page.getByText('/api/auth/sso/callback/kc-oidc')).toBeVisible();
      await page.getByLabel('Издатель (issuer)').fill(REALM);
      await page.getByLabel('Client ID').fill('hubium-oidc');
      await page.getByLabel('Client secret').fill('hubium-oidc-secret');
      await page.getByLabel('Факультет').fill('department');
    });
    await expectAccessible(page);
    await page.goto('/admin/sso');
    await expect(page.getByRole('link', { name: 'Keycloak OIDC' })).toBeVisible();
    await page.context().clearCookies();

    // an existing account, found by email; names and the profile field come along
    await page.goto('/login');
    await page.getByRole('button', { name: 'Keycloak OIDC' }).click();
    await keycloakSignIn(page, 'kira');
    await page.waitForURL(/\/dashboard/);
    const [kira] = await sql<{ lastName: string; customFields: { department?: string } }>(
      `SELECT "lastName", "customFields" FROM "User" WHERE email = 'kira@example.org'`,
    );
    expect(kira!.lastName).toBe('Ключникова');
    expect(kira!.customFields.department).toBe('Физфак');
    await page.context().clearCookies();

    // no account and the provider does not create them
    await page.goto('/login');
    await page.getByRole('button', { name: 'Keycloak OIDC' }).click();
    await keycloakSignIn(page, 'nikita');
    await page.waitForURL(/\/login\?.*error=SSO_NO_ACCOUNT/);
    await expect(page.getByText(/нет учётной записи на сайте/)).toBeVisible();
    await page.context().clearCookies();

    // SAML with account creation turned on
    await login(page, ADMIN.login, ADMIN.password);
    await addProvider(page, async () => {
      await chooseOption(page.locator('#f-protocol'), 'saml');
      await page.getByLabel('Название').fill('Keycloak SAML');
      await page.getByLabel('Идентификатор').fill('kc-saml');
      await page
        .getByLabel('Адрес метаданных провайдера')
        .fill(`${REALM}/protocol/saml/descriptor`);
      await page.getByLabel('Создавать учётную запись, если её нет').check();
      await page.getByLabel('Факультет').fill('department');
    });
    const meta = await page.request.get('/api/auth/sso/saml2/sp/metadata?providerId=kc-saml');
    expect(await meta.text()).toContain('/api/auth/sso/saml2/sp/acs/kc-saml');
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByRole('button', { name: 'Keycloak SAML' }).click();
    await keycloakSignIn(page, 'nikita');
    await page.waitForURL(/\/dashboard/);
    const [nikita] = await sql<{ name: string; customFields: { department?: string } }>(
      `SELECT name, "customFields" FROM "User" WHERE email = 'nikita@example.org'`,
    );
    expect(nikita!.name).toBe('Никита Новиков');
    expect(nikita!.customFields.department).toBe('Химфак');
  } finally {
    await sql(`DELETE FROM "SsoProvider" WHERE "providerId" IN ('kc-oidc', 'kc-saml')`);
    await sql(`DELETE FROM "Account" WHERE "providerId" IN ('kc-oidc', 'kc-saml')`);
    await sql(`DELETE FROM "User" WHERE email IN ('kira@example.org', 'nikita@example.org')`);
    await sql(`DELETE FROM "UserProfileField" WHERE "shortName" = 'department'`);
  }
});

test('Keycloak from the environment and a custom OAuth 2 provider', async ({ page }) => {
  test.slow();
  await sql(
    `INSERT INTO "User" (id, email, name, "firstName", "lastName", "emailVerified", "updatedAt")
     VALUES (gen_random_uuid(), 'kira@example.org', 'Кира К', 'Кира', 'К', true, now())
     ON CONFLICT (email) DO NOTHING`,
  );
  try {
    // the built-in provider: keys in AUTH_KEYCLOAK_*, switched on in the settings
    await login(page, ADMIN.login, ADMIN.password);
    await page.goto('/admin/settings/authentication');
    await expect(page.getByText('/api/auth/callback/keycloak')).toBeVisible();
    await page.getByLabel('Keycloak', { exact: true }).check();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено').first()).toBeVisible();

    // a custom OAuth 2 provider that creates accounts
    await page.goto('/admin/sso/new');
    await chooseOption(page.locator('#f-protocol'), 'oauth2');
    await page.getByLabel('Название').fill('Keycloak OAuth');
    await page.getByLabel('Идентификатор').fill('kc-oauth');
    await expect(page.getByText('/api/auth/callback/kc-oauth')).toBeVisible();
    const oidc = `${REALM}/protocol/openid-connect`;
    await page.getByLabel('Адрес авторизации').fill(`${oidc}/auth`);
    await page.getByLabel('Адрес получения токена').fill(`${oidc}/token`);
    await page.getByLabel('Адрес информации о пользователе').fill(`${oidc}/userinfo`);
    await page.getByLabel('Client ID').fill('hubium-oauth');
    await page.getByLabel('Client secret').fill('hubium-oauth-secret');
    await page.getByLabel('Области доступа (scopes)').fill('openid email profile');
    await page.getByLabel('Создавать учётную запись, если её нет').check();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Провайдер сохранён')).toBeVisible();
    // every process rebuilds its sign-in with the new provider
    await expect
      .poll(async () => {
        const r = await page.request.post('/api/auth/sign-in/social', {
          headers: { origin: new URL(page.url()).origin },
          data: { provider: 'kc-oauth', callbackURL: '/dashboard' },
        });
        return r.status();
      })
      .toBe(200);
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByRole('button', { name: 'Keycloak', exact: true }).click();
    await keycloakSignIn(page, 'kira');
    await page.waitForURL(/\/dashboard/);
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByRole('button', { name: 'Keycloak OAuth' }).click();
    await keycloakSignIn(page, 'nikita');
    await page.waitForURL(/\/dashboard/);
    const [nikita] = await sql<{ firstName: string; lastName: string }>(
      `SELECT "firstName", "lastName" FROM "User" WHERE email = 'nikita@example.org'`,
    );
    expect(nikita).toEqual({ firstName: 'Никита', lastName: 'Новиков' });
  } finally {
    await setSetting('auth.oauth.keycloak', false);
    await sql(`DELETE FROM "SsoProvider" WHERE "providerId" = 'kc-oauth'`);
    await sql(`DELETE FROM "Account" WHERE "providerId" IN ('keycloak', 'kc-oauth')`);
    await sql(`DELETE FROM "User" WHERE email IN ('kira@example.org', 'nikita@example.org')`);
  }
});
