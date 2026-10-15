'use client';

import { Alert, Button, Field, Input } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { withIssuer } from '@/lib/totp-uri';

/**
 * `issuer`: the site name, shown for the account in authenticator apps. Without a password
 * here (`hasPassword` false) there is nothing to confirm with: a recent sign-in stands for it.
 */
export function TwoFactorPanel({
  enabled,
  issuer,
  hasPassword,
}: {
  enabled: boolean;
  issuer: string;
  hasPassword: boolean;
}) {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const [step, setStep] = useState<'idle' | 'password' | 'verify' | 'codes'>('idle');
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
  // what the password confirms: turning 2FA on or off, or new backup codes
  const [purpose, setPurpose] = useState<'toggle' | 'codes'>('toggle');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await confirm(purpose, String(new FormData(e.currentTarget).get('password') ?? ''));
  }

  /** Turns 2FA on or off, or makes new backup codes, confirmed by the password if any. */
  async function confirm(what: 'toggle' | 'codes', password?: string) {
    setError(null);
    setPending(true);
    const refused = (e: { code?: string } | null) =>
      setError(e?.code === 'SESSION_NOT_FRESH' ? t('signInAgainFor2fa') : ta('invalidCredentials'));
    if (what === 'codes') {
      const r = await authClient.twoFactor.generateBackupCodes({ password });
      setPending(false);
      if (r.error || !r.data) return refused(r.error);
      setSetup({ uri: '', codes: r.data.backupCodes });
      setStep('codes');
      return;
    }
    if (enabled) {
      const r = await authClient.twoFactor.disable({ password });
      setPending(false);
      if (r.error) return refused(r.error);
      toast.success(t('twoFactorDisabled'));
      setStep('idle');
      router.refresh();
      return;
    }
    const r = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (r.error || !r.data || r.data.method !== 'totp') return refused(r.error);
    setSetup({ uri: withIssuer(r.data.totpURI, issuer), codes: r.data.backupCodes });
    setStep('verify');
  }

  /** The password step, or straight on without a password to ask for. */
  function start(what: 'toggle' | 'codes') {
    setPurpose(what);
    if (hasPassword) setStep('password');
    else void confirm(what);
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
      <div className="grid gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={enabled ? 'outline' : 'primary'}
            disabled={pending}
            onClick={() => start('toggle')}
          >
            {enabled ? t('twoFactorDisable') : t('twoFactorEnable')}
          </Button>
          {enabled ? (
            <Button variant="outline" disabled={pending} onClick={() => start('codes')}>
              {t('twoFactorNewCodes')}
            </Button>
          ) : null}
        </div>
      </div>
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
          {tc('done')}
        </Button>
      </div>
    </div>
  );
}
