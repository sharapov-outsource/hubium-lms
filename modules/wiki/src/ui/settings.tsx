'use client';

import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { WikiSettingsT } from '../server.ts';

export function WikiSettingsFields({ settings, activityId }: SettingsFieldsProps<WikiSettingsT>) {
  const t = useTranslations('mod.wiki.settings');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('mode')} htmlFor="wk-mode" hint={t('modeHint')}>
        <Select id="wk-mode" name="settings.mode" defaultValue={settings.mode}>
          <option value="collaborative">{t('modes.collaborative')}</option>
          <option value="individual">{t('modes.individual')}</option>
        </Select>
      </Field>
      <Field
        label={t('firstPageTitle')}
        htmlFor="wk-first"
        hint={activityId ? t('firstPageHint') : undefined}
      >
        <Input
          id="wk-first"
          name="settings.firstPageTitle"
          maxLength={255}
          required
          defaultValue={settings.firstPageTitle || (activityId ? '' : t('firstPageDefault'))}
        />
      </Field>
    </div>
  );
}

export function WikiCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.wiki.settings');
  return (
    <Field label={t('completionEdits')} htmlFor="wkc-edits">
      <Input
        id="wkc-edits"
        name="completion.edits"
        type="number"
        min={0}
        max={1000}
        defaultValue={rules.edits === undefined ? '' : Number(rules.edits)}
        className="w-28"
      />
    </Field>
  );
}
