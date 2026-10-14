'use client';

import { Alert, Button, Field, Input } from '@hubium/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { type PasswordRules, passwordHint } from '@/lib/password-hint';

function ResetForm({ rules }: { rules: PasswordRules }) {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'idle' | 'done' | 'error'>(
    params.get('error') ? 'error' : 'idle',
  );
  const [mismatch, setMismatch] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get('password') ?? '');
    if (password !== fd.get('password2')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setPending(true);
    const res = await authClient.resetPassword({ newPassword: password, token: token ?? '' });
    setPending(false);
    // a password the policy refuses can be corrected; any other failure is a bad link
    if (res.error?.code === 'PASSWORD_POLICY') {
      setPolicyError(res.error.message ?? passwordHint(t, rules));
      return;
    }
    setPolicyError(null);
    setState(res.error ? 'error' : 'done');
  }

  if (!token || state === 'error') return <Alert variant="destructive">{t('resetInvalid')}</Alert>;
  if (state === 'done') return <Alert variant="success">{t('resetDone')}</Alert>;
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <Field
        label={t('newPassword')}
        htmlFor="password"
        hint={passwordHint(t, rules)}
        error={policyError ?? undefined}
      >
        <Input
          id="password"
          name="password"
          type="password"
          minLength={rules.minLength}
          aria-invalid={!!policyError}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field
        label={t('repeatPassword')}
        htmlFor="password2"
        error={mismatch ? t('passwordsMismatch') : undefined}
      >
        <Input
          id="password2"
          name="password2"
          type="password"
          autoComplete="new-password"
          required
        />
      </Field>
      <Button type="submit" disabled={pending} size="lg">
        {t('resetTitle')}
      </Button>
    </form>
  );
}

export function ResetPasswordView({ rules }: { rules: PasswordRules }) {
  const t = useTranslations('auth');
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{t('resetTitle')}</h1>
      <Suspense>
        <ResetForm rules={rules} />
      </Suspense>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-accent hover:underline">
          {t('backToSignIn')}
        </Link>
      </p>
    </div>
  );
}
