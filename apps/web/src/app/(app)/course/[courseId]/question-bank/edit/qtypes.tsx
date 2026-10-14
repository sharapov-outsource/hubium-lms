'use client';

import type { QuestionType } from '@hubium/questions';
import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import { ClozeFields } from './cloze-fields';
import { GapFields, gapDefaults, OrderingFields, orderingDefaults } from './qtypes-order-gaps';
import { type Data, type FieldsProps, listHelpers, nid } from './qtypes-shared';

// The answer fields of each question type in the question editor: its defaults for a new
// question and its form. The table is complete by type, so a new question type does not
// build until it has an editor here.

export type { Data, FieldsProps } from './qtypes-shared';

const FRACTIONS: [string, string][] = [
  ['1', 'p100'],
  ['0.5', 'p50'],
  ['0.3333333', 'p33'],
  ['0.25', 'p25'],
  ['0.2', 'p20'],
  ['0', 'p0'],
  ['-0.5', 'm50'],
  ['-1', 'm100'],
];
export function FractionSelect({
  value,
  onChange,
  label,
  allowNegative,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  allowNegative?: boolean;
}) {
  const t = useTranslations('qbank');
  return (
    <Select
      aria-label={label}
      className="w-24"
      value={FRACTIONS.find(([f]) => Math.abs(Number(f) - value) < 1e-6)?.[0] ?? String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {FRACTIONS.filter(([f]) => allowNegative || Number(f) >= 0).map(([f, key]) => (
        <option key={f} value={f}>
          {t(`fractions.${key}` as 'fractions.p100')}
        </option>
      ))}
    </Select>
  );
}

function MultichoiceFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  return (
    <div className="grid gap-3">
      <label htmlFor="mc-single" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="mc-single"
          checked={!!data.single}
          onChange={(e) => setData({ ...data, single: e.target.checked })}
        />
        {t('single')}
      </label>
      <label htmlFor="mc-shuffle" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="mc-shuffle"
          checked={!!data.shuffleAnswers}
          onChange={(e) => setData({ ...data, shuffleAnswers: e.target.checked })}
        />
        {t('shuffle')}
      </label>
      {list<{ id: string; text: string; fraction: number; feedback: string }>('answers').map(
        (a, i) => (
          <div
            key={a.id}
            className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_6rem_auto]"
          >
            <Input
              aria-label={`${t('answer')} ${i + 1}`}
              placeholder={`${t('answer')} ${i + 1}`}
              value={a.text}
              onChange={(e) => setItem('answers', i, { text: e.target.value })}
            />
            <FractionSelect
              label={`${t('fraction')} ${i + 1}`}
              value={a.fraction}
              onChange={(v) => setItem('answers', i, { fraction: v })}
              allowNegative={!data.single}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remove')}
              onClick={() => removeItem('answers', i)}
            >
              <X />
            </Button>
            <Input
              aria-label={`${t('feedback')} ${i + 1}`}
              placeholder={t('feedback')}
              className="sm:col-span-3"
              value={a.feedback}
              onChange={(e) => setItem('answers', i, { feedback: e.target.value })}
            />
          </div>
        ),
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            answers: [...list('answers'), { id: nid('a'), text: '', fraction: 0, feedback: '' }],
          })
        }
      >
        <Plus />
        {t('addAnswer')}
      </Button>
    </div>
  );
}

function TrueFalseFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  return (
    <fieldset className="flex gap-4">
      <legend className="mb-2 text-sm font-medium">{t('correctIs')}</legend>
      {[true, false].map((b) => (
        <label key={String(b)} htmlFor={`tf-${b}`} className="flex items-center gap-2 text-sm">
          <input
            id={`tf-${b}`}
            type="radio"
            name="tf-correct"
            checked={data.correct === b}
            onChange={() => setData({ ...data, correct: b })}
          />
          {b ? t('true') : t('false')}
        </label>
      ))}
    </fieldset>
  );
}

function ShortAnswerFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  return (
    <div className="grid gap-3">
      <label htmlFor="sa-case" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="sa-case"
          checked={!!data.caseSensitive}
          onChange={(e) => setData({ ...data, caseSensitive: e.target.checked })}
        />
        {t('caseSensitive')}
      </label>
      {list<{ text: string; fraction: number }>('answers').map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: answers have no ids
        <div key={i} className="flex flex-wrap gap-2">
          <Input
            aria-label={`${t('answer')} ${i + 1}`}
            placeholder={`${t('answer')} (*)`}
            className="min-w-48 flex-1"
            value={a.text}
            onChange={(e) => setItem('answers', i, { text: e.target.value })}
          />
          <FractionSelect
            label={`${t('fraction')} ${i + 1}`}
            value={a.fraction}
            onChange={(v) => setItem('answers', i, { fraction: v })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove')}
            onClick={() => removeItem('answers', i)}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            answers: [...list('answers'), { text: '', fraction: 1, feedback: '' }],
          })
        }
      >
        <Plus />
        {t('addAnswer')}
      </Button>
    </div>
  );
}

function NumericalFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  return (
    <div className="grid gap-3">
      {list<{ value: number; tolerance: number; fraction: number }>('answers').map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: answers have no ids
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Field label={t('value')} htmlFor={`nv-${i}`}>
            <Input
              id={`nv-${i}`}
              inputMode="decimal"
              className="w-32"
              defaultValue={a.value}
              onChange={(e) =>
                setItem('answers', i, { value: Number(e.target.value.replace(',', '.')) })
              }
            />
          </Field>
          <Field label={t('tolerance')} htmlFor={`nt-${i}`}>
            <Input
              id={`nt-${i}`}
              inputMode="decimal"
              className="w-28"
              defaultValue={a.tolerance}
              onChange={(e) =>
                setItem('answers', i, { tolerance: Number(e.target.value.replace(',', '.')) })
              }
            />
          </Field>
          <FractionSelect
            label={`${t('fraction')} ${i + 1}`}
            value={a.fraction}
            onChange={(v) => setItem('answers', i, { fraction: v })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove')}
            onClick={() => removeItem('answers', i)}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            answers: [...list('answers'), { value: 0, tolerance: 0, fraction: 1, feedback: '' }],
          })
        }
      >
        <Plus />
        {t('addAnswer')}
      </Button>
    </div>
  );
}

function MatchFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  return (
    <div className="grid gap-3">
      {list<{ id: string; question: string; answer: string }>('pairs').map((p, i) => (
        <div key={p.id} className="flex flex-wrap gap-2">
          <Input
            aria-label={`${t('pairQuestion')} ${i + 1}`}
            placeholder={t('pairQuestion')}
            className="min-w-40 flex-1"
            value={p.question}
            onChange={(e) => setItem('pairs', i, { question: e.target.value })}
          />
          <Input
            aria-label={`${t('pairAnswer')} ${i + 1}`}
            placeholder={t('pairAnswer')}
            className="min-w-40 flex-1"
            value={p.answer}
            onChange={(e) => setItem('pairs', i, { answer: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove')}
            onClick={() => removeItem('pairs', i)}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            pairs: [...list('pairs'), { id: nid('p'), question: '', answer: '' }],
          })
        }
      >
        <Plus />
        {t('addPair')}
      </Button>
      <Field label={t('distractors')} htmlFor="m-distr">
        <Input
          id="m-distr"
          defaultValue={list<string>('distractors').join(', ')}
          onChange={(e) =>
            setData({
              ...data,
              distractors: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
    </div>
  );
}

function EssayFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('minWords')} htmlFor="e-min">
        <Input
          id="e-min"
          type="number"
          min={0}
          defaultValue={Number(data.minWords ?? 0)}
          onChange={(e) => setData({ ...data, minWords: Number(e.target.value) || 0 })}
        />
      </Field>
      <Field label={t('maxWords')} htmlFor="e-max">
        <Input
          id="e-max"
          type="number"
          min={0}
          defaultValue={Number(data.maxWords ?? 0)}
          onChange={(e) => setData({ ...data, maxWords: Number(e.target.value) || 0 })}
        />
      </Field>
      <Field label={t('graderInfo')} htmlFor="e-info" className="sm:col-span-2">
        <Input
          id="e-info"
          defaultValue={String(data.graderInfo ?? '')}
          onChange={(e) => setData({ ...data, graderInfo: e.target.value })}
        />
      </Field>
    </div>
  );
}

export interface EditorPart {
  /** Data of a new question of this type. */
  defaults: () => Data;
  /** The answer fields; null for types without answers. */
  Fields: ComponentType<FieldsProps> | null;
}

export const editorParts = {
  MULTICHOICE: {
    defaults: () => ({
      single: true,
      shuffleAnswers: true,
      answers: [
        { id: nid('a'), text: '', fraction: 1, feedback: '' },
        { id: nid('a'), text: '', fraction: 0, feedback: '' },
      ],
    }),
    Fields: MultichoiceFields,
  },
  TRUEFALSE: {
    defaults: () => ({ correct: true, feedbackTrue: '', feedbackFalse: '' }),
    Fields: TrueFalseFields,
  },
  SHORTANSWER: {
    defaults: () => ({ caseSensitive: false, answers: [{ text: '', fraction: 1, feedback: '' }] }),
    Fields: ShortAnswerFields,
  },
  NUMERICAL: {
    defaults: () => ({ answers: [{ value: 0, tolerance: 0, fraction: 1, feedback: '' }] }),
    Fields: NumericalFields,
  },
  MATCH: {
    defaults: () => ({
      shuffle: true,
      pairs: [
        { id: nid('p'), question: '', answer: '' },
        { id: nid('p'), question: '', answer: '' },
      ],
      distractors: [],
    }),
    Fields: MatchFields,
  },
  ESSAY: { defaults: () => ({ minWords: 0, maxWords: 0, graderInfo: '' }), Fields: EssayFields },
  DESCRIPTION: { defaults: () => ({}), Fields: null },
  ORDERING: { defaults: orderingDefaults, Fields: OrderingFields },
  GAPSELECT: { defaults: gapDefaults(false), Fields: (p) => <GapFields {...p} drag={false} /> },
  DDWTOS: { defaults: gapDefaults(true), Fields: (p) => <GapFields {...p} drag /> },
  // the answers are read from the text when the question is saved
  MULTIANSWER: { defaults: () => ({ parts: [] }), Fields: ClozeFields },
} satisfies Record<QuestionType, EditorPart>;
