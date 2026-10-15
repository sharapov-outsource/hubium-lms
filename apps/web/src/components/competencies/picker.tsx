'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { ActionForm, SubmitButton } from '@/components/action-form';

export interface PickerFramework {
  id: string;
  shortName: string;
  competencies: { id: string; shortName: string; idNumber: string; depth: number }[];
}

/** Chooses competencies of a framework (searchable, as a tree) and submits their ids. */
export function CompetencyPicker({
  frameworks,
  exclude = [],
  action,
  hidden,
  label,
  submit,
  done,
}: {
  frameworks: PickerFramework[];
  /** Already there: shown ticked and fixed. */
  exclude?: string[];
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  hidden: Record<string, string>;
  label: string;
  submit: string;
  done?: string;
}) {
  const t = useTranslations('competencies');
  const id = useId();
  const [frameworkId, setFrameworkId] = useState(frameworks[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const fw = frameworks.find((f) => f.id === frameworkId);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (fw?.competencies ?? []).filter(
      (c) => !q || c.shortName.toLowerCase().includes(q) || c.idNumber.toLowerCase().includes(q),
    );
  }, [fw, query]);
  if (!frameworks.length)
    return <p className="text-sm text-muted-foreground">{t('noFrameworks')}</p>;
  return (
    <ActionForm
      action={action}
      success={done}
      onSuccess={() => setChosen([])}
      className="grid gap-3"
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="competencyIds" value={chosen.join(',')} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('framework')} htmlFor={`${id}-fw`}>
          <Select
            id={`${id}-fw`}
            value={frameworkId}
            onChange={(e) => {
              setFrameworkId(e.target.value);
              setChosen([]);
            }}
          >
            {frameworks.map((f) => (
              <option key={f.id} value={f.id}>
                {f.shortName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('search')} htmlFor={`${id}-q`}>
          <Input id={`${id}-q`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      <fieldset
        aria-label={label}
        className="grid max-h-72 gap-1 overflow-y-auto rounded-md border border-border p-2 text-sm"
      >
        {shown.map((c) => {
          const fixed = exclude.includes(c.id);
          return (
            <label
              key={c.id}
              htmlFor={`${id}-${c.id}`}
              className="flex items-start gap-2"
              style={{ paddingLeft: `${(query ? 0 : c.depth) * 1.25}rem` }}
            >
              <Checkbox
                id={`${id}-${c.id}`}
                className="mt-0.5"
                disabled={fixed}
                checked={fixed || chosen.includes(c.id)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))
                }
              />
              <span>
                {c.shortName} <span className="text-xs text-muted-foreground">{c.idNumber}</span>
              </span>
            </label>
          );
        })}
        {shown.length ? null : <span className="text-muted-foreground">{t('nothing')}</span>}
      </fieldset>
      <div>
        <SubmitButton disabled={!chosen.length}>{submit}</SubmitButton>
      </div>
    </ActionForm>
  );
}
