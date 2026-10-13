'use client';

import { Alert, Button, Checkbox, Field, Input } from '@hubium/ui';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { OAuthButtons } from '@/components/oauth-buttons';
import { authClient } from '@/lib/auth-client';

export function RegisterForm({
  providers,
  consentText,
}: {
  providers: ('google' | 'yandex' | 'vk')[];
  consentText: string;
}) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = Object.fromEntries(fd.entries()) as Record<string, string>;
    const errs: Record<string, string> = {};
    if (!v.firstName?.trim()) errs.firstName = tc('required');
    if (!v.lastName?.trim()) errs.lastName = tc('required');
    if ((v.password ?? '').length < 8) errs.password = t('passwordHint');
    if (v.password !== v.password2) errs.password2 = t('passwordsMismatch');
    if (!v.consent) errs.consent = t('consentRequired');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setPending(true);
    setFormError(null);
    const res = await authClient.signUp.email({
      email: v.email!.trim(),
      password: v.password!,
      name: `${v.firstName!.trim()} ${v.lastName!.trim()}`,
      firstName: v.firstName!.trim(),
      lastName: v.lastName!.trim(),
      locale,
      callbackURL: '/dashboard',
    } as Parameters<typeof authClient.signUp.email>[0]);
    setPending(false);
    if (res.error) {
      setFormError(res.error.message ?? t('invalidCredentials'));
      return;
    }
    // signed in at once when the site does not require email verification
    if (res.data?.token) {
      window.location.assign('/dashboard');
      return;
    }
    setSentTo(v.email!.trim());
  }

  if (sentTo) {
    return (
      <Alert variant="success">
        <p className="font-medium">{t('checkEmailTitle')}</p>
        <p className="mt-1">{t('checkEmailText', { email: sentTo })}</p>
      </Alert>
    );
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {formError ? <Alert variant="destructive">{formError}</Alert> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('firstName')} htmlFor="firstName" error={errors.firstName}>
            <Input
              id="firstName"
              name="firstName"
              autoComplete="given-name"
              required
              aria-invalid={!!errors.firstName}
            />
          </Field>
          <Field label={t('lastName')} htmlFor="lastName" error={errors.lastName}>
            <Input
              id="lastName"
              name="lastName"
              autoComplete="family-name"
              required
              aria-invalid={!!errors.lastName}
            />
          </Field>
        </div>
        <Field label={t('email')} htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field
          label={t('password')}
          htmlFor="password"
          hint={t('passwordHint')}
          error={errors.password}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={!!errors.password}
          />
        </Field>
        <Field label={t('repeatPassword')} htmlFor="password2" error={errors.password2}>
          <Input
            id="password2"
            name="password2"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={!!errors.password2}
          />
        </Field>
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-sm" htmlFor="consent">
            <Checkbox id="consent" name="consent" className="mt-0.5" />
            <span>{consentText}</span>
          </label>
          {errors.consent ? (
            <p className="text-xs text-destructive" role="alert">
              {errors.consent}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={pending} size="lg">
          {t('signUp')}
        </Button>
      </form>
      <OAuthButtons providers={providers} />
      <p className="text-center text-sm text-muted-foreground">
        {t('haveAccount')}{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          {t('signIn')}
        </Link>
      </p>
    </div>
  );
}
