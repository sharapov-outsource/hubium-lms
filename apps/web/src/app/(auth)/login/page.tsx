import { enabledSsoProviders, getAllSettings, ldapEnabled } from '@hubium/core';
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
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  if (await getCurrentUser()) redirect('/dashboard');
  const [settings, t, sp, sso, ldap] = await Promise.all([
    getAllSettings(db),
    getTranslations('auth'),
    searchParams,
    enabledSsoProviders(db),
    ldapEnabled(db),
  ]);
  const ssoErrors: Record<string, string> = {
    SSO_NO_ACCOUNT: t('ssoNoAccount'),
    SSO_ACCOUNT_NOT_LINKED: t('ssoNotLinked'),
    SSO_DISABLED: t('ssoDisabled'),
    // OAuth callbacks (Better Auth codes): no account may be created, or the email is taken
    unable_to_create_user: t('ssoNoAccount'),
    account_not_linked: t('ssoNotLinked'),
  };
  const error = sp.error ? (ssoErrors[sp.error] ?? t('ssoFailed')) : undefined;
  const providers = configuredOAuthProviders().filter((p) => settings[`auth.oauth.${p}`]);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('signInTitle', { site: settings['site.name'] })}
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('signInSubtitle')}</p>
      <LoginForm
        providers={providers}
        sso={sso}
        ldap={ldap}
        registration={settings['registration.enabled']}
        next={sp.next}
        initialError={error}
      />
    </div>
  );
}
