import { XMLParser } from 'fast-xml-parser';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { ValidationError } from '../errors.ts';
import { parseCsv } from '../users/users.ts';
import type { Cell } from './xlsx.ts';

// Spreadsheets in and out without a spreadsheet library: CSV (UTF-8, or Windows-1251 as
// Excel saves it in Russian), XLSX and ODS read into rows of text, and ODS written. Files
// are untrusted: their size, what they unpack to and their rows are capped, and XML with
// a DOCTYPE is refused.

export const SHEET_LIMITS = {
  bytes: 5 * 1024 * 1024,
  unpacked: 50 * 1024 * 1024,
  rows: 10_000,
  columns: 500,
} as const;

const refuse = (message: string): never => {
  throw new ValidationError({ file: [message] });
};

type XNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: false,
});

function parseXml(bytes: Uint8Array | undefined): XNode[] {
  if (!bytes) return [];
  const xml = new TextDecoder().decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) refuse('The file is not a plain spreadsheet');
  return parser.parse(xml) as XNode[];
}

const tagOf = (n: XNode) => Object.keys(n).find((k) => k !== ':@') ?? '';
const kids = (n: XNode): XNode[] => {
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as XNode[]) : [];
};
const attr = (n: XNode, name: string) =>
  (n[':@'] as Record<string, string> | undefined)?.[`@_${name}`];

/** The first descendant (depth first) with the tag. */
function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    const inner = find(kids(n), tag);
    if (inner) return inner;
  }
  return undefined;
}

/** The text under nodes, as a spreadsheet shows it (ODF spaces, tabs and line breaks). */
function textOf(nodes: XNode[], skip: string[] = []): string {
  let out = '';
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === '#text') out += String(n['#text'] ?? '');
    else if (skip.includes(tag)) continue;
    else if (tag === 'text:s') out += ' '.repeat(Number(attr(n, 'text:c') ?? 1) || 1);
    else if (tag === 'text:tab') out += '\t';
    else if (tag === 'text:line-break') out += '\n';
    else out += textOf(kids(n), skip);
  }
  return out;
}

/** A number as people typed it, without binary noise (0.30000000000000004 → 0.3). */
const numberText = (v: string) => {
  const x = Number(v);
  return Number.isFinite(x) ? String(Number(x.toPrecision(15))) : v;
};

/** Column index of a cell reference: A1 → 0, AB7 → 27. */
const columnOf = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function unzip(data: Uint8Array, wanted: (name: string) => boolean) {
  let total = 0;
  try {
    return unzipSync(data, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        total += f.originalSize;
        if (total > SHEET_LIMITS.unpacked) refuse('The file unpacks to too much data');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    return refuse('The file is damaged');
  }
}

function readXlsx(data: Uint8Array): string[][] {
  const files = unzip(
    data,
    (n) => (n.startsWith('xl/') && n.endsWith('.xml')) || n.endsWith('.rels'),
  );
  const wb = parseXml(files['xl/workbook.xml']);
  const first = find(wb, 'sheet');
  const rid = first ? attr(first, 'r:id') : undefined;
  const rels = kids(find(parseXml(files['xl/_rels/workbook.xml.rels']), 'Relationships') ?? {});
  const target = rels.find((r) => attr(r, 'Id') === rid);
  const path = target ? attr(target, 'Target') : undefined;
  const sheetPath = path
    ? path.startsWith('/')
      ? path.slice(1)
      : `xl/${path.replace(/^\.\//, '')}`
    : 'xl/worksheets/sheet1.xml';
  const shared = kids(find(parseXml(files['xl/sharedStrings.xml']), 'sst') ?? {})
    .filter((n) => tagOf(n) === 'si')
    // phonetic runs are readings, not the text
    .map((si) => textOf(kids(si), ['rPh', 'phoneticPr']));
  const sheet = find(parseXml(files[sheetPath]), 'sheetData');
  if (!sheet) refuse('The workbook has no sheet');
  const rows: string[][] = [];
  let next = 0;
  for (const row of kids(sheet!)) {
    if (tagOf(row) !== 'row') continue;
    const r = Number(attr(row, 'r') ?? next + 1) - 1;
    next = r + 1;
    if (r >= SHEET_LIMITS.rows + 1) refuse(`At most ${SHEET_LIMITS.rows} rows`);
    const cells: string[] = [];
    let col = 0;
    for (const c of kids(row)) {
      if (tagOf(c) !== 'c') continue;
      const ref = attr(c, 'r');
      col = ref ? columnOf(ref) : col;
      if (col >= SHEET_LIMITS.columns) refuse(`At most ${SHEET_LIMITS.columns} columns`);
      const type = attr(c, 't');
      const v = textOf(kids(c).filter((x) => tagOf(x) === 'v'));
      cells[col] =
        type === 's'
          ? (shared[Number(v)] ?? '')
          : type === 'inlineStr'
            ? textOf(kids(c).filter((x) => tagOf(x) === 'is'))
            : type === 'b'
              ? v === '1'
                ? 'TRUE'
                : 'FALSE'
              : type === 'e'
                ? ''
                : type === 'str'
                  ? v
                  : v === ''
                    ? ''
                    : numberText(v);
      col++;
    }
    rows[r] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x ?? []);
}

function readOds(data: Uint8Array): string[][] {
  const files = unzip(data, (n) => n === 'content.xml' || n === 'mimetype');
  const table = find(parseXml(files['content.xml']), 'table:table');
  if (!table) refuse('The spreadsheet has no sheet');
  const rows: string[][] = [];
  // empty rows and cells are written as repeats (to the end of the sheet): they count only
  // when something follows them
  let emptyRows = 0;
  const walk = (nodes: XNode[]) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (
        tag === 'table:table-header-rows' ||
        tag === 'table:table-rows' ||
        tag === 'table:table-row-group'
      )
        walk(kids(n));
      if (tag !== 'table:table-row') continue;
      const cells: string[] = [];
      let emptyCells = 0;
      for (const c of kids(n)) {
        const ct = tagOf(c);
        if (ct !== 'table:table-cell' && ct !== 'table:covered-table-cell') continue;
        const repeat = Number(attr(c, 'table:number-columns-repeated') ?? 1) || 1;
        const type = attr(c, 'office:value-type');
        const value =
          type === 'float' || type === 'percentage' || type === 'currency'
            ? numberText(attr(c, 'office:value') ?? '')
            : type === 'boolean'
              ? attr(c, 'office:boolean-value') === 'true'
                ? 'TRUE'
                : 'FALSE'
              : type === 'date'
                ? (attr(c, 'office:date-value') ?? '')
                : kids(c)
                    .filter((p) => tagOf(p) === 'text:p')
                    .map((p) => textOf(kids(p)))
                    .join('\n');
        if (value === '') {
          emptyCells += repeat;
          continue;
        }
        if (cells.length + emptyCells + repeat > SHEET_LIMITS.columns)
          refuse(`At most ${SHEET_LIMITS.columns} columns`);
        for (let k = 0; k < emptyCells; k++) cells.push('');
        emptyCells = 0;
        for (let k = 0; k < repeat; k++) cells.push(value);
      }
      const repeat = Number(attr(n, 'table:number-rows-repeated') ?? 1) || 1;
      if (!cells.length) {
        emptyRows += repeat;
        continue;
      }
      if (rows.length + emptyRows + repeat > SHEET_LIMITS.rows + 1)
        refuse(`At most ${SHEET_LIMITS.rows} rows`);
      for (let k = 0; k < emptyRows; k++) rows.push([]);
      emptyRows = 0;
      for (let k = 0; k < repeat; k++) rows.push([...cells]);
    }
  };
  walk(kids(table!));
  return rows;
}

function readCsv(data: Uint8Array): string[][] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    // Excel saves CSV in the system's code page; in Russian that is Windows-1251
    text = new TextDecoder('windows-1251').decode(data);
  }
  const rows = parseCsv(text);
  if (rows.length > SHEET_LIMITS.rows + 1) refuse(`At most ${SHEET_LIMITS.rows} rows`);
  return rows;
}

/**
 * The rows of a spreadsheet file (the first sheet), as text: CSV, XLSX or ODS, told by the
 * content rather than the name. Rows end at their last filled cell; empty rows in a sheet
 * stay (as []), so row numbers are the sheet's.
 */
export function readSheet(data: Uint8Array): string[][] {
  if (data.length > SHEET_LIMITS.bytes)
    refuse(`The file is larger than ${SHEET_LIMITS.bytes / 1024 / 1024} MB`);
  const zip = data[0] === 0x50 && data[1] === 0x4b;
  let rows: string[][];
  if (zip) {
    const head = unzip(data, (n) => n === 'mimetype' || n === 'xl/workbook.xml');
    if (head['xl/workbook.xml']) rows = readXlsx(data);
    else if (
      new TextDecoder().decode(head.mimetype ?? new Uint8Array()).trim() ===
      'application/vnd.oasis.opendocument.spreadsheet'
    )
      rows = readOds(data);
    else return refuse('Not a spreadsheet: use CSV, XLSX or ODS');
  } else rows = readCsv(data);
  return rows.map((r) => {
    let end = r.length;
    while (end > 0 && (r[end - 1] ?? '').trim() === '') end--;
    return r.slice(0, end).map((x) => x ?? '');
  });
}

const esc = (s: string) =>
  s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 does not allow them
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
].join(' ');

function odsCell(v: Cell, bold: boolean): string {
  const style = bold ? ' table:style-name="header"' : '';
  if (v === null || v === undefined || v === '') return `<table:table-cell${style}/>`;
  if (typeof v === 'number' && Number.isFinite(v))
    return `<table:table-cell${style} office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
  const p = String(v)
    .split('\n')
    .map((line) => esc(line).replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`))
    .join('<text:line-break/>');
  return `<table:table-cell${style} office:value-type="string"><text:p>${p}</text:p></table:table-cell>`;
}

/**
 * An OpenDocument spreadsheet with `rows` on one sheet, the first row in bold. The
 * `mimetype` file comes first and uncompressed, as the format asks.
 */
export function writeOds(rows: Cell[][], sheetName = 'Sheet1'): Uint8Array {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<office:document-content ${NS} office:version="1.3">`,
    '<office:automatic-styles><style:style style:name="header" style:family="table-cell">',
    '<style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>',
    `<office:body><office:spreadsheet><table:table table:name="${esc(sheetName)}">`,
    `<table:table-column table:number-columns-repeated="${width}"/>`,
    ...rows.map(
      (r, i) => `<table:table-row>${r.map((v) => odsCell(v, i === 0)).join('')}</table:table-row>`,
    ),
    '</table:table></office:spreadsheet></office:body></office:document-content>',
  ].join('');
  const manifest = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">',
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>',
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '</manifest:manifest>',
  ].join('');
  return zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
    'META-INF/manifest.xml': strToU8(manifest),
    'content.xml': strToU8(content),
  });
}
