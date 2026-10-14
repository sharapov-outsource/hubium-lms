import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.ts';
import { readSheet, writeOds } from './sheets.ts';
import { writeXlsx } from './xlsx.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));

// what the fixtures hold (saved by LibreOffice from the same table)
const TABLE = [
  ['email', 'Домашнее задание 1', 'Итог', 'Отзыв'],
  ['student1@hubium.local', '8.5', '', 'Хорошо сделано'],
  ['student2@hubium.local', '7', 'Зачтено'],
  ['student2@hubium.local', '7', 'Зачтено'],
  ['student3@hubium.local', '0.1'],
];

const ods = (rows: string) =>
  zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
    'content.xml': strToU8(
      `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet><table:table table:name="A">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`,
    ),
  });
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).fieldErrors?.file?.[0];
  }
  return null;
};

describe('spreadsheets', () => {
  it('reads ODS and XLSX saved by LibreOffice', () => {
    expect(readSheet(fixture('grades-libreoffice.ods'))).toEqual(TABLE);
    expect(readSheet(fixture('grades-libreoffice.xlsx'))).toEqual(TABLE);
  });

  it('reads back what it writes, and what the XLSX export writes', () => {
    const rows = [
      ['Имя', 'Оценка', 'Отзыв'],
      ['Анна', 9.25, 'две  строки\nвторая'],
      ['Борис', null, '<&>'],
    ];
    expect(readSheet(writeOds(rows))).toEqual([
      ['Имя', 'Оценка', 'Отзыв'],
      ['Анна', '9.25', 'две  строки\nвторая'],
      ['Борис', '', '<&>'],
    ]);
    expect(readSheet(writeXlsx(rows))).toEqual([
      ['Имя', 'Оценка', 'Отзыв'],
      ['Анна', '9.25', 'две  строки\nвторая'],
      ['Борис', '', '<&>'],
    ]);
  });

  it('expands repeats, but not the empty ones that run to the end of the sheet', () => {
    const cell = (v: string, n = 1) =>
      `<table:table-cell office:value-type="string"${n > 1 ? ` table:number-columns-repeated="${n}"` : ''}><text:p>${v}</text:p></table:table-cell>`;
    const rows = readSheet(
      ods(
        `<table:table-row>${cell('a')}<table:table-cell table:number-columns-repeated="2"/>${cell('b', 2)}<table:table-cell table:number-columns-repeated="16380"/></table:table-row>` +
          `<table:table-row table:number-rows-repeated="2">${cell('x')}</table:table-row>` +
          `<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>`,
      ),
    );
    expect(rows).toEqual([['a', '', '', 'b', 'b'], ['x'], ['x']]);
  });

  it('reads CSV in UTF-8 or as Excel saves it in Russian', () => {
    expect(readSheet(strToU8('﻿email;Оценка\na@b.c;5\n'))).toEqual([
      ['email', 'Оценка'],
      ['a@b.c', '5'],
    ]);
    // "Оценка" in Windows-1251
    const cp1251 = new Uint8Array([0xce, 0xf6, 0xe5, 0xed, 0xea, 0xe0]);
    const csv = new Uint8Array([...strToU8('email,'), ...cp1251, ...strToU8('\na@b.c,4\n')]);
    expect(readSheet(csv)).toEqual([
      ['email', 'Оценка'],
      ['a@b.c', '4'],
    ]);
  });

  it('refuses what is too big, too long or not a spreadsheet', () => {
    expect(refusal(() => readSheet(new Uint8Array(6 * 1024 * 1024)))).toMatch(/larger than 5 MB/);
    const many = `email\n${'a@b.c\n'.repeat(10_001)}`;
    expect(refusal(() => readSheet(strToU8(many)))).toMatch(/10000 rows/);
    // a zip bomb: one entry that unpacks to more than allowed
    const bomb = zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet'),
      'content.xml': new Uint8Array(51 * 1024 * 1024),
    });
    expect(refusal(() => readSheet(bomb))).toMatch(/unpacks to too much/);
    expect(refusal(() => readSheet(zipSync({ 'a.txt': strToU8('hi') })))).toMatch(
      /Not a spreadsheet/,
    );
    const withDoctype = zipSync({
      mimetype: [strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
      'content.xml': strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'),
    });
    expect(refusal(() => readSheet(withDoctype))).toMatch(/not a plain spreadsheet/);
  });
});
