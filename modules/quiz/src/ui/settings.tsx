'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
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

/** The quiz password: hidden unless shown, and never filled in by the browser. */
function PasswordField({ value }: { value: string }) {
  const t = useTranslations('mod.quiz');
  const [shown, setShown] = useState(false);
  return (
    <Field label={t('access.password')} htmlFor="qs-password" hint={t('access.passwordHint')}>
      <div className="flex gap-2">
        <Input
          id="qs-password"
          name="settings.password"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          defaultValue={value}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={shown ? t('access.hidePassword') : t('access.showPassword')}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
    </Field>
  );
}

export function QuizSettingsFields({ settings, nodes }: SettingsFieldsProps<QuizSettingsT>) {
  const t = useTranslations('mod.quiz');
  const closeError = useFieldErrors('settings.closeAt');
  const subnetError = useFieldErrors('settings.subnet');
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
      <Field label={t('access.navMethod')} htmlFor="qs-navMethod" hint={t('access.navMethodHint')}>
        <Select id="qs-navMethod" name="settings.navMethod" defaultValue={settings.navMethod}>
          {(['free', 'sequential'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`access.nav.${m}`)}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('behaviours.title')}</legend>
        <Field
          label={t('behaviours.behaviour')}
          htmlFor="qs-behaviour"
          hint={t('behaviours.behaviourHint')}
        >
          <Select id="qs-behaviour" name="settings.behaviour" defaultValue={settings.behaviour}>
            {(['deferred', 'immediate', 'interactive'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`behaviours.names.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-2">
          <Bool
            name="duringFeedback"
            label={t('behaviours.duringFeedback')}
            checked={settings.duringFeedback}
          />
          <Bool
            name="duringRightAnswer"
            label={t('behaviours.duringRightAnswer')}
            checked={settings.duringRightAnswer}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('access.title')}</legend>
        <PasswordField value={settings.password} />
        <Field
          label={t('access.subnet')}
          htmlFor="qs-subnet"
          hint={t('access.subnetHint')}
          error={subnetError}
        >
          <Input
            id="qs-subnet"
            name="settings.subnet"
            defaultValue={settings.subnet}
            placeholder="192.168.1.0/24, 10.1"
            aria-invalid={!!subnetError}
          />
        </Field>
        {nodes?.length ? (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{t('access.nodes')}</legend>
            <p className="text-sm text-muted-foreground">{t('access.nodesHint')}</p>
            {/* none checked: the field still comes, and clears the list */}
            <input type="hidden" name="settings.nodeIds" value="" />
            {nodes.map((n) => (
              <label
                key={n.id}
                htmlFor={`qs-node-${n.id}`}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={`qs-node-${n.id}`}
                  name="settings.nodeIds"
                  value={n.id}
                  defaultChecked={settings.nodeIds.includes(n.id)}
                />
                {n.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Num name="delay1Min" label={t('access.delay1')} value={settings.delay1Min} />
          <Num name="delay2Min" label={t('access.delay2')} value={settings.delay2Min} />
        </div>
      </fieldset>
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
