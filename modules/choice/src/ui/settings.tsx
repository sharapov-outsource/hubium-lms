'use client';

import { DateTimeInput, useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { ChoiceSettingsT } from '../server.ts';

type Flag = 'allowMultiple' | 'allowUpdate' | 'limitAnswers' | 'showUnanswered' | 'showPreview';

export function ChoiceSettingsFields({ settings }: SettingsFieldsProps<ChoiceSettingsT>) {
  const t = useTranslations('mod.choice');
  const tc = useTranslations('common');
  // new options get their ids when saved; `key` only tells the rows apart here
  const [options, setOptions] = useState(() =>
    (settings.options.length
      ? settings.options.map((o) => ({ id: o.id, text: o.text, limit: o.limit }))
      : [
          { text: '', limit: 0 },
          { text: '', limit: 0 },
        ]
    ).map((o, key) => ({ ...o, key })),
  );
  const nextKey = useRef(options.length);
  const [limited, setLimited] = useState(settings.limitAnswers);
  const optionsError = useFieldErrors('settings.options');
  const closesError = useFieldErrors('settings.closesAt');
  const set = (i: number, patch: Partial<(typeof options)[number]>) =>
    setOptions((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const flag = (name: Flag, onChange?: (on: boolean) => void) => (
    <label htmlFor={`ch-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox
        id={`ch-${name}`}
        name={`settings.${name}`}
        defaultChecked={settings[name]}
        onChange={(e) => onChange?.(e.currentTarget.checked)}
      />
      {t(name)}
    </label>
  );
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('options')}</legend>
        <input
          type="hidden"
          name="settings.options"
          value={JSON.stringify(options.map(({ key: _, ...o }) => o))}
        />
        {options.map((o, i) => (
          <div key={o.key} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('optionN', { n: i + 1 })}
              value={o.text}
              maxLength={255}
              onChange={(e) => set(i, { text: e.target.value })}
              className="min-w-0 flex-1"
            />
            {limited ? (
              <Input
                aria-label={t('limitN', { n: i + 1 })}
                type="number"
                min={0}
                value={o.limit}
                onChange={(e) => set(i, { limit: Number(e.target.value) || 0 })}
                className="w-24"
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${tc('delete')}: ${t('optionN', { n: i + 1 })}`}
              disabled={options.length <= 1}
              onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {optionsError ? (
          <p className="text-xs text-destructive">{optionsError.join(', ')}</p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() =>
            setOptions((list) => [...list, { key: nextKey.current++, text: '', limit: 0 }])
          }
        >
          <Plus className="size-4" aria-hidden />
          {t('addOption')}
        </Button>
        {limited ? <p className="text-xs text-muted-foreground">{t('limitHint')}</p> : null}
      </fieldset>
      <div className="grid gap-2">
        {flag('allowMultiple')}
        {flag('allowUpdate')}
        {flag('limitAnswers', setLimited)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('opensAt')} htmlFor="ch-opensAt">
          <DateTimeInput id="ch-opensAt" name="settings.opensAt" defaultValue={settings.opensAt} />
        </Field>
        <Field label={t('closesAt')} htmlFor="ch-closesAt" error={closesError}>
          <DateTimeInput
            id="ch-closesAt"
            name="settings.closesAt"
            defaultValue={settings.closesAt}
            ariaInvalid={!!closesError}
          />
        </Field>
      </div>
      {flag('showPreview')}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('showResults')} htmlFor="ch-showResults">
          <Select
            id="ch-showResults"
            name="settings.showResults"
            defaultValue={settings.showResults}
          >
            {(['afterAnswer', 'afterClose', 'always', 'never'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`showResultsOptions.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('publish')} htmlFor="ch-publish">
          <Select id="ch-publish" name="settings.publish" defaultValue={settings.publish}>
            <option value="anonymous">{t('publishOptions.anonymous')}</option>
            <option value="names">{t('publishOptions.names')}</option>
          </Select>
        </Field>
      </div>
      {flag('showUnanswered')}
    </div>
  );
}

export function ChoiceCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.choice');
  return (
    <label htmlFor="chc-submitted" className="flex items-center gap-2 text-sm">
      <Checkbox id="chc-submitted" name="completion.submitted" defaultChecked={!!rules.submitted} />
      {t('completionSubmitted')}
    </label>
  );
}
