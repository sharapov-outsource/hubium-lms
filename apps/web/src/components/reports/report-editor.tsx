'use client';

import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { saveReportAction } from '@/server/actions/reports';
import { moveColumn, type ReportSort } from './columns';

type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum';

export interface EditorField {
  key: string;
  type: FieldType;
  label: string;
  options: readonly string[];
}

interface Column {
  field: string;
  aggregate?: string;
  label?: string;
}
interface Condition {
  field: string;
  op: string;
  value?: string | string[];
}
/** A row of the editor: what is saved, and a key for React. */
type Row<T> = T & { uid: number };

let uid = 0;
const withUid = <T,>(x: T): Row<T> => ({ ...x, uid: ++uid });
const strip = <T,>({ uid: _, ...rest }: Row<T>) => rest;

const AGGREGATES: Record<FieldType, string[]> = {
  text: ['count', 'countDistinct', 'list'],
  number: ['sum', 'avg', 'min', 'max', 'count'],
  date: ['min', 'max', 'count'],
  boolean: ['countTrue', 'count'],
  enum: ['count', 'countDistinct', 'list'],
};
const OPERATORS: Record<FieldType, string[]> = {
  text: ['contains', 'notContains', 'equals', 'startsWith', 'empty', 'notEmpty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'],
  date: ['after', 'before', 'lastDays', 'nextDays', 'empty', 'notEmpty'],
  boolean: ['isTrue', 'isFalse'],
  enum: ['in', 'notIn'],
};
const NO_VALUE = ['empty', 'notEmpty', 'isTrue', 'isFalse'];

function DefinitionError() {
  const error = useFieldError('columns');
  return error?.length ? (
    <p role="alert" className="text-sm text-destructive">
      {error.join(' ')}
    </p>
  ) : null;
}

/** The value of a condition, as its field's type wants it. */
export function ConditionValue({
  field,
  op,
  value,
  id,
  onChange,
  valueLabel,
}: {
  field: EditorField;
  op: string;
  value: string | string[] | undefined;
  id: string;
  onChange: (v: string | string[]) => void;
  valueLabel: string;
}) {
  const t = useTranslations('customReports');
  if (NO_VALUE.includes(op)) return null;
  if (field.type === 'enum') {
    const chosen = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <fieldset aria-label={valueLabel} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {field.options.map((o) => (
          <label key={o} htmlFor={`${id}-${o}`} className="flex items-center gap-1.5">
            <Checkbox
              id={`${id}-${o}`}
              checked={chosen.includes(o)}
              onChange={(e) =>
                onChange(e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o))
              }
            />
            {t(`values.${field.key}.${o}`)}
          </label>
        ))}
      </fieldset>
    );
  }
  const type =
    field.type === 'date' && (op === 'after' || op === 'before')
      ? 'date'
      : field.type === 'number' || op === 'lastDays' || op === 'nextDays'
        ? 'number'
        : 'text';
  return (
    <Input
      id={id}
      aria-label={valueLabel}
      type={type}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={type === 'text' ? 'min-w-48' : 'w-40'}
    />
  );
}

export function ReportEditor({
  report,
  fields,
}: {
  report: {
    id: string;
    name: string;
    columns: Column[];
    conditions: Condition[];
    filters: string[];
    sort: ReportSort | null;
  };
  fields: EditorField[];
}) {
  const t = useTranslations('customReports');
  const tc = useTranslations('common');
  const router = useRouter();
  const [columns, setColumns] = useState<Row<Column>[]>(() => report.columns.map(withUid));
  const [conditions, setConditions] = useState<Row<Condition>[]>(() =>
    report.conditions.map(withUid),
  );
  const [filters, setFilters] = useState<string[]>(report.filters);
  const [sort, setSort] = useState(report.sort);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const move = (i: number, d: -1 | 1) => {
    const next = moveColumn(columns, sort, i, d);
    setColumns(next.columns);
    setSort(next.sort);
  };
  const fieldOptions = fields.map((f) => (
    <option key={f.key} value={f.key}>
      {f.label}
    </option>
  ));
  return (
    <ActionForm
      action={saveReportAction}
      success={tc('saved')}
      onSuccess={() => router.refresh()}
      className="grid gap-6"
    >
      <input type="hidden" name="id" value={report.id} />
      <input type="hidden" name="columns" value={JSON.stringify(columns.map(strip))} />
      <input type="hidden" name="conditions" value={JSON.stringify(conditions.map(strip))} />
      <input type="hidden" name="filters" value={JSON.stringify(filters)} />
      <input type="hidden" name="sort" value={JSON.stringify(sort)} />
      <FormField
        name="name"
        id="report-name"
        label={t('name')}
        defaultValue={report.name}
        required
      />
      <DefinitionError />

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('columns')}</legend>
        {columns.map((c, i) => {
          const f = byKey.get(c.field);
          const n = i + 1;
          return (
            <div
              key={c.uid}
              className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_11rem_1fr_auto] sm:items-end"
            >
              <Field label={t('column', { n })} htmlFor={`col-${i}`}>
                <Select
                  id={`col-${i}`}
                  value={c.field}
                  onChange={(e) =>
                    setColumns(
                      columns.map((x, j) => (j === i ? { uid: x.uid, field: e.target.value } : x)),
                    )
                  }
                >
                  {fieldOptions}
                </Select>
              </Field>
              <Field label={t('aggregate')} htmlFor={`agg-${i}`}>
                <Select
                  id={`agg-${i}`}
                  value={c.aggregate ?? ''}
                  onChange={(e) =>
                    setColumns(
                      columns.map((x, j) =>
                        j === i ? { ...x, aggregate: e.target.value || undefined } : x,
                      ),
                    )
                  }
                >
                  <option value="">{t('noAggregate')}</option>
                  {(f ? AGGREGATES[f.type] : []).map((a) => (
                    <option key={a} value={a}>
                      {t(`aggregates.${a}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('label')} htmlFor={`label-${i}`}>
                <Input
                  id={`label-${i}`}
                  value={c.label ?? ''}
                  placeholder={f?.label}
                  onChange={(e) =>
                    setColumns(
                      columns.map((x, j) =>
                        j === i ? { ...x, label: e.target.value || undefined } : x,
                      ),
                    )
                  }
                />
              </Field>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t('moveUpN', { n })}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t('moveDownN', { n })}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={columns.length === 1}
                  aria-label={t('removeN', { n })}
                  onClick={() => {
                    setColumns(columns.filter((_, j) => j !== i));
                    setSort(null);
                  }}
                >
                  ×
                </Button>
              </div>
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={columns.length >= 30}
            onClick={() => setColumns([...columns, withUid({ field: fields[0]!.key })])}
          >
            {t('addColumn')}
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sortBy')} htmlFor="report-sort">
          <Select
            id="report-sort"
            value={sort ? String(sort.column) : ''}
            onChange={(e) =>
              setSort(
                e.target.value === ''
                  ? null
                  : { column: Number(e.target.value), desc: sort?.desc ?? false },
              )
            }
          >
            <option value="">{t('sortDefault')}</option>
            {columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
              <option key={i} value={String(i)}>
                {c.label || byKey.get(c.field)?.label}
              </option>
            ))}
          </Select>
        </Field>
        {sort ? (
          <Field label={t('direction')} htmlFor="report-dir">
            <Select
              id="report-dir"
              value={sort.desc ? 'desc' : 'asc'}
              onChange={(e) => setSort({ ...sort, desc: e.target.value === 'desc' })}
            >
              <option value="asc">{t('asc')}</option>
              <option value="desc">{t('desc')}</option>
            </Select>
          </Field>
        ) : null}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('conditions')}</legend>
        <p className="text-xs text-muted-foreground">{t('conditionsHint')}</p>
        {conditions.map((c, i) => {
          const f = byKey.get(c.field) ?? fields[0]!;
          const n = i + 1;
          return (
            <div
              key={c.uid}
              className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2"
            >
              <Field
                label={t('condition', { n })}
                htmlFor={`cond-${i}`}
                className="min-w-48 flex-1"
              >
                <Select
                  id={`cond-${i}`}
                  value={c.field}
                  onChange={(e) => {
                    const nf = byKey.get(e.target.value)!;
                    setConditions(
                      conditions.map((x, j) =>
                        j === i ? { uid: x.uid, field: nf.key, op: OPERATORS[nf.type][0]! } : x,
                      ),
                    );
                  }}
                >
                  {fieldOptions}
                </Select>
              </Field>
              <Field label={t('operator')} htmlFor={`op-${i}`}>
                <Select
                  id={`op-${i}`}
                  value={c.op}
                  onChange={(e) =>
                    setConditions(
                      conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)),
                    )
                  }
                >
                  {OPERATORS[f.type].map((o) => (
                    <option key={o} value={o}>
                      {t(`ops.${o}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <ConditionValue
                field={f}
                op={c.op}
                value={c.value}
                id={`val-${i}`}
                valueLabel={t('valueN', { n })}
                onChange={(value) =>
                  setConditions(conditions.map((x, j) => (j === i ? { ...x, value } : x)))
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t('removeConditionN', { n })}
                onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
              >
                ×
              </Button>
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              setConditions([
                ...conditions,
                withUid({ field: fields[0]!.key, op: OPERATORS[fields[0]!.type][0]! }),
              ])
            }
          >
            {t('addCondition')}
          </Button>
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('filters')}</legend>
        <p className="text-xs text-muted-foreground">{t('filtersHint')}</p>
        <div className="flex flex-wrap gap-2">
          {filters.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-sm"
            >
              {byKey.get(k)?.label ?? k}
              <button
                type="button"
                className="px-1 text-muted-foreground hover:text-foreground"
                aria-label={`${tc('delete')}: ${byKey.get(k)?.label ?? k}`}
                onClick={() => setFilters(filters.filter((x) => x !== k))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {filters.length < 15 ? (
          <Field label={t('addFilter')} htmlFor="add-filter" className="max-w-sm">
            <Select
              id="add-filter"
              value=""
              onChange={(e) => e.target.value && setFilters([...filters, e.target.value])}
            >
              <option value="">{t('chooseField')}</option>
              {fields
                .filter((f) => !filters.includes(f.key))
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </Select>
          </Field>
        ) : null}
      </fieldset>

      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
