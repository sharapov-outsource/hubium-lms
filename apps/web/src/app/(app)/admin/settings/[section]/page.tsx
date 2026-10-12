import { getAllSettings } from '@hubium/core';
import { configuredOAuthProviders } from '@hubium/core/auth/auth';
import { Badge, Card, CardContent, Checkbox, Select, Textarea } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveSettingsAction } from '@/server/actions/admin';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';
import { BrandingForm } from './branding-form';
import { SectionNav } from './section-nav';
import { TestEmailButton } from './test-email';

const SECTIONS = ['general', 'branding', 'registration', 'authentication', 'email'] as const;
type Section = (typeof SECTIONS)[number];

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
          <FormField name="defaultLocale" label={t('settings.defaultLocale')}>
            <Select
              id="f-defaultLocale"
              name="defaultLocale"
              defaultValue={s['site.defaultLocale']}
            >
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </Select>
          </FormField>
          <FormField
            name="defaultTimezone"
            label={t('settings.defaultTimezone')}
            defaultValue={s['site.defaultTimezone']}
          />
          <FormField name="creatorRole" label={t('settings.creatorRole')}>
            <Select id="f-creatorRole" name="creatorRole" defaultValue={s['course.creatorRole']}>
              {roles.map((r) => (
                <option key={r.id} value={r.shortName}>
                  {(r.name as Record<string, string>)[locale] ?? r.shortName}
                </option>
              ))}
            </Select>
          </FormField>
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
          {(['google', 'yandex', 'vk'] as const).map((p) => (
            <div key={p} className="grid gap-1 rounded-lg border border-border p-3">
              <Toggle
                name={p}
                label={p === 'google' ? 'Google' : p === 'yandex' ? 'Яндекс ID' : 'VK ID'}
                checked={s[`auth.oauth.${p}`]}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.callbackUrl')}:{' '}
                <code className="select-all">
                  {appUrl}/api/auth/{p === 'yandex' ? 'oauth2/callback/yandex' : `callback/${p}`}
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
