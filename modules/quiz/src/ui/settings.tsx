'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { QuizSettingsT } from '../server.ts';

function Bool({
  name,
  label,
  checked,
}: {
  name: keyof QuizSettingsT;
  label: string;
  checked: boolean;
}) {
  return (
    <label htmlFor={`qs-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`qs-${name}`} name={`settings.${name}`} defaultChecked={checked} />
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
  name: keyof QuizSettingsT;
  label: string;
  value?: number;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`qs-${name}`} error={error}>
      <Input
        id={`qs-${name}`}
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

export function QuizSettingsFields({ settings }: SettingsFieldsProps<QuizSettingsT>) {
  const t = useTranslations('mod.quiz');
  const closeError = useFieldErrors('settings.closeAt');
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('openAt')} htmlFor="qs-openAt">
          <DateTimeInput id="qs-openAt" name="settings.openAt" defaultValue={settings.openAt} />
        </Field>
        <Field label={t('closeAt')} htmlFor="qs-closeAt" error={closeError}>
          <DateTimeInput
            id="qs-closeAt"
            name="settings.closeAt"
            defaultTime="23:59"
            defaultValue={settings.closeAt}
            ariaInvalid={!!closeError}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Num name="timeLimitMin" label={t('timeLimitMin')} value={settings.timeLimitMin} />
        <Num name="attempts" label={t('attempts')} value={settings.attempts} />
        <Field label={t('gradeMethod')} htmlFor="qs-gradeMethod">
          <Select
            id="qs-gradeMethod"
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
        <Num name="perPage" label={t('perPage')} value={settings.perPage} />
      </div>
      <div className="grid gap-2">
        <Bool
          name="shuffleQuestions"
          label={t('shuffleQuestions')}
          checked={settings.shuffleQuestions}
        />
        <Bool name="shuffleAnswers" label={t('shuffleAnswers')} checked={settings.shuffleAnswers} />
        <Bool name="reviewMarks" label={t('reviewMarks')} checked={settings.reviewMarks} />
      </div>
      <Field label={t('reviewAnswers')} htmlFor="qs-reviewAnswers">
        <Select
          id="qs-reviewAnswers"
          name="settings.reviewAnswers"
          defaultValue={settings.reviewAnswers}
        >
          {(['immediately', 'afterClose', 'never'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`reviewWhen.${m}`)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function QuizCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.quiz');
  return (
    <div className="grid gap-2">
      {(['attempted', 'pass'] as const).map((k) => (
        <label key={k} htmlFor={`qc-${k}`} className="flex items-center gap-2 text-sm">
          <Checkbox id={`qc-${k}`} name={`completion.${k}`} defaultChecked={!!rules[k]} />
          {k === 'attempted' ? t('completionAttempted') : t('completionPass')}
        </label>
      ))}
    </div>
  );
}
