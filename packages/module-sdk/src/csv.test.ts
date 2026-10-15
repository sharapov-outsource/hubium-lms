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
});
