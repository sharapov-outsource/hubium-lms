import { getAllSettings } from '@hubium/core';
import { configuredOAuthProviders } from '@hubium/core/auth/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';
import { LoginForm } from './login-form';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('signIn') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await getCurrentUser()) redirect('/dashboard');
  const [settings, t, sp] = await Promise.all([
    getAllSettings(db),
    getTranslations('auth'),
    searchParams,
  ]);
  const providers = configuredOAuthProviders().filter((p) => settings[`auth.oauth.${p}`]);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('signInTitle', { site: settings['site.name'] })}
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('signInSubtitle')}</p>
      <LoginForm
        providers={providers}
        registration={settings['registration.enabled']}
        next={sp.next}
      />
    </div>
  );
}
