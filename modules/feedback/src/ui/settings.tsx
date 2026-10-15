'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { FeedbackSettingsT } from '../server.ts';

type Flag = 'anonymous' | 'multipleSubmit' | 'showAnalysis' | 'notifyTeachers' | 'autoNumbering';

export function FeedbackSettingsFields({ settings }: SettingsFieldsProps<FeedbackSettingsT>) {
  const t = useTranslations('mod.feedback');
  const closesError = useFieldErrors('settings.closesAt');
  const flag = (name: Flag) => (
    <label htmlFor={`fb-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`fb-${name}`} name={`settings.${name}`} defaultChecked={settings[name]} />
      {t(name)}
    </label>
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {flag('anonymous')}
        {flag('multipleSubmit')}
        {flag('showAnalysis')}
        {flag('notifyTeachers')}
        {flag('autoNumbering')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('opensAt')} htmlFor="fb-opensAt">
          <DateTimeInput id="fb-opensAt" name="settings.opensAt" defaultValue={settings.opensAt} />
        </Field>
        <Field label={t('closesAt')} htmlFor="fb-closesAt" error={closesError}>
          <DateTimeInput
            id="fb-closesAt"
            name="settings.closesAt"
            defaultValue={settings.closesAt}
            ariaInvalid={!!closesError}
          />
        </Field>
      </div>
      <Field label={t('thankYou')} htmlFor="fb-thankYou">
        <Textarea
          id="fb-thankYou"
          name="settings.thankYou"
          rows={2}
          maxLength={2000}
          defaultValue={settings.thankYou}
        />
      </Field>
    </div>
  );
}

export function FeedbackCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.feedback');
  return (
    <label htmlFor="fbc-submitted" className="flex items-center gap-2 text-sm">
      <Checkbox id="fbc-submitted" name="completion.submitted" defaultChecked={!!rules.submitted} />
      {t('completionSubmitted')}
    </label>
  );
}
