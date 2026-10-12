'use client';

import { Alert, Button, Checkbox, Field, Input } from '@hubium/ui';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { authClient, safeNext } from '@/lib/auth-client';

function TwoFactorForm() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const code = String(fd.get('code') ?? '').replace(/\s+/g, '');
    const trustDevice = fd.get('trust') === 'on';
    setPending(true);
    const res = backup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    setPending(false);
    if (res.error) {
      setError(true);
      return;
    }
    window.location.href = safeNext(params.get('next'));
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error ? <Alert variant="destructive">{t('invalidCode')}</Alert> : null}
      <Field label={backup ? t('backupCode') : t('code')} htmlFor="code">
        <Input
          id="code"
          name="code"
          inputMode={backup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          pattern={backup ? undefined : '[0-9 ]{6,7}'}
          required
          autoFocus
          className="text-center text-lg tracking-widest"
        />
      </Field>
      <label htmlFor="trust" className="flex items-center gap-2 text-sm">
        <Checkbox id="trust" name="trust" />
        {t('trustDevice')}
      </label>
      <Button type="submit" disabled={pending} size="lg">
        {t('verify')}
      </Button>
      <Button type="button" variant="link" onClick={() => setBackup((b) => !b)}>
        {backup ? t('useAppCode') : t('useBackupCode')}
      </Button>
    </form>
  );
}

export default function TwoFactorPage() {
  const t = useTranslations('auth');
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t('twoFactorTitle')}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('twoFactorSubtitle')}</p>
      <Suspense>
        <TwoFactorForm />
      </Suspense>
    </div>
  );
}
