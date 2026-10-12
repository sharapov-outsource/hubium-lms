'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { ScormSettingsT } from '../server.ts';

function Num({
  name,
  label,
  value,
  min = 0,
}: {
  name: keyof ScormSettingsT;
  label: string;
  value?: number;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`sc-${name}`} error={error}>
      <Input
        id={`sc-${name}`}
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

export function ScormSettingsFields({ settings }: SettingsFieldsProps<ScormSettingsT>) {
  const t = useTranslations('mod.scorm');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('uploadAfterSave')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Num name="maxAttempts" label={t('maxAttempts')} value={settings.maxAttempts} />
        <Field label={t('gradeMethod')} htmlFor="sc-gradeMethod">
          <Select
            id="sc-gradeMethod"
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
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Num name="gradeMax" label={t('gradeMax')} value={settings.gradeMax} min={1} />
        <Num name="gradePass" label={t('gradePass')} value={settings.gradePass} />
        <Num name="height" label={t('height')} value={settings.height} min={300} />
      </div>
      <label htmlFor="sc-newWindow" className="flex items-center gap-2 text-sm">
        <input type="hidden" name="settings.__bool" value="newWindow" />
        <Checkbox id="sc-newWindow" name="settings.newWindow" defaultChecked={settings.newWindow} />
        {t('newWindow')}
      </label>
    </div>
  );
}

export function ScormCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.scorm');
  return (
    <div className="grid gap-3">
      <label htmlFor="scc-completed" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="scc-completed"
          name="completion.completed"
          defaultChecked={!!rules.completed}
        />
        {t('completionCompleted')}
      </label>
      <label htmlFor="scc-passed" className="flex items-center gap-2 text-sm">
        <Checkbox id="scc-passed" name="completion.passed" defaultChecked={!!rules.passed} />
        {t('completionPassed')}
      </label>
      <Field label={t('completionMinScore')} htmlFor="scc-minScore">
        <Input
          id="scc-minScore"
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
