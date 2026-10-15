'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { LessonSettingsT } from '../server.ts';

type Flag =
  | 'practice'
  | 'customScoring'
  | 'retake'
  | 'useMaxGrade'
  | 'review'
  | 'feedback'
  | 'ongoing'
  | 'progressBar'
  | 'displayMenu';
type Num = 'gradeMax' | 'gradePass' | 'maxAttempts' | 'minQuestions' | 'timeLimitMin';

export function LessonSettingsFields({ settings }: SettingsFieldsProps<LessonSettingsT>) {
  const t = useTranslations('mod.lesson.settings');
  const closesError = useFieldErrors('settings.closesAt');
  const flag = (name: Flag) => (
    <label htmlFor={`ls-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`ls-${name}`} name={`settings.${name}`} defaultChecked={settings[name]} />
      {t(name)}
    </label>
  );
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('grading')}</legend>
        {flag('practice')}
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField name="gradeMax" label={t('gradeMax')} value={settings.gradeMax} />
          <NumberField name="gradePass" label={t('gradePass')} value={settings.gradePass} />
        </div>
        {flag('customScoring')}
        {flag('retake')}
        {flag('useMaxGrade')}
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            name="maxAttempts"
            label={t('maxAttempts')}
            value={settings.maxAttempts}
            min={1}
            max={10}
          />
          <NumberField
            name="minQuestions"
            label={t('minQuestions')}
            value={settings.minQuestions}
            hint={t('minQuestionsHint')}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('flow')}</legend>
        {flag('review')}
        {flag('feedback')}
        {flag('ongoing')}
        {flag('progressBar')}
        {flag('displayMenu')}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('opensAt')} htmlFor="ls-opensAt">
          <DateTimeInput id="ls-opensAt" name="settings.opensAt" defaultValue={settings.opensAt} />
        </Field>
        <Field label={t('closesAt')} htmlFor="ls-closesAt" error={closesError}>
          <DateTimeInput
            id="ls-closesAt"
            name="settings.closesAt"
            defaultValue={settings.closesAt}
            ariaInvalid={!!closesError}
          />
        </Field>
        <NumberField
          name="timeLimitMin"
          label={t('timeLimitMin')}
          value={settings.timeLimitMin}
          min={1}
        />
        <Field label={t('password')} htmlFor="ls-password" hint={t('passwordHint')}>
          <Input
            id="ls-password"
            name="settings.password"
            maxLength={255}
            autoComplete="off"
            defaultValue={settings.password}
          />
        </Field>
      </div>
    </div>
  );
}

function NumberField({
  name,
  label,
  value,
  min = 0,
  max,
  hint,
}: {
  name: Num;
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  hint?: string;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`ls-${name}`} error={error} hint={hint}>
      <Input
        id={`ls-${name}`}
        name={`settings.${name}`}
        type="number"
        min={min}
        max={max}
        step="any"
        defaultValue={value ?? ''}
        aria-invalid={!!error}
      />
    </Field>
  );
}

export function LessonCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.lesson.settings');
  return (
    <div className="grid gap-3">
      <label htmlFor="lsc-end" className="flex items-center gap-2 text-sm">
        <Checkbox id="lsc-end" name="completion.endReached" defaultChecked={!!rules.endReached} />
        {t('completionEnd')}
      </label>
      <Field label={t('completionTime')} htmlFor="lsc-time">
        <Input
          id="lsc-time"
          name="completion.timeSpentMin"
          type="number"
          min={0}
          max={10000}
          defaultValue={rules.timeSpentMin === undefined ? '' : Number(rules.timeSpentMin)}
          className="w-28"
        />
      </Field>
    </div>
  );
}
