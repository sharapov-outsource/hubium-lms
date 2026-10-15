'use client';

import { EditorField } from '@hubium/editor/field';
import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { strategies } from '../engine.ts';
import type { WorkshopSettingsT } from '../server.ts';

type Num =
  | 'gradeMax'
  | 'gradePass'
  | 'gradingGradeMax'
  | 'gradingGradePass'
  | 'maxAttachments'
  | 'maxFileMB';
type When = 'submissionStart' | 'submissionEnd' | 'assessmentStart' | 'assessmentEnd';
type Flag = 'lateSubmissions' | 'phaseSwitch' | 'selfAssessment';

export function WorkshopSettingsFields({
  settings,
  courseId,
}: SettingsFieldsProps<WorkshopSettingsT>) {
  const t = useTranslations('mod.workshop');
  const textError = useFieldErrors('settings.submissionText');
  const num = (name: Num, min = 0) => (
    <NumberField name={name} label={t(`settings.${name}`)} value={settings[name]} min={min} />
  );
  const when = (name: When) => (
    <WhenField name={name} label={t(`settings.${name}`)} value={settings[name]} />
  );
  const flag = (name: Flag) => (
    <label htmlFor={`wss-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`wss-${name}`} name={`settings.${name}`} defaultChecked={settings[name]} />
      {t(`settings.${name}`)}
    </label>
  );
  const presence = (name: 'submissionText' | 'submissionFiles') => (
    <Field
      label={t(`settings.${name}`)}
      htmlFor={`wss-${name}`}
      error={name === 'submissionText' ? textError : undefined}
    >
      <Select id={`wss-${name}`} name={`settings.${name}`} defaultValue={settings[name]}>
        {(['required', 'optional', 'off'] as const).map((k) => (
          <option key={k} value={k}>
            {t(`settings.presence.${k}`)}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('settings.grading')}</legend>
        <Field
          label={t('settings.strategy')}
          htmlFor="wss-strategy"
          hint={t('settings.strategyHint')}
        >
          <Select id="wss-strategy" name="settings.strategy" defaultValue={settings.strategy}>
            {strategies.map((k) => (
              <option key={k} value={k}>
                {t(`strategies.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {num('gradeMax')}
          {num('gradePass')}
          {num('gradingGradeMax')}
          {num('gradingGradePass')}
        </div>
        <Field label={t('comparison')} htmlFor="wss-comparison">
          <Select
            id="wss-comparison"
            name="settings.comparison"
            defaultValue={String(settings.comparison)}
          >
            {[9, 7, 5, 3, 1].map((c) => (
              <option key={c} value={c}>
                {t(`comparisons.${c}`)}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('settings.submissions')}</legend>
        <EditorField
          name="settings.instructAuthors"
          label={t('instructAuthors')}
          defaultValue={settings.instructAuthors}
          courseId={courseId}
          minHeight={120}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {presence('submissionText')}
          {presence('submissionFiles')}
          {num('maxAttachments')}
          {num('maxFileMB', 1)}
          {when('submissionStart')}
          {when('submissionEnd')}
        </div>
        {flag('lateSubmissions')}
        {flag('phaseSwitch')}
      </fieldset>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('settings.assessment')}</legend>
        <EditorField
          name="settings.instructReviewers"
          label={t('instructReviewers')}
          defaultValue={settings.instructReviewers}
          courseId={courseId}
          minHeight={120}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {when('assessmentStart')}
          {when('assessmentEnd')}
        </div>
        {flag('selfAssessment')}
      </fieldset>
      <EditorField
        name="settings.conclusion"
        label={t('conclusion')}
        defaultValue={settings.conclusion}
        courseId={courseId}
        minHeight={120}
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
  value: number | undefined;
  min: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`wss-${name}`} error={error}>
      <Input
        id={`wss-${name}`}
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

function WhenField({ name, label, value }: { name: When; label: string; value: string | null }) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`wss-${name}`} error={error}>
      <DateTimeInput
        id={`wss-${name}`}
        name={`settings.${name}`}
        defaultValue={value}
        ariaInvalid={!!error}
      />
    </Field>
  );
}

export function WorkshopCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.workshop');
  return (
    <div className="grid gap-2">
      <label htmlFor="wsc-submitted" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="wsc-submitted"
          name="completion.submitted"
          defaultChecked={!!rules.submitted}
        />
        {t('settings.completionSubmitted')}
      </label>
      <label htmlFor="wsc-assessed" className="flex items-center gap-2 text-sm">
        <Checkbox id="wsc-assessed" name="completion.assessed" defaultChecked={!!rules.assessed} />
        {t('settings.completionAssessed')}
      </label>
    </div>
  );
}
