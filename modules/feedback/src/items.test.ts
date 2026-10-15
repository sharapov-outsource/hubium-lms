import { describe, expect, it } from 'vitest';
import { checkAnswers } from './answers.ts';
import { type Item, itemNumbers, itemPages } from './items.ts';

const item = (id: string, type: Item['type'], extra: Partial<Item> = {}): Item => ({
  id,
  sortOrder: 0,
  type,
  label: id,
  required: false,
  choices: [],
  multiple: false,
  display: 'radio',
  min: null,
  max: null,
  ...extra,
});

describe('feedback items', () => {
  const items = [
    item('hello', 'info'),
    item('name', 'text', { required: true }),
    item('break', 'pagebreak'),
    item('mark', 'number', { min: 1, max: 5 }),
    item('likes', 'choice', { choices: ['Лекции', 'Практика'], multiple: true }),
    item('format', 'choice', { choices: ['Очно', 'Онлайн'] }),
  ];

  it('numbers questions and splits pages at breaks', () => {
    expect([...itemNumbers(items).entries()]).toEqual([
      ['name', 1],
      ['mark', 2],
      ['likes', 3],
      ['format', 4],
    ]);
    expect(itemPages(items).map((p) => p.map((i) => i.id))).toEqual([
      ['hello', 'name'],
      ['mark', 'likes', 'format'],
    ]);
  });

  it('checks answers against the questions', () => {
    expect(
      checkAnswers(items, {
        name: '  Аня ',
        mark: '4',
        likes: ['Практика', 'Практика'],
        format: 'Онлайн',
        unknown: 'x',
        hello: 'ignored',
      }),
    ).toEqual({ name: 'Аня', mark: 4, likes: ['Практика'], format: 'Онлайн' });
    expect(() => checkAnswers(items, {})).toThrow('"name": an answer is required');
    expect(() => checkAnswers(items, { name: 'a', mark: 9 })).toThrow('out of range');
    expect(() => checkAnswers(items, { name: 'a', format: ['Очно', 'Онлайн'] })).toThrow(
      'choose one option',
    );
    expect(() => checkAnswers(items, { name: 'a', likes: ['Спорт'] })).toThrow('no such option');
  });
});
