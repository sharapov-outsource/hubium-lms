'use client';

import { Alert, Button, Checkbox, Field, Input } from '@hubium/ui';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { authClient, safeNext } from '@/lib/auth-client';

type Mode = 'app' | 'backup' | 'phrase';

function TwoFactorForm() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>('app');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const raw = String(fd.get('code') ?? '');
    const code = raw.replace(/\s+/g, '');
    const trustDevice = fd.get('trust') === 'on';
    setPending(true);
    const res =
      mode === 'phrase'
        ? await authClient.$fetch('/two-factor/verify-passphrase', {
            method: 'POST',
            body: { passphrase: raw },
          })
        : mode === 'backup'
          ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
          : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    setPending(false);
    if (res.error) {
      setError(mode === 'phrase' ? t('invalidRecoveryPhrase') : t('invalidCode'));
      return;
    }
    window.location.href = safeNext(params.get('next'));
  }

  const switchTo = (m: Mode) => {
    setError(null);
    setMode(m);
  };
  const label =
    mode === 'phrase' ? t('recoveryPhrase') : mode === 'backup' ? t('backupCode') : t('code');

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <Field label={label} htmlFor="code">
        <Input
          key={mode}
          id="code"
          name="code"
          type={mode === 'phrase' ? 'password' : 'text'}
          inputMode={mode === 'app' ? 'numeric' : 'text'}
          autoComplete={mode === 'phrase' ? 'off' : 'one-time-code'}
          pattern={mode === 'app' ? '[0-9 ]{6,7}' : undefined}
          required
          autoFocus
          className={mode === 'phrase' ? undefined : 'text-center text-lg tracking-widest'}
        />
      </Field>
      {mode === 'phrase' ? null : (
        <label htmlFor="trust" className="flex items-center gap-2 text-sm">
          <Checkbox id="trust" name="trust" />
          {t('trustDevice')}
        </label>
      )}
      <Button type="submit" disabled={pending} size="lg">
        {t('verify')}
      </Button>
      <div className="grid gap-1">
        {mode !== 'app' ? (
          <Button type="button" variant="link" onClick={() => switchTo('app')}>
            {t('useAppCode')}
          </Button>
        ) : null}
        {mode !== 'backup' ? (
          <Button type="button" variant="link" onClick={() => switchTo('backup')}>
            {t('useBackupCode')}
          </Button>
        ) : null}
        {mode !== 'phrase' ? (
          <Button type="button" variant="link" onClick={() => switchTo('phrase')}>
            {t('useRecoveryPhrase')}
          </Button>
        ) : null}
      </div>
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
