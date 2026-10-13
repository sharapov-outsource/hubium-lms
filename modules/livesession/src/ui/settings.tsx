'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { LiveSettingsT } from '../server.ts';

export function LiveSettingsFields({ settings }: SettingsFieldsProps<LiveSettingsT>) {
  const t = useTranslations('mod.livesession');
  const startError = useFieldErrors('settings.startsAt');
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('provider')} htmlFor="ls-provider">
          <Select id="ls-provider" name="settings.provider" defaultValue={settings.provider}>
            <option value="jitsi">Jitsi Meet</option>
            <option value="bbb">BigBlueButton</option>
          </Select>
        </Field>
        <Field label={t('startsAt')} htmlFor="ls-startsAt" error={startError}>
          <DateTimeInput
            id="ls-startsAt"
            name="settings.startsAt"
            defaultTime="09:00"
            defaultValue={settings.startsAt}
            ariaInvalid={!!startError}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('durationMin')} htmlFor="ls-durationMin">
          <Input
            id="ls-durationMin"
            name="settings.durationMin"
            type="number"
            min={5}
            defaultValue={settings.durationMin}
          />
        </Field>
        <Field label={t('joinEarlyMin')} htmlFor="ls-joinEarlyMin">
          <Input
            id="ls-joinEarlyMin"
            name="settings.joinEarlyMin"
            type="number"
            min={0}
            defaultValue={settings.joinEarlyMin}
          />
        </Field>
      </div>
      <Field label={t('welcome')} htmlFor="ls-welcome">
        <Textarea
          id="ls-welcome"
          name="settings.welcome"
          defaultValue={settings.welcome}
          rows={2}
        />
      </Field>
      <label htmlFor="ls-record" className="flex items-center gap-2 text-sm">
        <input type="hidden" name="settings.__bool" value="record" />
        <Checkbox id="ls-record" name="settings.record" defaultChecked={settings.record} />
        {t('record')}
      </label>
    </div>
  );
}

export function LiveCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.livesession');
  return (
    <label htmlFor="lc-attended" className="flex items-center gap-2 text-sm">
      <Checkbox id="lc-attended" name="completion.attended" defaultChecked={!!rules.attended} />
      {t('completionAttended')}
    </label>
  );
}
