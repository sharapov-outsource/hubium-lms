'use client';

import { orderingGradings, orderingNumberings } from '@hubium/questions';
import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FieldsProps, listHelpers, nid } from './qtypes-shared';

// Editors of the ordering and gap types (Moodle's ordering, select missing words and drag
// and drop into text), with the feedback for right, partly right and wrong responses.

function CombinedFeedbackFields({ data, setData }: FieldsProps) {
  const t = useTranslations('qbank.combined');
  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">{t('title')}</legend>
      {(['feedbackCorrect', 'feedbackPartial', 'feedbackIncorrect'] as const).map((k) => (
        <Field key={k} label={t(k)} htmlFor={`cf-${k}`}>
          <Input
            id={`cf-${k}`}
            value={String(data[k] ?? '')}
            onChange={(e) => setData({ ...data, [k]: e.target.value })}
          />
        </Field>
      ))}
    </fieldset>
  );
}

export function OrderingFields(props: FieldsProps) {
  const { data, setData } = props;
  const t = useTranslations('qbank.ordering');
  const tq = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  const items = list<{ id: string; text: string }>('items');
  const move = (i: number, to: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(to, 0, x!);
    setData({ ...data, items: next });
  };
  const select = String(data.select ?? 'all');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('itemsHint')}</p>
      <ol className="grid gap-2">
        {items.map((item, i) => (
          <li key={item.id} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {i + 1}.
            </span>
            <Input
              aria-label={t('item', { n: i + 1 })}
              value={item.text}
              onChange={(e) => setItem('items', i, { text: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('up', { n: i + 1 })}
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('down', { n: i + 1 })}
              disabled={i === items.length - 1}
              onClick={() => move(i, i + 1)}
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${tq('remove')} ${i + 1}`}
              disabled={items.length <= 2}
              onClick={() => removeItem('items', i)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setData({ ...data, items: [...items, { id: nid('i'), text: '' }] })}
      >
        <Plus />
        {t('addItem')}
      </Button>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('grading')}
          htmlFor="o-grading"
          hint={t(`gradingHints.${String(data.grading)}` as 'gradingHints.absolutePosition')}
        >
          <Select
            id="o-grading"
            value={String(data.grading)}
            onChange={(e) => setData({ ...data, grading: e.target.value })}
          >
            {orderingGradings.map((g) => (
              <option key={g} value={g}>
                {t(`gradings.${g}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('select')} htmlFor="o-select">
          <Select
            id="o-select"
            value={select}
            onChange={(e) => setData({ ...data, select: e.target.value })}
          >
            {(['all', 'random', 'contiguous'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`selects.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
        {select === 'all' ? null : (
          <Field label={t('selectCount')} htmlFor="o-count">
            <Input
              id="o-count"
              type="number"
              min={2}
              max={items.length}
              value={Number(data.selectCount ?? 6)}
              onChange={(e) =>
                setData({ ...data, selectCount: Math.max(2, Number(e.target.value) || 2) })
              }
            />
          </Field>
        )}
        <Field label={t('layout')} htmlFor="o-layout">
          <Select
            id="o-layout"
            value={String(data.layout ?? 'vertical')}
            onChange={(e) => setData({ ...data, layout: e.target.value })}
          >
            {(['vertical', 'horizontal'] as const).map((l) => (
              <option key={l} value={l}>
                {t(`layouts.${l}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('numbering')} htmlFor="o-numbering">
          <Select
            id="o-numbering"
            value={String(data.numbering ?? 'none')}
            onChange={(e) => setData({ ...data, numbering: e.target.value })}
          >
            {orderingNumberings.map((n) => (
              <option key={n} value={n}>
                {n === 'none'
                  ? t('noNumbering')
                  : n === 'IIII'
                    ? 'I, II, III'
                    : n === 'iii'
                      ? 'i, ii, iii'
                      : n === 'ABCD'
                        ? 'A, B, C'
                        : n === 'abc'
                          ? 'a, b, c'
                          : '1, 2, 3'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label htmlFor="o-show" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="o-show"
          checked={data.showGrading !== false}
          onChange={(e) => setData({ ...data, showGrading: e.target.checked })}
        />
        {t('showGrading')}
      </label>
      <CombinedFeedbackFields {...props} />
    </div>
  );
}

export function GapFields(props: FieldsProps & { drag: boolean }) {
  const { data, setData, drag } = props;
  const t = useTranslations('qbank.gaps');
  const tq = useTranslations('qbank');
  const { list, setItem, removeItem } = listHelpers(props);
  const choices = list<{ id: string; text: string; group: number; infinite?: boolean }>('choices');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <ol className="grid gap-2">
        {choices.map((c, i) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <span className="w-12 shrink-0 font-mono text-sm text-muted-foreground">
              [[{i + 1}]]
            </span>
            <Input
              aria-label={t('choice', { n: i + 1 })}
              className="min-w-40 flex-1"
              value={c.text}
              onChange={(e) => setItem('choices', i, { text: e.target.value })}
            />
            <Select
              aria-label={t('group', { n: i + 1 })}
              className="w-28"
              value={String(c.group ?? 1)}
              onChange={(e) => setItem('choices', i, { group: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
                <option key={g} value={String(g)}>
                  {t('groupN', { n: g })}
                </option>
              ))}
            </Select>
            {drag ? (
              <label htmlFor={`g-inf-${c.id}`} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  id={`g-inf-${c.id}`}
                  checked={!!c.infinite}
                  onChange={(e) => setItem('choices', i, { infinite: e.target.checked })}
                />
                {t('infinite')}
              </label>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${tq('remove')} ${i + 1}`}
              disabled={choices.length <= 2}
              onClick={() => removeItem('choices', i)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            choices: [
              ...choices,
              { id: nid('c'), text: '', group: 1, ...(drag ? { infinite: false } : {}) },
            ],
          })
        }
      >
        <Plus />
        {t('addChoice')}
      </Button>
      <label htmlFor="g-shuffle" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="g-shuffle"
          checked={data.shuffle !== false}
          onChange={(e) => setData({ ...data, shuffle: e.target.checked })}
        />
        {tq('shuffle')}
      </label>
      <CombinedFeedbackFields {...props} />
    </div>
  );
}

const combinedDefaults = { feedbackCorrect: '', feedbackPartial: '', feedbackIncorrect: '' };

export const orderingDefaults = () => ({
  items: [1, 2, 3].map(() => ({ id: nid('i'), text: '' })),
  grading: 'relativeNextExcludeLast',
  select: 'all',
  selectCount: 6,
  layout: 'vertical',
  numbering: 'none',
  showGrading: true,
  ...combinedDefaults,
});

export const gapDefaults = (drag: boolean) => () => ({
  shuffle: true,
  choices: [1, 2].map(() => ({
    id: nid('c'),
    text: '',
    group: 1,
    ...(drag ? { infinite: false } : {}),
  })),
  ...combinedDefaults,
});
