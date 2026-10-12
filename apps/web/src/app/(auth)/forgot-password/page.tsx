'use client';

import { Alert, Button, Field, Input } from '@hubium/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    setPending(false);
    setSent(true);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t('forgotTitle')}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('forgotSubtitle')}</p>
      {sent ? (
        <Alert variant="success">{t('forgotSent')}</Alert>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4">
          <Field label={t('email')} htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Button type="submit" disabled={pending} size="lg">
            {t('sendLink')}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-accent hover:underline">
          {t('backToSignIn')}
        </Link>
      </p>
    </div>
  );
}
