'use client';

import { Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import {
  addRecoveryPassphraseAction,
  deleteRecoveryPassphraseAction,
} from '@/server/actions/account';

/**
 * Recovery phrases for a lost authenticator; shown while two-factor is on. A new one is
 * confirmed with the password, or without one here with a code from the app.
 */
export function RecoveryPassphrases({
  items,
  max,
  hasPassword,
}: {
  items: { id: string; name: string; created: string }[];
  max: number;
  hasPassword: boolean;
}) {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-4">
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium break-words">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.created}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`${tc('delete')}: ${p.name}`}
                onClick={() =>
                  start(async () => {
                    const r = await deleteRecoveryPassphraseAction(p.id);
                    if (!r.ok) toast.error(r.message);
                  })
                }
              >
                {tc('delete')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('recovery.none')}</p>
      )}
      {items.length < max ? (
        <ActionForm
          action={addRecoveryPassphraseAction}
          success={t('recovery.added')}
          resetOnSuccess
          className="grid max-w-md gap-3"
        >
          <FormField name="name" label={t('recovery.name')} hint={t('recovery.nameHint')} />
          <FormField
            name="passphrase"
            type="password"
            autoComplete="off"
            label={t('recovery.phrase')}
            hint={t('recovery.phraseHint')}
          />
          <FormField
            name="passphrase2"
            type="password"
            autoComplete="off"
            label={t('recovery.phrase2')}
          />
          {hasPassword ? (
            <FormField
              name="password"
              type="password"
              autoComplete="current-password"
              label={t('confirmPassword')}
            />
          ) : (
            <FormField
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              label={ta('code')}
            />
          )}
          <div>
            <SubmitButton>{t('recovery.add')}</SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
