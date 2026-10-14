'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import type { QuestionType } from '@hubium/questions';
import { Input, Label, Select } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import type { BodyProps } from './body.ts';
import { DragText, GapSelect } from './gaps.tsx';
import { Ordering } from './ordering.tsx';

// How each question type is answered in an attempt. The table is complete by type, so a
// new question type does not build until it has a body here.

export type { BodyProps } from './body.ts';

function Multichoice({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const name = `q${q.slot}`;
  const selected = new Set((value.selected as string[]) ?? []);
  return (
    <fieldset className="grid gap-2">
      <legend className="sr-only">{t('yourAnswer')}</legend>
      {q.options?.map((o) => (
        <label
          key={o.id}
          htmlFor={`${name}-${o.id}`}
          className={cn(
            'flex items-start gap-3 rounded-lg border border-border p-3 text-sm',
            readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
            selected.has(o.id) && 'border-accent bg-accent-soft',
          )}
        >
          <input
            id={`${name}-${o.id}`}
            type={q.multiple ? 'checkbox' : 'radio'}
            name={name}
            checked={selected.has(o.id)}
            disabled={readOnly}
            className="mt-0.5"
            onChange={(e) => {
              if (!q.multiple) return onChange({ selected: [o.id] });
              const next = new Set(selected);
              if (e.target.checked) next.add(o.id);
              else next.delete(o.id);
              onChange({ selected: [...next] });
            }}
          />
          <span>{o.text}</span>
        </label>
      ))}
    </fieldset>
  );
}

function TrueFalse({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const name = `q${q.slot}`;
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{t('yourAnswer')}</legend>
      {[true, false].map((b) => (
        <label
          key={String(b)}
          htmlFor={`${name}-${b}`}
          className={cn(
            'flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm',
            readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
            value.value === b && 'border-accent bg-accent-soft',
          )}
        >
          <input
            id={`${name}-${b}`}
            type="radio"
            name={name}
            checked={value.value === b}
            disabled={readOnly}
            onChange={() => onChange({ value: b })}
          />
          {b ? t('trueLabel') : t('falseLabel')}
        </label>
      ))}
    </fieldset>
  );
}

function TextAnswer({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const name = `q${q.slot}`;
  return (
    <div className="grid max-w-sm gap-1.5">
      <Label htmlFor={name}>{t('yourAnswer')}</Label>
      <Input
        id={name}
        inputMode={q.type === 'NUMERICAL' ? 'decimal' : 'text'}
        value={(value.text as string) ?? ''}
        readOnly={readOnly}
        autoComplete="off"
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}

function Match({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const name = `q${q.slot}`;
  const choices = (value.choices as Record<string, string>) ?? {};
  return (
    <div className="grid gap-2">
      {q.matchRows?.map((row) => (
        <div key={row.id} className="grid items-center gap-2 sm:grid-cols-[1fr_16rem]">
          <Label htmlFor={`${name}-${row.id}`} className="font-normal">
            {row.text}
          </Label>
          <Select
            id={`${name}-${row.id}`}
            value={choices[row.id] ?? ''}
            disabled={readOnly}
            onChange={(e) => onChange({ choices: { ...choices, [row.id]: e.target.value } })}
          >
            <option value="">{t('choose')}</option>
            {q.matchChoices?.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  );
}

// essays are graded by hand, never checked during the attempt: always editable
function Essay({ q, value, onChange }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const labels = useEditorLabels();
  const name = `q${q.slot}`;
  return (
    <RichTextEditor
      id={name}
      name={name}
      defaultValue={(value.text as string) ?? ''}
      labels={labels}
      ariaLabel={t('yourAnswer')}
      minHeight={180}
      onChangeHtml={(html) => onChange({ text: html })}
    />
  );
}

const Nothing = () => null;

export const questionBodies = {
  MULTICHOICE: Multichoice,
  TRUEFALSE: TrueFalse,
  SHORTANSWER: TextAnswer,
  NUMERICAL: TextAnswer,
  MATCH: Match,
  ESSAY: Essay,
  DESCRIPTION: Nothing,
  ORDERING: Ordering,
  GAPSELECT: GapSelect,
  DDWTOS: DragText,
} satisfies Record<QuestionType, ComponentType<BodyProps>>;

/** Types whose body shows the question text itself (with its gaps). */
export const bodyShowsText = (type: QuestionType) => type === 'GAPSELECT' || type === 'DDWTOS';
