'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { AssignSettingsT } from '../server.ts';

function Bool({
  name,
  label,
  checked,
}: {
  name: keyof AssignSettingsT;
  label: string;
  checked: boolean;
}) {
  return (
    <label htmlFor={`as-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`as-${name}`} name={`settings.${name}`} defaultChecked={checked} />
      {label}
    </label>
  );
}

function Num({
  name,
  label,
  value,
  min = 0,
}: {
  name: keyof AssignSettingsT;
  label: string;
  value?: number;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`as-${name}`} error={error}>
      <Input
        id={`as-${name}`}
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

function When({
  name,
  label,
  value,
}: {
  name: 'openAt' | 'dueAt' | 'cutoffAt';
  label: string;
  value: string | null | undefined;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`as-${name}`} error={error}>
      <DateTimeInput
        id={`as-${name}`}
        name={`settings.${name}`}
        defaultValue={value}
        ariaInvalid={!!error}
      />
    </Field>
  );
}

export function AssignSettingsFields({ settings }: SettingsFieldsProps<AssignSettingsT>) {
  const t = useTranslations('mod.assign');
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Bool name="allowText" label={t('allowText')} checked={settings.allowText} />
        <Bool name="allowFiles" label={t('allowFiles')} checked={settings.allowFiles} />
        {useFieldErrors('settings.allowText')?.map((e) => (
          <p key={e} className="text-xs text-destructive">
            {e}
          </p>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Num name="maxFiles" label={t('maxFiles')} value={settings.maxFiles} min={1} />
        <Num name="maxFileMB" label={t('maxFileMB')} value={settings.maxFileMB} min={1} />
        <Num name="wordLimit" label={t('wordLimit')} value={settings.wordLimit} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <When name="openAt" label={t('openAt')} value={settings.openAt} />
        <When name="dueAt" label={t('dueAt')} value={settings.dueAt} />
        <When name="cutoffAt" label={t('cutoffAt')} value={settings.cutoffAt} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Num name="gradeMax" label={t('gradeMax')} value={settings.gradeMax} min={1} />
        <Num name="gradePass" label={t('gradePass')} value={settings.gradePass} />
      </div>
      <Bool name="submitButton" label={t('submitButton')} checked={settings.submitButton} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('reopen')} htmlFor="as-reopen">
          <Select id="as-reopen" name="settings.reopen" defaultValue={settings.reopen}>
            <option value="none">{t('reopenNone')}</option>
            <option value="manual">{t('reopenManual')}</option>
            <option value="untilpass">{t('reopenUntilpass')}</option>
          </Select>
        </Field>
        <Num name="maxAttempts" label={t('maxAttempts')} value={settings.maxAttempts} />
      </div>
    </div>
  );
}

export function AssignCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.assign');
  const item = (key: 'submit' | 'grade' | 'pass', label: string) => (
    <label htmlFor={`ac-${key}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`ac-${key}`} name={`completion.${key}`} defaultChecked={!!rules[key]} />
      {label}
    </label>
  );
  return (
    <div className="grid gap-2">
      {item('submit', t('completionSubmit'))}
      {item('grade', t('completionGrade'))}
      {item('pass', t('completionPass'))}
    </div>
  );
}
