import { describe, expect, it } from 'vitest';
import { csvCell, csvFile, parseCsv } from './csv.ts';

describe('CSV', () => {
  it('reads quotes, line breaks and either separator', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(parseCsv('a;b\n1;"2\n3"')).toEqual([
      ['a', 'b'],
      ['1', '2\n3'],
    ]);
  });

  it('writes what it reads back', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell(null)).toBe('');
    const rows = [
      ['name', 'note'],
      ['Ann', 'line 1\nline "2"'],
    ];
    expect(parseCsv(csvFile(rows))).toEqual(rows);
  });

  it('keeps spreadsheets from running a cell as a formula, and reads it back as written', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+7 900')).toBe("'+7 900");
    expect(csvCell('-cmd|x')).toBe("'-cmd|x");
    expect(csvCell('\t=1')).toBe("'\t=1");
    // numbers, written or formatted, stay numbers
    expect(csvCell(-2.5)).toBe('-2.5');
    expect(csvCell('-2.5')).toBe('-2.5');
    expect(csvCell('-1\u00a0234,5')).toBe('"-1\u00a0234,5"');
    expect(csvCell('Иванов, Пётр')).toBe('"Иванов, Пётр"');
    const rows = [
      ['name', 'note'],
      ['=1+1', '-x'],
      ["'plain", '@home'],
    ];
    expect(parseCsv(csvFile(rows))).toEqual(rows);
  });
});
