import { Prisma } from '@hubium/db';
import { fromZonedValue } from '@hubium/module-sdk/zoned';
import { z } from 'zod';
import {
  AGGREGATES,
  customField,
  type FieldDef,
  type FieldType,
  OPERATORS,
  SOURCES,
  type SourceDef,
  sourceFields,
} from './sources.ts';

// A custom report as SQL: the columns' expressions (aggregated or grouped by), the
// conditions and the viewer's filters, the order and the page. Every expression comes
// from sources.ts; every value a report holds is a bound parameter.

export const ReportColumn = z.object({
  field: z.string().max(200),
  aggregate: z.string().max(20).optional(),
  label: z.string().trim().max(255).optional(),
});
export const ReportCondition = z.object({
  field: z.string().max(200),
  op: z.string().max(20),
  value: z.union([z.string().max(1000), z.array(z.string().max(200)).max(50)]).optional(),
});
export const ReportDefinition = z.object({
  source: z.string(),
  columns: z.array(ReportColumn).min(1).max(30),
  conditions: z.array(ReportCondition).max(30).default([]),
  filters: z.array(z.string().max(200)).max(15).default([]),
  sort: z
    .object({ column: z.number().int().min(0), desc: z.boolean() })
    .nullable()
    .default(null),
});
export type ReportDefinitionT = z.infer<typeof ReportDefinition>;
export type ReportConditionT = z.infer<typeof ReportCondition>;

/** The custom fields a site has, which reports may use. */
export interface CustomFieldNames {
  user: string[];
  course: string[];
}

/** Every field a source offers, its custom fields included. */
export function reportFieldsOf(source: SourceDef, custom: CustomFieldNames): FieldDef[] {
  return [
    ...sourceFields(source),
    ...source.customFields.flatMap((k) => custom[k].map((n) => customField(k, n))),
  ];
}

/** The definition, or why it does not fit its source. */
export function checkDefinition(raw: unknown, custom: CustomFieldNames): ReportDefinitionT {
  const d = ReportDefinition.parse(raw);
  const source = SOURCES[d.source];
  if (!source) throw new Error('Unknown source');
  const fields = new Map(reportFieldsOf(source, custom).map((f) => [f.key, f]));
  const field = (key: string) => {
    const f = fields.get(key);
    if (!f) throw new Error(`Unknown field ${key}`);
    return f;
  };
  for (const c of d.columns) {
    const f = field(c.field);
    if (c.aggregate && !AGGREGATES[f.type].includes(c.aggregate))
      throw new Error(`${c.aggregate} does not apply to ${c.field}`);
  }
  for (const c of d.conditions) {
    const f = field(c.field);
    if (!OPERATORS[f.type].includes(c.op)) throw new Error(`${c.op} does not apply to ${c.field}`);
  }
  for (const k of d.filters) field(k);
  if (new Set(d.filters).size !== d.filters.length) throw new Error('A filter is there twice');
  if (d.sort && d.sort.column >= d.columns.length)
    throw new Error('Sorted by a column it does not have');
  return d;
}

const raw = (s: string) => Prisma.raw(s);

/** A field's SQL: custom fields take their short name as a parameter. */
function expr(f: FieldDef): Prisma.Sql {
  const custom = /^(user|course)\.custom\.(.+)$/.exec(f.key);
  return custom ? Prisma.sql`(${raw(f.sql)}${custom[2]!})` : Prisma.sql`(${raw(f.sql)})`;
}

/** The type of a column's values once aggregated. */
export function columnType(f: FieldDef, aggregate?: string): FieldType {
  if (!aggregate) return f.type;
  if (aggregate === 'list') return 'text';
  if (aggregate === 'min' || aggregate === 'max') return f.type;
  return 'number';
}

function aggregateSql(aggregate: string | undefined, e: Prisma.Sql): Prisma.Sql {
  switch (aggregate) {
    case 'count':
      return Prisma.sql`COUNT(${e})`;
    case 'countDistinct':
      return Prisma.sql`COUNT(DISTINCT ${e})`;
    case 'countTrue':
      return Prisma.sql`COUNT(*) FILTER (WHERE ${e})`;
    case 'list':
      return Prisma.sql`STRING_AGG(DISTINCT ${e}::text, ', ')`;
    case 'sum':
      return Prisma.sql`SUM(${e})`;
    case 'avg':
      return Prisma.sql`ROUND(AVG(${e})::numeric, 2)`;
    case 'min':
      return Prisma.sql`MIN(${e})`;
    case 'max':
      return Prisma.sql`MAX(${e})`;
    default:
      return e;
  }
}

/** A comparison, or null when its value is missing or makes no sense (it is then left out). */
export function conditionSql(
  f: FieldDef,
  c: Pick<ReportConditionT, 'op' | 'value'>,
  tz: string,
): Prisma.Sql | null {
  const e = expr(f);
  const v = Array.isArray(c.value) ? '' : (c.value ?? '').trim();
  switch (c.op) {
    case 'empty':
      return f.type === 'text' ? Prisma.sql`(${e} IS NULL OR ${e} = '')` : Prisma.sql`${e} IS NULL`;
    case 'notEmpty':
      return f.type === 'text'
        ? Prisma.sql`(${e} IS NOT NULL AND ${e} <> '')`
        : Prisma.sql`${e} IS NOT NULL`;
    case 'isTrue':
      return Prisma.sql`${e} IS TRUE`;
    case 'isFalse':
      return Prisma.sql`${e} IS NOT TRUE`;
  }
  if (c.op === 'in' || c.op === 'notIn') {
    const values = (Array.isArray(c.value) ? c.value : v ? [v] : []).filter((x) =>
      (f.options ?? []).includes(x),
    );
    if (!values.length) return null;
    return c.op === 'in'
      ? Prisma.sql`${e} = ANY(${values}::text[])`
      : Prisma.sql`(${e} IS NULL OR NOT (${e} = ANY(${values}::text[])))`;
  }
  if (!v) return null;
  if (f.type === 'text') {
    switch (c.op) {
      case 'contains':
        return Prisma.sql`strpos(lower(${e}), lower(${v})) > 0`;
      case 'notContains':
        return Prisma.sql`(${e} IS NULL OR strpos(lower(${e}), lower(${v})) = 0)`;
      case 'equals':
        return Prisma.sql`lower(${e}) = lower(${v})`;
      case 'startsWith':
        return Prisma.sql`left(lower(${e}), ${v.length}) = lower(${v})`;
    }
    return null;
  }
  if (f.type === 'number') {
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const ops: Record<string, string> = {
      eq: '=',
      ne: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    };
    const op = ops[c.op];
    return op ? Prisma.sql`${e} ${raw(op)} ${n}::numeric` : null;
  }
  if (f.type === 'date') {
    if (c.op === 'lastDays' || c.op === 'nextDays') {
      const days = Math.floor(Number(v));
      if (!Number.isFinite(days) || days < 0 || days > 36_500) return null;
      return c.op === 'lastDays'
        ? Prisma.sql`(${e} >= now() - make_interval(days => ${days}::int) AND ${e} <= now())`
        : Prisma.sql`(${e} >= now() AND ${e} <= now() + make_interval(days => ${days}::int))`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    // the day starts at midnight in the site's time zone
    const at = fromZonedValue(`${v}T00:00`, tz);
    if (!at) return null;
    if (c.op === 'after') return Prisma.sql`${e} >= ${at}::timestamptz`;
    if (c.op === 'before') return Prisma.sql`${e} < ${at}::timestamptz`;
  }
  return null;
}

export interface BuiltQuery {
  rows: Prisma.Sql;
  count: Prisma.Sql;
  columns: { field: FieldDef; aggregate?: string; type: FieldType }[];
}

/** The report's queries: a page of rows and the number of rows. */
export function buildQuery(
  d: ReportDefinitionT,
  custom: CustomFieldNames,
  opts: {
    tz: string;
    /** The viewer's filters, by field. */
    filters?: Record<string, Pick<ReportConditionT, 'op' | 'value'>>;
    limit?: number;
    offset?: number;
  },
): BuiltQuery {
  const source = SOURCES[d.source]!;
  const fields = new Map(reportFieldsOf(source, custom).map((f) => [f.key, f]));
  const columns = d.columns.map((c) => {
    const field = fields.get(c.field)!;
    return { field, aggregate: c.aggregate, type: columnType(field, c.aggregate) };
  });
  const select = Prisma.join(
    columns.map(
      (c, i) => Prisma.sql`${aggregateSql(c.aggregate, expr(c.field))} AS ${raw(`"c${i}"`)}`,
    ),
    ', ',
  );
  const where = [Prisma.sql`(${raw(source.where)})`];
  for (const c of d.conditions) {
    const s = conditionSql(fields.get(c.field)!, c, opts.tz);
    if (s) where.push(s);
  }
  for (const key of d.filters) {
    const f = opts.filters?.[key];
    const field = fields.get(key);
    if (!f || !field || !OPERATORS[field.type].includes(f.op)) continue;
    const s = conditionSql(field, f, opts.tz);
    if (s) where.push(s);
  }
  const grouped = columns.some((c) => c.aggregate);
  const keys = columns.flatMap((c, i) => (c.aggregate ? [] : [i + 1]));
  const groupBy =
    grouped && keys.length ? Prisma.sql` GROUP BY ${raw(keys.join(', '))}` : Prisma.empty;
  const base = Prisma.sql`SELECT ${select} FROM ${raw(source.from)} WHERE ${Prisma.join(where, ' AND ')}${groupBy}`;
  const sortColumn = d.sort ? d.sort.column + 1 : 1;
  const order = raw(` ORDER BY ${sortColumn} ${d.sort?.desc ? 'DESC' : 'ASC'} NULLS LAST`);
  const page =
    opts.limit !== undefined
      ? Prisma.sql` LIMIT ${opts.limit}::int OFFSET ${opts.offset ?? 0}::int`
      : Prisma.empty;
  return {
    rows: Prisma.sql`${base}${order}${page}`,
    count: Prisma.sql`SELECT COUNT(*)::int AS n FROM (${base}) t`,
    columns,
  };
}

/** Raw values as plain JSON-able ones: numbers for counts and decimals. */
export function plainValue(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
    return v;
  if (typeof v === 'object' && 'toNumber' in v && typeof v.toNumber === 'function')
    return (v as { toNumber(): number }).toNumber();
  return String(v);
}
