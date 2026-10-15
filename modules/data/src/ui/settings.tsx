'use client';

import { EditorField } from '@hubium/editor/field';
import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import { RatingSettingsFields } from '@hubium/module-sdk/ratings-ui';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { DataSettingsT } from '../server.ts';

type Num = 'maxEntries' | 'requiredEntriesToView' | 'entriesPerPage' | 'maxFileMB';

export function DataSettingsFields({
  settings,
  scales,
  courseId,
}: SettingsFieldsProps<DataSettingsT>) {
  const t = useTranslations('mod.data.settings');
  const closesError = useFieldErrors('settings.closesAt');
  const num = (name: Num, min: number) => (
    <NumberField name={name} label={t(name)} value={settings[name]} min={min} />
  );
  return (
    <div className="grid gap-4">
      <label htmlFor="ds-approvalRequired" className="flex items-center gap-2 text-sm">
        <input type="hidden" name="settings.__bool" value="approvalRequired" />
        <Checkbox
          id="ds-approvalRequired"
          name="settings.approvalRequired"
          defaultChecked={settings.approvalRequired}
        />
        {t('approvalRequired')}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {num('maxEntries', 0)}
        {num('requiredEntriesToView', 0)}
        {num('entriesPerPage', 1)}
        {num('maxFileMB', 1)}
        <Field label={t('opensAt')} htmlFor="ds-opensAt">
          <DateTimeInput id="ds-opensAt" name="settings.opensAt" defaultValue={settings.opensAt} />
        </Field>
        <Field label={t('closesAt')} htmlFor="ds-closesAt" error={closesError}>
          <DateTimeInput
            id="ds-closesAt"
            name="settings.closesAt"
            defaultValue={settings.closesAt}
            ariaInvalid={!!closesError}
          />
        </Field>
        <Field label={t('defaultSort')} htmlFor="ds-defaultSort" hint={t('defaultSortHint')}>
          <Input
            id="ds-defaultSort"
            name="settings.defaultSort"
            maxLength={255}
            defaultValue={settings.defaultSort}
          />
        </Field>
        <Field label={t('defaultOrder')} htmlFor="ds-defaultOrder">
          <Select
            id="ds-defaultOrder"
            name="settings.defaultOrder"
            defaultValue={settings.defaultOrder}
          >
            <option value="desc">{t('orders.desc')}</option>
            <option value="asc">{t('orders.asc')}</option>
          </Select>
        </Field>
      </div>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('templates')}</legend>
        <p className="text-xs text-muted-foreground">{t('templatesHint')}</p>
        <EditorField
          name="settings.listTemplate"
          label={t('listTemplate')}
          defaultValue={settings.listTemplate}
          courseId={courseId}
          minHeight={140}
        />
        <EditorField
          name="settings.singleTemplate"
          label={t('singleTemplate')}
          defaultValue={settings.singleTemplate}
          courseId={courseId}
          minHeight={140}
        />
      </fieldset>
      <RatingSettingsFields
        idPrefix="ds"
        messages="mod.data.ratings"
        settings={settings}
        scales={scales ?? []}
      />
    </div>
  );
}

function NumberField({
  name,
  label,
  value,
  min,
}: {
  name: Num;
  label: string;
  value: number;
  min: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`ds-${name}`} error={error}>
      <Input
        id={`ds-${name}`}
        name={`settings.${name}`}
        type="number"
        min={min}
        defaultValue={value}
        aria-invalid={!!error}
      />
    </Field>
  );
}

export function DataCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.data.settings');
  return (
    <Field label={t('completionEntries')} htmlFor="dsc-entries">
      <Input
        id="dsc-entries"
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
