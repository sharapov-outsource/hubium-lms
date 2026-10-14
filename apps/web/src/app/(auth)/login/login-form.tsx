'use client';

import type { BuiltInOAuth } from '@hubium/core/auth/auth';
import { Alert, Button, Field, Input } from '@hubium/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { OAuthButtons } from '@/components/oauth-buttons';
import { authClient, safeNext } from '@/lib/auth-client';

export function LoginForm({
  providers,
  sso,
  registration,
  next,
  initialError,
}: {
  providers: BuiltInOAuth[];
  sso: { providerId: string; name: string; protocol: string }[];
  registration: boolean;
  next?: string;
  /** Why a single sign-on came back without signing in. */
  initialError?: string;
}) {
  const t = useTranslations('auth');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const login = String(fd.get('login') ?? '').trim();
    const password = String(fd.get('password') ?? '');
    const res = login.includes('@')
      ? await authClient.signIn.email({ email: login, password })
      : await authClient.signIn.username({ username: login, password });
    setPending(false);
    if (res.error) {
      const code = res.error.code ?? '';
      setError(
        code === 'EMAIL_NOT_VERIFIED'
          ? t('emailNotVerified')
          : code === 'ACCOUNT_LOCKED'
            ? t('accountLocked')
            : res.error.status === 429
              ? t('tooManyAttempts')
              : res.error.status === 403 && code !== 'EMAIL_NOT_VERIFIED'
                ? t('accountSuspended')
                : t('invalidCredentials'),
      );
      return;
    }
    if (res.data && 'twoFactorRedirect' in res.data && res.data.twoFactorRedirect) return;
    window.location.href = safeNext(next);
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label={t('login')} htmlFor="login">
          <Input id="login" name="login" autoComplete="username" required autoFocus />
        </Field>
        <Field label={t('password')} htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-sm text-accent hover:underline">
            {t('forgot')}
          </Link>
        </div>
        <Button type="submit" disabled={pending} size="lg">
          {t('signIn')}
        </Button>
      </form>
      <OAuthButtons providers={providers} sso={sso} next={next} />
      {registration ? (
        <p className="text-center text-sm text-muted-foreground">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-medium text-accent hover:underline">
            {t('signUp')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
