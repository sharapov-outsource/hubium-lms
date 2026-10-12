'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';

export function UrlSettings({ settings }: SettingsFieldsProps<{ url: string; display: string }>) {
  const t = useTranslations('mod.url');
  const urlError = useFieldErrors('settings.url');
  return (
    <div className="grid gap-4">
      <Field label={t('url')} htmlFor="f-settings-url" error={urlError}>
        <Input
          id="f-settings-url"
          name="settings.url"
          type="url"
          defaultValue={settings.url}
          required
          aria-invalid={!!urlError}
        />
      </Field>
      <Field label={t('display')} htmlFor="f-settings-display">
        <Select id="f-settings-display" name="settings.display" defaultValue={settings.display}>
          <option value="newtab">{t('displayNewtab')}</option>
          <option value="link">{t('displayLink')}</option>
          <option value="embed">{t('displayEmbed')}</option>
        </Select>
      </Field>
    </div>
  );
}
