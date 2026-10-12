'use client';

import { EditorField } from '@hubium/editor/field';
import type { QuestionType } from '@hubium/questions';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
} from '@hubium/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ActionForm,
  FormField,
  SubmitButton,
  useFieldError,
  useFormErrors,
} from '@/components/action-form';
import { saveQuestionAction } from '@/server/actions/grades';

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
let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

type Data = Record<string, unknown>;

function defaults(type: QuestionType): Data {
  switch (type) {
    case 'MULTICHOICE':
      return {
        single: true,
        shuffleAnswers: true,
        answers: [
          { id: nid('a'), text: '', fraction: 1, feedback: '' },
          { id: nid('a'), text: '', fraction: 0, feedback: '' },
        ],
      };
    case 'TRUEFALSE':
      return { correct: true, feedbackTrue: '', feedbackFalse: '' };
    case 'SHORTANSWER':
      return { caseSensitive: false, answers: [{ text: '', fraction: 1, feedback: '' }] };
    case 'NUMERICAL':
      return { answers: [{ value: 0, tolerance: 0, fraction: 1, feedback: '' }] };
    case 'MATCH':
      return {
        shuffle: true,
        pairs: [
          { id: nid('p'), question: '', answer: '' },
          { id: nid('p'), question: '', answer: '' },
        ],
        distractors: [],
      };
    case 'ESSAY':
      return { minWords: 0, maxWords: 0, graderInfo: '' };
    default:
      return {};
  }
}

function FractionSelect({
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

function TypeFields({
  type,
  data,
  setData,
}: {
  type: QuestionType;
  data: Data;
  setData: (d: Data) => void;
}) {
  const t = useTranslations('qbank');
  const list = <T,>(key: string) => (data[key] as T[]) ?? [];
  const setItem = (key: string, i: number, patch: Data) =>
    setData({ ...data, [key]: list<Data>(key).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const removeItem = (key: string, i: number) =>
    setData({ ...data, [key]: list<Data>(key).filter((_, j) => j !== i) });
  switch (type) {
    case 'MULTICHOICE':
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
                answers: [
                  ...list('answers'),
                  { id: nid('a'), text: '', fraction: 0, feedback: '' },
                ],
              })
            }
          >
            <Plus />
            {t('addAnswer')}
          </Button>
        </div>
      );
    case 'TRUEFALSE':
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
                className="size-4 accent-[var(--accent)]"
              />
              {b ? 'True / Верно' : 'False / Неверно'}
            </label>
          ))}
        </fieldset>
      );
    case 'SHORTANSWER':
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
    case 'NUMERICAL':
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
                answers: [
                  ...list('answers'),
                  { value: 0, tolerance: 0, fraction: 1, feedback: '' },
                ],
              })
            }
          >
            <Plus />
            {t('addAnswer')}
          </Button>
        </div>
      );
    case 'MATCH':
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
    case 'ESSAY':
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
    default:
      return null;
  }
}

function DataErrors() {
  const errors = useFormErrors();
  const all = Object.entries(errors)
    .filter(([k]) => k === 'data' || k.startsWith('data.'))
    .map(([k, v]) => `${k.replace(/^data\.?/, '')} ${v.join(', ')}`.trim());
  return all.length ? (
    <p className="text-xs text-destructive" role="alert">
      {all.join('; ')}
    </p>
  ) : null;
}

export function QuestionEditor({
  courseId,
  type,
  categories,
  initial,
}: {
  courseId: string;
  type: QuestionType;
  categories: { id: string; name: string }[];
  initial: {
    id?: string;
    categoryId: string;
    name: string;
    text: string;
    generalFeedback: string;
    defaultMark: number;
    status: string;
    data: Data | null;
  };
}) {
  const t = useTranslations('qbank');
  const tc = useTranslations('common');
  const [data, setData] = useState<Data>(initial.data ?? defaults(type));
  return (
    <ActionForm action={saveQuestionAction} success={t('saved')} className="grid max-w-3xl gap-5">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="type" value={type} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="data" value={JSON.stringify(data)} />
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="categoryId" label={t('category')}>
              <Select id="f-categoryId" name="categoryId" defaultValue={initial.categoryId}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField name="status" label={t('status')}>
              <Select id="f-status" name="status" defaultValue={initial.status}>
                {(['READY', 'DRAFT', 'HIDDEN'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`statuses.${s}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField name="name" label={t('name')} defaultValue={initial.name} required />
          <TextField
            name="text"
            label={t('text')}
            defaultValue={initial.text}
            courseId={courseId}
          />
          {type !== 'DESCRIPTION' ? (
            <FormField
              name="defaultMark"
              type="number"
              step="any"
              min={0}
              label={t('defaultMark')}
              defaultValue={initial.defaultMark}
              className="w-40"
            />
          ) : null}
        </CardContent>
      </Card>
      {type !== 'DESCRIPTION' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('answers')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <TypeFields type={type} data={data} setData={setData} />
            <DataErrors />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="pt-5">
          <TextField
            name="generalFeedback"
            label={t('generalFeedback')}
            defaultValue={initial.generalFeedback}
            courseId={courseId}
            small
          />
        </CardContent>
      </Card>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function TextField({
  name,
  label,
  defaultValue,
  courseId,
  small,
}: {
  name: string;
  label: string;
  defaultValue: string;
  courseId: string;
  small?: boolean;
}) {
  const error = useFieldError(name);
  return (
    <EditorField
      name={name}
      label={label}
      defaultValue={defaultValue}
      courseId={courseId}
      error={error}
      minHeight={small ? 80 : 140}
    />
  );
}
