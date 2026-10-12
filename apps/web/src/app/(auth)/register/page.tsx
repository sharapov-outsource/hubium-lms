import { getAllSettings } from '@hubium/core';
import { configuredOAuthProviders } from '@hubium/core/auth/auth';
import { Alert } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { RegisterForm } from './register-form';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('signUpTitle') };
}

export default async function RegisterPage() {
  const [settings, t] = await Promise.all([getAllSettings(db), getTranslations('auth')]);
  if (!settings['registration.enabled']) {
    return <Alert variant="warning">{t('registrationDisabled')}</Alert>;
  }
  const providers = configuredOAuthProviders().filter((p) => settings[`auth.oauth.${p}`]);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t('signUpTitle')}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        {t('signUpSubtitle', { site: settings['site.name'] })}
      </p>
      <RegisterForm
        providers={providers}
        consentText={settings['registration.consentText'] || t('consent')}
      />
    </div>
  );
}
