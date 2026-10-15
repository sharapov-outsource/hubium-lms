'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { H5pSettingsT } from '../server.ts';

function Num({
  name,
  label,
  value,
  min = 0,
}: {
  name: keyof H5pSettingsT;
  label: string;
  value?: number;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`h5p-${name}`} error={error}>
      <Input
        id={`h5p-${name}`}
        name={`settings.${name}`}
        type="number"
        min={min}
        step="any"
        defaultValue={value ?? ''}
        aria-invalid={!!error}
      />
    </Field>
  );
}

function Flag({ name, label, value }: { name: keyof H5pSettingsT; label: string; value: boolean }) {
  return (
    <label htmlFor={`h5p-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`h5p-${name}`} name={`settings.${name}`} defaultChecked={value} />
      {label}
    </label>
  );
}

export function H5pSettingsFields({ settings }: SettingsFieldsProps<H5pSettingsT>) {
  const t = useTranslations('mod.h5p');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('uploadAfterSave')}</p>
      <Flag name="tracking" label={t('tracking')} value={settings.tracking} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('gradeMethod')} htmlFor="h5p-gradeMethod">
          <Select
            id="h5p-gradeMethod"
            name="settings.gradeMethod"
            defaultValue={settings.gradeMethod}
          >
            {(['HIGHEST', 'AVERAGE', 'FIRST', 'LAST'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`gradeMethods.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Num name="gradeMax" label={t('gradeMax')} value={settings.gradeMax} min={1} />
        <Num name="gradePass" label={t('gradePass')} value={settings.gradePass} />
      </div>
      <Flag name="showFrame" label={t('showFrame')} value={settings.showFrame} />
      <Flag name="showCopyright" label={t('showCopyright')} value={settings.showCopyright} />
    </div>
  );
}

export function H5pCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.h5p');
  return (
    <div className="grid gap-3">
      <label htmlFor="h5pc-completed" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="h5pc-completed"
          name="completion.completed"
          defaultChecked={!!rules.completed}
        />
        {t('completionCompleted')}
      </label>
      <label htmlFor="h5pc-passed" className="flex items-center gap-2 text-sm">
        <Checkbox id="h5pc-passed" name="completion.passed" defaultChecked={!!rules.passed} />
        {t('completionPassed')}
      </label>
      <Field label={t('completionMinScore')} htmlFor="h5pc-minScore">
        <Input
          id="h5pc-minScore"
          name="completion.minScore"
          type="number"
          min={0}
          max={100}
          defaultValue={Number(rules.minScore ?? 0)}
          className="w-28"
        />
      </Field>
    </div>
  );
}
