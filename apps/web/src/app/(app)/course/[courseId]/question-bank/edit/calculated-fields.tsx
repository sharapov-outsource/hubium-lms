'use client';

import {
  answerFormulas,
  calculate,
  calculatedVariables,
  type Dataset,
  datasetsFor,
  fillVars,
  formatAnswer,
  formulaError,
  generateItems,
  toleranceTypes,
  variantCount,
  variantVars,
} from '@hubium/questions';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Plus, RefreshCw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { FractionSelect } from './fraction-select';
import { type FieldsProps, listHelpers, nid } from './qtypes-shared';

// Calculated questions on one page, without Moodle's wizard: the answers' formulas, checked
// as they are typed; the variables they and the text use, each with its own dataset or one
// its category shares; and a preview of the answers for the first variants.

type Kind = 'CALCULATED' | 'CALCULATEDSIMPLE' | 'CALCULATEDMULTI';
type Answer = {
  formula?: string;
  text?: string;
  id?: string;
  fraction: number;
  tolerance?: number;
  toleranceType?: (typeof toleranceTypes)[number];
  format: 'decimals' | 'significant';
  length: number;
  feedback: string;
};

const blank = (name: string): Dataset => ({
  name,
  min: 1,
  max: 10,
  decimals: 1,
  distribution: 'uniform',
  items: [],
});

export function CalculatedFields(props: FieldsProps & { kind: Kind }) {
  const { data, setData, kind } = props;
  const t = useTranslations('qbank.calc');
  const tq = useTranslations('qbank');
  const tr = useTranslations();
  const { list, setItem, removeItem } = listHelpers(props);
  const answers = list<Answer>('answers');
  const multi = kind === 'CALCULATEDMULTI';
  const shareable = kind !== 'CALCULATEDSIMPLE';
  const own = list<Dataset>('datasets');
  const sharedNames = new Set(list<string>('shared'));
  const sharedSets = props.sharedDatasets ?? [];
  const text = useDeferredValue(props.text ?? '');
  const names = calculatedVariables({ type: kind, data: data as never, text });
  const [count, setCount] = useState(10);

  const datasetOf = (name: string): Dataset =>
    (sharedNames.has(name)
      ? sharedSets.find((d) => d.name === name)
      : own.find((d) => d.name === name)) ?? blank(name);
  const setDataset = (d: Dataset) => {
    if (sharedNames.has(d.name)) {
      props.setSharedDatasets?.([...sharedSets.filter((x) => x.name !== d.name), d]);
    } else {
      setData({ ...data, datasets: [...own.filter((x) => x.name !== d.name), d] });
    }
  };
  const setShared = (name: string, on: boolean) => {
    const next = new Set(sharedNames);
    if (on) next.add(name);
    else next.delete(name);
    setData({ ...data, shared: [...next] });
  };

  const sets = datasetsFor(data as never, sharedSets);
  const variants = variantCount(names, sets);
  const formulas = answerFormulas(answers);

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">{multi ? t('multiHelp') : t('help')}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
        {multi
          ? '{={a} + {b}}   {={a} * {b}}   {=sqrt({a})}'
          : '{a} + {b}   {a} * {b} / 2   sqrt({x}^2 + {y}^2)   {=round({a} / {b}, 2)}'}
      </pre>
      {multi ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label htmlFor="cm-single" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="cm-single"
              checked={data.single !== false}
              onChange={(e) => setData({ ...data, single: e.target.checked })}
            />
            {tq('single')}
          </label>
          <label htmlFor="cm-shuffle" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="cm-shuffle"
              checked={data.shuffleAnswers !== false}
              onChange={(e) => setData({ ...data, shuffleAnswers: e.target.checked })}
            />
            {tq('shuffle')}
          </label>
        </div>
      ) : null}

      <ol className="grid gap-3">
        {answers.map((a, i) => {
          const errors = (formulas[i] ?? [])
            .filter((f) => f.trim())
            .flatMap((f) => {
              const p = formulaError(f);
              return p ? [tr(p.key as never, p.values as never)] : [];
            });
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: answers have no ids of their own
              key={i}
              className="grid gap-2 rounded-lg border border-border p-3"
            >
              <div className="flex flex-wrap items-end gap-2">
                <Field
                  label={multi ? t('answerText', { n: i + 1 }) : t('formula', { n: i + 1 })}
                  htmlFor={`c-f-${i}`}
                  className="min-w-56 flex-1"
                  error={errors.length ? errors : undefined}
                >
                  <Input
                    id={`c-f-${i}`}
                    className="font-mono"
                    value={multi ? (a.text ?? '') : (a.formula ?? '')}
                    aria-invalid={errors.length > 0}
                    onChange={(e) =>
                      setItem(
                        'answers',
                        i,
                        multi ? { text: e.target.value } : { formula: e.target.value },
                      )
                    }
                  />
                </Field>
                <FractionSelect
                  label={`${tq('fraction')} ${i + 1}`}
                  value={a.fraction}
                  allowNegative={multi}
                  onChange={(fraction) => setItem('answers', i, { fraction })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${tq('remove')} ${i + 1}`}
                  disabled={answers.length <= (multi ? 2 : 1)}
                  onClick={() => removeItem('answers', i)}
                >
                  <X />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {multi ? null : (
                  <>
                    <Input
                      aria-label={t('tolerance', { n: i + 1 })}
                      type="number"
                      step="any"
                      min={0}
                      className="w-28"
                      value={a.tolerance ?? 0.01}
                      onChange={(e) =>
                        setItem('answers', i, {
                          tolerance: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                    <Select
                      aria-label={t('toleranceType', { n: i + 1 })}
                      className="w-36"
                      value={a.toleranceType ?? 'relative'}
                      onChange={(e) => setItem('answers', i, { toleranceType: e.target.value })}
                    >
                      {toleranceTypes.map((x) => (
                        <option key={x} value={x}>
                          {t(`toleranceTypes.${x}`)}
                        </option>
                      ))}
                    </Select>
                  </>
                )}
                <Select
                  aria-label={t('format', { n: i + 1 })}
                  className="w-44"
                  value={a.format}
                  onChange={(e) => setItem('answers', i, { format: e.target.value })}
                >
                  {(['decimals', 'significant'] as const).map((x) => (
                    <option key={x} value={x}>
                      {t(`formats.${x}`)}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={t('length', { n: i + 1 })}
                  type="number"
                  min={0}
                  max={9}
                  className="w-20"
                  value={a.length}
                  onChange={(e) =>
                    setItem('answers', i, {
                      length: Math.min(9, Math.max(0, Math.trunc(Number(e.target.value) || 0))),
                    })
                  }
                />
                <Input
                  aria-label={`${tq('feedback')} ${i + 1}`}
                  placeholder={tq('feedback')}
                  className="min-w-40 flex-1"
                  value={a.feedback}
                  onChange={(e) => setItem('answers', i, { feedback: e.target.value })}
                />
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          setData({
            ...data,
            answers: [
              ...answers,
              multi
                ? {
                    id: nid('a'),
                    text: '',
                    fraction: 0,
                    feedback: '',
                    format: 'decimals',
                    length: 2,
                  }
                : {
                    formula: '',
                    fraction: 0,
                    tolerance: 0.01,
                    toleranceType: 'relative',
                    format: 'decimals',
                    length: 2,
                    feedback: '',
                  },
            ],
          })
        }
      >
        <Plus />
        {tq('addAnswer')}
      </Button>

      <fieldset className="grid gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t('variables')}</legend>
        {names.length ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t('count')} htmlFor="c-count" className="w-28">
                <Input
                  id="c-count"
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  let nextData = data;
                  let nextShared = sharedSets;
                  for (const n of names) {
                    const d = datasetOf(n);
                    const items = generateItems(d, count, Math.floor(Math.random() * 2 ** 31));
                    if (sharedNames.has(n))
                      nextShared = [...nextShared.filter((x) => x.name !== n), { ...d, items }];
                    else
                      nextData = {
                        ...nextData,
                        datasets: [
                          ...((nextData.datasets as Dataset[]) ?? []).filter((x) => x.name !== n),
                          { ...d, items },
                        ],
                      };
                  }
                  setData(nextData);
                  if (nextShared !== sharedSets) props.setSharedDatasets?.(nextShared);
                }}
              >
                <RefreshCw />
                {t('generate', { n: count })}
              </Button>
              {shareable && sharedNames.size ? (
                <label htmlFor="c-sync" className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="c-sync"
                    checked={!!data.synchronize}
                    onChange={(e) => setData({ ...data, synchronize: e.target.checked })}
                  />
                  {t('synchronize')}
                </label>
              ) : null}
            </div>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('variable')}</Th>
                  {shareable ? <Th>{t('shared')}</Th> : null}
                  <Th>{t('min')}</Th>
                  <Th>{t('max')}</Th>
                  <Th>{t('decimals')}</Th>
                  <Th>{t('distribution')}</Th>
                  <Th>{t('items')}</Th>
                </Tr>
              </THead>
              <TBody>
                {names.map((n) => {
                  const d = datasetOf(n);
                  const num = (k: 'min' | 'max' | 'decimals') => (
                    <Input
                      aria-label={`${t(k)} {${n}}`}
                      type="number"
                      step={k === 'decimals' ? 1 : 'any'}
                      min={k === 'decimals' ? 0 : undefined}
                      max={k === 'decimals' ? 10 : undefined}
                      className="w-24"
                      value={d[k]}
                      onChange={(e) => {
                        const v = Number(e.target.value) || 0;
                        setDataset({
                          ...d,
                          [k]: k === 'decimals' ? Math.min(10, Math.max(0, Math.trunc(v))) : v,
                        });
                      }}
                    />
                  );
                  return (
                    <Tr key={n}>
                      <Td className="font-mono">{`{${n}}`}</Td>
                      {shareable ? (
                        <Td>
                          <Checkbox
                            aria-label={`${t('shared')} {${n}}`}
                            checked={sharedNames.has(n)}
                            onChange={(e) => setShared(n, e.target.checked)}
                          />
                        </Td>
                      ) : null}
                      <Td>{num('min')}</Td>
                      <Td>{num('max')}</Td>
                      <Td>{num('decimals')}</Td>
                      <Td>
                        <Select
                          aria-label={`${t('distribution')} {${n}}`}
                          className="w-36"
                          value={d.distribution}
                          onChange={(e) =>
                            setDataset({
                              ...d,
                              distribution: e.target.value as Dataset['distribution'],
                            })
                          }
                        >
                          {(['uniform', 'loguniform'] as const).map((x) => (
                            <option key={x} value={x}>
                              {t(`distributions.${x}`)}
                            </option>
                          ))}
                        </Select>
                      </Td>
                      <Td className="tabular-nums">{d.items.length}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noVariables')}</p>
        )}
      </fieldset>

      <div className="grid gap-2" aria-live="polite">
        <p className="text-sm font-medium">{t('preview', { n: names.length ? variants : 0 })}</p>
        {names.length && variants > 0 ? (
          <Table>
            <THead>
              <Tr>
                <Th>{t('variant')}</Th>
                {names.map((n) => (
                  <Th key={n} className="font-mono">{`{${n}}`}</Th>
                ))}
                {answers.map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: answer columns
                  <Th key={i}>{t('answerN', { n: i + 1 })}</Th>
                ))}
              </Tr>
            </THead>
            <TBody>
              {Array.from({ length: Math.min(variants, 10) }, (_, v) => {
                const vars = variantVars(names, sets, v);
                return (
                  <Tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: a variant is its number
                    key={v}
                  >
                    <Td className="tabular-nums">{v + 1}</Td>
                    {names.map((n) => (
                      <Td key={n} className="tabular-nums">
                        {vars[n]}
                      </Td>
                    ))}
                    {answers.map((a, i) => {
                      let shown: string;
                      let bad = false;
                      try {
                        shown = multi
                          ? fillVars(a.text ?? '', vars, a)
                          : formatAnswer(calculate(a.formula ?? '', vars), a);
                      } catch {
                        shown = t('notANumber');
                        bad = true;
                      }
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: answer columns
                        <Td key={i} className={cn('tabular-nums', bad && 'text-destructive')}>
                          {shown}
                        </Td>
                      );
                    })}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noVariants')}</p>
        )}
      </div>
    </div>
  );
}

export const calculatedDefaults = (kind: Kind) => () =>
  kind === 'CALCULATEDMULTI'
    ? {
        single: true,
        shuffleAnswers: true,
        answers: [
          {
            id: nid('a'),
            text: '{={a}+{b}}',
            fraction: 1,
            feedback: '',
            format: 'decimals',
            length: 2,
          },
          {
            id: nid('a'),
            text: '{={a}*{b}}',
            fraction: 0,
            feedback: '',
            format: 'decimals',
            length: 2,
          },
        ],
        datasets: [],
        shared: [],
        synchronize: false,
      }
    : {
        answers: [
          {
            formula: '',
            fraction: 1,
            tolerance: 0.01,
            toleranceType: 'relative',
            format: 'decimals',
            length: 2,
            feedback: '',
          },
        ],
        datasets: [],
        ...(kind === 'CALCULATED' ? { shared: [], synchronize: false } : {}),
      };
