import { describe, expect, it } from 'vitest';
import { EntryInput, GlossarySettings, indexLetter } from './server.ts';

describe('glossary', () => {
  it('files entries under their first letter, anything else under "#"', () => {
    expect(['энтропия', ' Atom', 'öl', '42', '«Кавычки»', ''].map(indexLetter)).toEqual([
      'Э',
      'A',
      'Ö',
      '#',
      '#',
      '#',
    ]);
  });

  it('reads other forms and categories from a list or from text', () => {
    const e = EntryInput.parse({
      concept: '  Матрица ',
      aliases: 'матрицы,\nматрицу, матрицы ,',
      categories: ['Алгебра', 'Алгебра', ''],
    });
    expect(e).toMatchObject({
      concept: 'Матрица',
      aliases: ['матрицы', 'матрицу'],
      categories: ['Алгебра'],
      autoLink: false,
      caseSensitive: false,
      fullMatch: true,
    });
    expect(EntryInput.safeParse({ concept: ' ' }).success).toBe(false);
  });

  it('checks the rating window and the pass grade', () => {
    expect(GlossarySettings.parse({})).toMatchObject({
      approvalRequired: false,
      allowEditing: true,
      autoLink: false,
      displayFormat: 'dictionary',
      ratingAggregate: 'none',
    });
    expect(
      GlossarySettings.safeParse({
        ratingFrom: '2026-02-01T00:00:00.000Z',
        ratingTo: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(GlossarySettings.safeParse({ ratingMax: 5, ratingPass: 6 }).success).toBe(false);
  });
});
