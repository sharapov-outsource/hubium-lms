'use client';

import { Alert, Button, Checkbox, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { createApiTokenAction } from '@/server/actions/tokens';

export function NewTokenForm() {
  const t = useTranslations('apiTokens');
  const [token, setToken] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      <ActionForm
        action={createApiTokenAction}
        resetOnSuccess
        onSuccess={(r) => setToken(r.token)}
        className="grid gap-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="name" label={t('name')} required maxLength={100} />
          <FormField name="expiresInDays" label={t('expires')}>
            <Select id="f-expiresInDays" name="expiresInDays" defaultValue="90">
              <option value="30">{t('days', { n: 30 })}</option>
              <option value="90">{t('days', { n: 90 })}</option>
              <option value="365">{t('days', { n: 365 })}</option>
              <option value="never">{t('never')}</option>
            </Select>
          </FormField>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 w-full font-medium">{t('scopes')}</legend>
          <label htmlFor="scope-read" className="flex items-center gap-2">
            <Checkbox id="scope-read" name="scopes" value="read" defaultChecked />
            {t('scopeRead')}
          </label>
          <label htmlFor="scope-write" className="flex items-center gap-2">
            <Checkbox id="scope-write" name="scopes" value="write" />
            {t('scopeWrite')}
          </label>
        </fieldset>
        <SubmitButton className="w-fit">{t('create')}</SubmitButton>
      </ActionForm>
      {token ? (
        <Alert variant="success" className="grid gap-2">
          <strong>{t('createdTitle')}</strong>
          <span className="text-sm">{t('createdHint')}</span>
          <code
            className="break-all rounded bg-muted p-2 font-mono text-xs"
            data-testid="new-token"
          >
            {token}
          </code>
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => {
              void navigator.clipboard?.writeText(token);
              toast.success(t('copied'));
            }}
          >
            {t('copy')}
          </Button>
        </Alert>
      ) : null}
    </div>
  );
}
