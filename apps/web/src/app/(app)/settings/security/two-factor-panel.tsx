'use client';

import { Alert, Button, Field, Input } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const [step, setStep] = useState<'idle' | 'password' | 'verify' | 'codes'>('idle');
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    if (enabled) {
      const r = await authClient.twoFactor.disable({ password });
      setPending(false);
      if (r.error) return setError(ta('invalidCredentials'));
      toast.success(t('twoFactorDisabled'));
      setStep('idle');
      router.refresh();
      return;
    }
    const r = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (r.error || !r.data || r.data.method !== 'totp') return setError(ta('invalidCredentials'));
    setSetup({ uri: r.data.totpURI, codes: r.data.backupCodes });
    setStep('verify');
  }

  async function submitCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s+/g, '');
    const r = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (r.error) return setError(ta('invalidCode'));
    toast.success(t('twoFactorEnabled'));
    setStep('codes');
  }

  if (step === 'idle') {
    return (
      <Button variant={enabled ? 'outline' : 'primary'} onClick={() => setStep('password')}>
        {enabled ? t('twoFactorDisable') : t('twoFactorEnable')}
      </Button>
    );
  }
  if (step === 'password') {
    return (
      <form onSubmit={submitPassword} className="grid max-w-sm gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label={t('confirmPassword')} htmlFor="tf-password">
          <Input
            id="tf-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {ta('verify')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStep('idle')}>
            {tc('cancel')}
          </Button>
        </div>
      </form>
    );
  }
  if (step === 'verify' && setup) {
    const secret = new URL(setup.uri).searchParams.get('secret') ?? '';
    return (
      <div className="grid gap-4">
        <p className="text-sm">{t('twoFactorScan')}</p>
        <div className="w-fit rounded-lg bg-white p-3">
          <QRCodeSVG value={setup.uri} size={176} />
        </div>
        <p className="text-xs text-muted-foreground">
          {t('twoFactorSecret')}: <code className="select-all font-mono">{secret}</code>
        </p>
        <form onSubmit={submitCode} className="grid max-w-xs gap-3">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field label={ta('code')} htmlFor="tf-code">
            <Input
              id="tf-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
            />
          </Field>
          <Button type="submit" disabled={pending}>
            {ta('verify')}
          </Button>
        </form>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <Alert variant="warning">{t('twoFactorBackupCodes')}</Alert>
      <ul
        className="grid w-fit grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm"
        data-testid="backup-codes"
      >
        {setup?.codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div>
        <Button
          onClick={() => {
            setStep('idle');
            router.refresh();
          }}
        >
          OK
        </Button>
      </div>
    </div>
  );
}
