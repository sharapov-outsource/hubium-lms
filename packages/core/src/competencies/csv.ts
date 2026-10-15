import { htmlToText } from '@hubium/ai';
import { csvCell, parseCsv } from '@hubium/module-sdk/csv';
import { type Outcome, type PointsConfigT, type ScaleConfigT, TAXONOMIES } from './model.ts';

// Competency frameworks as CSV in the layout of Moodle's "Import competency framework"
// (tool_lpimportcsv): a header row, the framework's row, then its competencies, parents
// before their children. Pure.

export const CSV_HEADERS = [
  'Parent ID number',
  'ID number',
  'Short name',
  'Description',
  'Description format',
  'Scale values',
  'Scale configuration',
  'Rule type (optional)',
  'Rule outcome (optional)',
  'Rule config (optional)',
  'Cross-referenced competency ID numbers',
  'Exported ID (optional)',
  'Is framework',
  'Taxonomy',
] as const;

const RULE_ALL = 'core_competency\\competency_rule_all';
const RULE_POINTS = 'core_competency\\competency_rule_points';
/** Moodle's numbers for outcomes. */
const OUTCOME_CODES: Record<Outcome, number> = { NONE: 0, EVIDENCE: 1, COMPLETE: 2, RECOMMEND: 3 };
const FORMAT_HTML = 1;
const FORMAT_PLAIN = 2;

export interface CsvFramework {
  idNumber: string;
  shortName: string;
  description: string;
  scaleItems: string[];
  scaleConfig: ScaleConfigT;
  taxonomies: string[];
}

export interface CsvCompetency {
  parentIdNumber: string | null;
  idNumber: string;
  shortName: string;
  description: string;
  /** A scale of its own. */
  scaleItems: string[] | null;
  scaleConfig: ScaleConfigT | null;
  ruleType: 'ALL' | 'POINTS' | null;
  ruleOutcome: Outcome;
  /** Children are named by their exported ids. */
  ruleConfig: PointsConfigT | null;
  related: string[];
  exportId: string | null;
}

// ── writing ──────────────────────────────────────────────────────────────────

/** Moodle's scale configuration: the scale, then each value with its flags. */
function scaleConfigJson(scaleId: string, items: number, c: ScaleConfigT): string {
  return JSON.stringify([
    { scaleid: scaleId },
    ...Array.from({ length: items }, (_, i) => ({
      id: i + 1,
      scaledefault: c.default === i + 1 ? 1 : 0,
      proficient: c.proficient.includes(i + 1) ? 1 : 0,
    })),
  ]);
}

export function buildFrameworkCsv(
  fw: CsvFramework & { scaleId: string },
  competencies: (Omit<CsvCompetency, 'exportId'> & { exportId: string; scaleId: string | null })[],
): string {
  const rows: string[][] = [[...CSV_HEADERS]];
  rows.push([
    '',
    fw.idNumber,
    fw.shortName,
    fw.description,
    String(FORMAT_PLAIN),
    fw.scaleItems.join(','),
    scaleConfigJson(fw.scaleId, fw.scaleItems.length, fw.scaleConfig),
    '',
    '',
    '',
    '',
    '',
    '1',
    fw.taxonomies.join(','),
  ]);
  for (const c of competencies)
    rows.push([
      c.parentIdNumber ?? '',
      c.idNumber,
      c.shortName,
      c.description,
      String(FORMAT_PLAIN),
      c.scaleItems?.join(',') ?? '',
      c.scaleItems && c.scaleConfig && c.scaleId
        ? scaleConfigJson(c.scaleId, c.scaleItems.length, c.scaleConfig)
        : '',
      c.ruleType === 'ALL' ? RULE_ALL : c.ruleType === 'POINTS' ? RULE_POINTS : '',
      c.ruleType ? String(OUTCOME_CODES[c.ruleOutcome]) : '',
      c.ruleType === 'POINTS' && c.ruleConfig
        ? JSON.stringify({
            base: { points: c.ruleConfig.points },
            competencies: c.ruleConfig.children.map((x) => ({
              id: x.id,
              points: x.points,
              required: x.required ? 1 : 0,
            })),
          })
        : '',
      c.related.join(','),
      c.exportId,
      '0',
      '',
    ]);
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ── reading ──────────────────────────────────────────────────────────────────

function readScaleConfig(raw: string, items: number): ScaleConfigT | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The scale configuration is not JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('The scale configuration is not a list');
  const values = parsed.filter(
    (v): v is { id: unknown; scaledefault?: unknown; proficient?: unknown } =>
      !!v && typeof v === 'object' && 'id' in v,
  );
  const num = (v: unknown) => Number(v);
  const def = values.find((v) => num(v.scaledefault) === 1);
  const proficient = values.filter((v) => num(v.proficient) === 1).map((v) => num(v.id));
  if (!def || !proficient.length) return null;
  const d = num(def.id);
  if (!Number.isInteger(d) || d < 1 || d > items) return null;
  return {
    default: d,
    proficient: proficient.filter((v) => Number.isInteger(v) && v >= 1 && v <= items),
  };
}

function readDescription(text: string, format: string): string {
  const html = Number(format) === FORMAT_HTML || /<[a-z][\s\S]*>/i.test(text);
  return (html ? htmlToText(text) : text).trim().slice(0, 10_000);
}

const split = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** The framework and its competencies from a CSV, or why it cannot be read. */
export function parseFrameworkCsv(text: string): {
  framework: CsvFramework;
  competencies: CsvCompetency[];
} {
  const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) throw new Error('The file has no framework');
  // columns by their English headers, as Moodle writes them; otherwise by position
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const at = CSV_HEADERS.map((h, i) => {
    const j = head.indexOf(h.toLowerCase());
    return j >= 0 ? j : i;
  });
  const get = (r: string[], col: number) => (r[at[col]!] ?? '').trim();
  let framework: CsvFramework | null = null;
  const competencies: CsvCompetency[] = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const line = n + 2;
    const fail = (m: string) => {
      throw new Error(`Line ${line}: ${m}`);
    };
    const idNumber = get(r, 1);
    const shortName = get(r, 2);
    if (!idNumber) fail('no ID number');
    if (!shortName) fail('no short name');
    const items = split(get(r, 5));
    let scaleConfig: ScaleConfigT | null = null;
    try {
      scaleConfig = items.length ? readScaleConfig(get(r, 6), items.length) : null;
    } catch (e) {
      fail((e as Error).message);
    }
    const description = readDescription(get(r, 3), get(r, 4));
    if (get(r, 12) === '1') {
      if (framework) fail('a second framework');
      if (!items.length) fail('the framework has no scale values');
      framework = {
        idNumber,
        shortName,
        description,
        scaleItems: items,
        scaleConfig: scaleConfig ?? { default: items.length, proficient: [items.length] },
        taxonomies: split(get(r, 13)).map((t) =>
          (TAXONOMIES as readonly string[]).includes(t) ? t : 'competency',
        ),
      };
      continue;
    }
    if (!framework) fail('a competency before the framework');
    const type = get(r, 7).replace(/^\\/, '');
    const ruleType = type === RULE_ALL ? 'ALL' : type === RULE_POINTS ? 'POINTS' : null;
    const code = Number(get(r, 8) || 0);
    const ruleOutcome =
      (Object.entries(OUTCOME_CODES).find(([, v]) => v === code)?.[0] as Outcome) ?? 'NONE';
    let ruleConfig: PointsConfigT | null = null;
    if (ruleType === 'POINTS' && get(r, 9)) {
      try {
        const c = JSON.parse(get(r, 9)) as {
          base?: { points?: unknown };
          competencies?: { id?: unknown; points?: unknown; required?: unknown }[];
        };
        ruleConfig = {
          points: Number(c.base?.points ?? 0),
          children: (c.competencies ?? []).map((x) => ({
            id: String(x.id),
            points: Number(x.points ?? 0),
            required: Number(x.required ?? 0) === 1 || x.required === true,
          })),
        };
      } catch {
        fail('the rule configuration is not JSON');
      }
    }
    competencies.push({
      parentIdNumber: get(r, 0) || null,
      idNumber,
      shortName,
      description,
      scaleItems: items.length ? items : null,
      scaleConfig,
      ruleType,
      ruleOutcome: ruleType ? ruleOutcome : 'NONE',
      ruleConfig,
      related: split(get(r, 10)),
      exportId: get(r, 11) || null,
    });
  }
  if (!framework) throw new Error('The file has no framework');
  const seen = new Set<string>();
  for (const c of competencies) {
    if (seen.has(c.idNumber)) throw new Error(`The ID number ${c.idNumber} is used twice`);
    seen.add(c.idNumber);
  }
  for (const c of competencies)
    if (c.parentIdNumber && !seen.has(c.parentIdNumber))
      throw new Error(`The parent ${c.parentIdNumber} of ${c.idNumber} is not in the file`);
  return { framework, competencies };
}
