'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import { RatingSettingsFields } from '@hubium/module-sdk/ratings-ui';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { GlossarySettingsT } from '../server.ts';

type Flag = 'approvalRequired' | 'allowDuplicates' | 'allowEditing' | 'autoLink';

export function GlossarySettingsFields({
  settings,
  scales,
}: SettingsFieldsProps<GlossarySettingsT>) {
  const t = useTranslations('mod.glossary');
  const perPageError = useFieldErrors('settings.entriesPerPage');
  const flag = (name: Flag) => (
    <label htmlFor={`gl-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`gl-${name}`} name={`settings.${name}`} defaultChecked={settings[name]} />
      {t(`settings.${name}`)}
    </label>
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {flag('approvalRequired')}
        {flag('allowEditing')}
        {flag('allowDuplicates')}
        {flag('autoLink')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.displayFormat')} htmlFor="gl-displayFormat">
          <Select
            id="gl-displayFormat"
            name="settings.displayFormat"
            defaultValue={settings.displayFormat}
          >
            <option value="dictionary">{t('settings.formats.dictionary')}</option>
            <option value="full">{t('settings.formats.full')}</option>
          </Select>
        </Field>
        <Field
          label={t('settings.entriesPerPage')}
          htmlFor="gl-entriesPerPage"
          error={perPageError}
        >
          <Input
            id="gl-entriesPerPage"
            name="settings.entriesPerPage"
            type="number"
            min={5}
            max={200}
            defaultValue={settings.entriesPerPage}
            aria-invalid={!!perPageError}
          />
        </Field>
      </div>
      <RatingSettingsFields
        idPrefix="gl"
        messages="mod.glossary.ratings"
        settings={settings}
        scales={scales ?? []}
      />
    </div>
  );
}

export function GlossaryCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.glossary');
  return (
    <Field label={t('completionEntries')} htmlFor="glc-entries">
      <Input
        id="glc-entries"
        name="completion.entries"
        type="number"
        min={0}
        max={1000}
        defaultValue={rules.entries === undefined ? '' : Number(rules.entries)}
        className="w-28"
      />
    </Field>
  );
}
