import { getAllSettings, roleName, siteLocale } from '@hubium/core';
import { BUILT_IN_OAUTH, configuredOAuthProviders } from '@hubium/core/auth/auth';
import { languageInfo } from '@hubium/i18n/packs';
import { DateTimeInput } from '@hubium/module-sdk/form';
import { Badge, Card, CardContent, Checkbox, Combobox, Select, Textarea } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveSettingsAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';
import { timezoneOptions } from '@/server/timezones';
import { BrandingForm } from './branding-form';
import { SectionNav } from './section-nav';
import { TestEmailButton } from './test-email';

const OAUTH_LABELS = {
  google: 'Google',
  yandex: 'Яндекс ID',
  vk: 'VK ID',
  keycloak: 'Keycloak',
} as const;

const SECTIONS = [
  'general',
  'branding',
  'registration',
  'authentication',
  'security',
  'email',
  'maintenance',
] as const;
type Section = (typeof SECTIONS)[number];

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.includes(section as Section)) return {};
  const t = await getTranslations('admin');
  return { title: `${t('siteSettings')}: ${t(section)}` };
}

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  await requireCapability('site:config');
  const { section } = await params;
  if (!SECTIONS.includes(section as Section)) notFound();
  const [s, t, tc, locale] = await Promise.all([
    getAllSettings(db),
    getTranslations('admin'),
    getTranslations('common'),
    getLocale(),
  ]);
  const roles = await db.role.findMany({
    where: { assignableLevels: { has: 'COURSE' } },
    orderBy: { sortOrder: 'asc' },
  });
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const configured = configuredOAuthProviders();

  let body: React.ReactNode;
  switch (section as Section) {
    case 'general':
      body = (
        <Form section="general" save={tc('save')} saved={tc('saved')}>
          <FormField
            name="siteName"
            label={t('settings.siteName')}
            defaultValue={s['site.name']}
            required
          />
          <p className="text-sm text-muted-foreground">
            {t('settings.defaultLocale')}: {languageInfo(siteLocale(s)).name} ·{' '}
            <Link href="/admin/languages" className="text-accent hover:underline">
              {t('languages')}
            </Link>
          </p>
          <FormField name="defaultTimezone" label={t('settings.defaultTimezone')}>
            <Combobox
              id="f-defaultTimezone"
              name="defaultTimezone"
              defaultValue={s['site.defaultTimezone']}
              options={timezoneOptions(locale)}
              searchPlaceholder={tc('searchPlaceholder')}
              emptyText={tc('nothingFound')}
            />
          </FormField>
          <FormField
            name="creatorRole"
            label={t('settings.creatorRole')}
            hint={
              roles.some((r) => r.shortName === s['course.creatorRole'])
                ? undefined
                : t('settings.creatorRoleMissing')
            }
          >
            <Select id="f-creatorRole" name="creatorRole" defaultValue={s['course.creatorRole']}>
              {/* a role deleted before this was kept from happening: shown, not swapped for
                  the first one in the list on the next save */}
              {roles.some((r) => r.shortName === s['course.creatorRole']) ? null : (
                <option value={s['course.creatorRole']} disabled>
                  {s['course.creatorRole']}
                </option>
              )}
              {roles.map((r) => (
                <option key={r.id} value={r.shortName}>
                  {roleName(r, locale)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            name="recyclebinDays"
            type="number"
            min={0}
            max={3650}
            label={t('settings.recyclebinDays')}
            hint={t('settings.recyclebinDaysHint')}
            defaultValue={s['recyclebin.days']}
          />
          <Toggle
            name="mentorsEnabled"
            label={t('settings.mentorsEnabled')}
            checked={s['mentors.enabled']}
          />
          <p className="-mt-2 text-xs text-muted-foreground">{t('settings.mentorsHint')}</p>
        </Form>
      );
      break;
    case 'branding':
      body = <BrandingForm accent={s['branding.accent']} hasLogo={!!s['branding.logoFileId']} />;
      break;
    case 'registration':
      body = (
        <Form section="registration" save={tc('save')} saved={tc('saved')}>
          <Toggle
            name="enabled"
            label={t('settings.registrationEnabled')}
            checked={s['registration.enabled']}
          />
          <Toggle
            name="requireEmailVerification"
            label={t('settings.requireEmailVerification')}
            checked={s['registration.requireEmailVerification']}
          />
          <FormField name="consentText" label={t('settings.consentText')}>
            <Textarea
              id="f-consentText"
              name="consentText"
              defaultValue={s['registration.consentText']}
            />
          </FormField>
        </Form>
      );
      break;
    case 'authentication':
      body = (
        <Form section="authentication" save={tc('save')} saved={tc('saved')}>
          <p className="text-sm text-muted-foreground">{t('settings.oauthHint')}</p>
          {BUILT_IN_OAUTH.map((p) => (
            <div key={p} className="grid gap-1 rounded-lg border border-border p-3">
              <Toggle name={p} label={OAUTH_LABELS[p]} checked={s[`auth.oauth.${p}`]} />
              <p className="text-xs text-muted-foreground">
                {t('settings.callbackUrl')}:{' '}
                <code className="select-all break-all">
                  {appUrl}/api/auth/callback/{p}
                </code>
              </p>
              {!configured.includes(p) ? (
                <Badge variant="warning" className="w-fit">
                  {t('settings.notConfigured')}
                </Badge>
              ) : null}
            </div>
          ))}
          <Toggle
            name="require2fa"
            label={t('settings.require2fa')}
            checked={s['auth.require2faForAdmins']}
          />
        </Form>
      );
      break;
    case 'security':
      body = (
        <Form section="security" save={tc('save')} saved={tc('saved')}>
          <h2 className="font-semibold">{t('settings.passwordPolicy')}</h2>
          <FormField
            name="minLength"
            type="number"
            min={8}
            max={128}
            label={t('settings.passwordMinLength')}
            defaultValue={s['password.minLength']}
          />
          <Toggle
            name="requireDigit"
            label={t('settings.passwordRequireDigit')}
            checked={s['password.requireDigit']}
          />
          <Toggle
            name="requireLower"
            label={t('settings.passwordRequireLower')}
            checked={s['password.requireLower']}
          />
          <Toggle
            name="requireUpper"
            label={t('settings.passwordRequireUpper')}
            checked={s['password.requireUpper']}
          />
          <Toggle
            name="requireSymbol"
            label={t('settings.passwordRequireSymbol')}
            checked={s['password.requireSymbol']}
          />
          <FormField
            name="history"
            type="number"
            min={0}
            max={20}
            label={t('settings.passwordHistory')}
            hint={t('settings.passwordHistoryHint')}
            defaultValue={s['password.history']}
          />
          <FormField
            name="maxAgeDays"
            type="number"
            min={0}
            max={3650}
            label={t('settings.passwordMaxAge')}
            hint={t('settings.passwordMaxAgeHint')}
            defaultValue={s['password.maxAgeDays']}
          />
          <h2 className="mt-2 font-semibold">{t('settings.signInNotices')}</h2>
          <Toggle
            name="newSignInNotice"
            label={t('settings.newSignInNotice')}
            checked={s['auth.newSignInNotice']}
          />
          <p className="-mt-2 text-xs text-muted-foreground">{t('settings.newSignInNoticeHint')}</p>
          <h2 className="mt-2 font-semibold">{t('settings.lockout')}</h2>
          <FormField
            name="lockoutThreshold"
            type="number"
            min={0}
            max={1000}
            label={t('settings.lockoutThreshold')}
            hint={t('settings.lockoutThresholdHint')}
            defaultValue={s['lockout.threshold']}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="lockoutWindow"
              type="number"
              min={1}
              max={10080}
              label={t('settings.lockoutWindow')}
              defaultValue={s['lockout.windowMinutes']}
            />
            <FormField
              name="lockoutDuration"
              type="number"
              min={1}
              max={10080}
              label={t('settings.lockoutDuration')}
              defaultValue={s['lockout.durationMinutes']}
            />
          </div>
        </Form>
      );
      break;
    case 'email':
      body = (
        <div className="grid gap-6">
          <Form section="email" save={tc('save')} saved={tc('saved')}>
            <FormField
              name="fromName"
              label={t('settings.fromName')}
              defaultValue={s['email.fromName']}
            />
          </Form>
          <TestEmailButton label={t('settings.testEmail')} done={t('settings.testEmailSent')} />
        </div>
      );
      break;
    case 'maintenance':
      body = (
        <Form section="maintenance" save={tc('save')} saved={tc('saved')}>
          <p className="text-sm text-muted-foreground">{t('settings.maintenanceHint')}</p>
          <Toggle
            name="maintenanceEnabled"
            label={t('settings.maintenanceEnabled')}
            checked={s['maintenance.enabled']}
          />
          <FormField name="maintenanceMessage" label={t('settings.maintenanceMessage')}>
            <Textarea
              id="f-maintenanceMessage"
              name="maintenanceMessage"
              maxLength={2000}
              defaultValue={s['maintenance.message']}
              placeholder={t('settings.maintenanceMessagePlaceholder')}
            />
          </FormField>
          <FormField
            name="maintenanceUntil"
            label={t('settings.maintenanceUntil')}
            hint={t('settings.maintenanceUntilHint')}
          >
            <DateTimeInput
              id="f-maintenanceUntil"
              name="maintenanceUntil"
              defaultValue={s['maintenance.until']}
            />
          </FormField>
          <p className="text-xs text-muted-foreground">
            {t('settings.maintenanceCli')} <code>hubium maintenance on|off</code>
          </p>
        </Form>
      );
      break;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[12rem_1fr]">
      <SectionNav
        active={section}
        items={SECTIONS.map((k) => ({ key: k, href: `/admin/settings/${k}`, label: t(k) }))}
      />
      <Card>
        <CardContent className="pt-5">{body}</CardContent>
      </Card>
    </div>
  );
}

function Form({
  section,
  children,
  save,
  saved,
}: {
  section: string;
  children: React.ReactNode;
  save: string;
  saved: string;
}) {
  return (
    <ActionForm action={saveSettingsAction} success={saved} className="grid max-w-xl gap-4">
      <input type="hidden" name="_section" value={section} />
      {children}
      <div>
        <SubmitButton>{save}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function Toggle({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label htmlFor={`t-${name}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`t-${name}`} name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}
