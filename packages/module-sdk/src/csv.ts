// CSV for imports and exports shared by core and modules.

/**
 * The text of a CSV file: UTF-8, or Windows-1251 when it is not valid UTF-8 (Excel saves CSV
 * in the system's code page, which in Russian is Windows-1251).
 */
export function decodeCsv(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1251').decode(data);
  }
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). Separator auto-detected (, or ;). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((f) => (GUARDED.test(f) ? f.slice(1) : f)));
}

// Spreadsheets run a cell starting with = + - @ (or a tab or CR) as a formula, and cells
// hold what people typed: such text is written with a leading apostrophe, which parseCsv
// takes off again. Numbers, also as formatted text ("-1 234,5"), stay numbers.
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^-[\d \u00a0\u202f.,]+$/;
const GUARDED = /^'[=+\-@\t\r]/;

/** A CSV cell: guarded against formulas; quoted when it holds a separator, a quote or a line break. */
export const csvCell = (v: string | number | null | undefined): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && FORMULA.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** A CSV file of rows (with a byte order mark, so spreadsheets read it as UTF-8). */
export const csvFile = (rows: (string | number | null | undefined)[][]): string =>
  `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
