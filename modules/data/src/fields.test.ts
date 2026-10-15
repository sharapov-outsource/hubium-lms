import { describe, expect, it } from 'vitest';
import {
  cleanValue,
  compareValues,
  defaultTemplate,
  type Field,
  renderTemplate,
  valueText,
} from './fields.ts';

const field = (type: Field['type'], more: Partial<Field> = {}): Field => ({
  id: type,
  type,
  name: type,
  description: '',
  required: false,
  options: {},
  ...more,
});
const keep = (html: string) => html.replace(/<script.*?<\/script>/g, '');

describe('database fields', () => {
  it('checks and stores values of each kind', () => {
    expect(cleanValue(field('text'), '  Пушкин ', keep)).toEqual({ value: 'Пушкин' });
    expect(cleanValue(field('text', { required: true }), ' ', keep)).toEqual({ error: 'required' });
    expect(cleanValue(field('text'), '', keep)).toEqual({ value: '' });
    expect(cleanValue(field('number'), '3,5', keep)).toEqual({ value: '3.5' });
    expect(cleanValue(field('number'), 'три', keep)).toEqual({ error: 'invalid' });
    expect(cleanValue(field('date'), '2026-02-30', keep)).toEqual({ error: 'invalid' });
    expect(cleanValue(field('date'), '2026-02-28', keep)).toEqual({ value: '2026-02-28' });
    const choices = { options: { choices: ['Проза', 'Поэзия', 'Драма'] } };
    expect(cleanValue(field('menu', choices), 'Поэзия', keep)).toEqual({ value: 'Поэзия' });
    expect(cleanValue(field('radio', choices), 'Эпос', keep)).toEqual({ error: 'invalid' });
    // checkboxes keep the order of the choices, from a list or a CSV cell
    expect(cleanValue(field('checkbox', choices), ['Драма', 'Проза'], keep)).toEqual({
      value: 'Проза\nДрама',
    });
    expect(cleanValue(field('checkbox', choices), 'Драма; Проза', keep)).toEqual({
      value: 'Проза\nДрама',
    });
    expect(cleanValue(field('url'), 'javascript:alert(1)', keep)).toEqual({ error: 'invalid' });
    expect(cleanValue(field('url'), 'https://ru.wikipedia.org', keep)).toEqual({
      value: 'https://ru.wikipedia.org',
    });
    expect(cleanValue(field('textarea'), '<p>Да<script>x()</script></p>', keep)).toEqual({
      value: '<p>Да</p>',
    });
    expect(cleanValue(field('textarea', { required: true }), '<p> </p>', keep)).toEqual({
      error: 'required',
    });
  });

  it('reads values as text and orders them', () => {
    expect(valueText(field('textarea'), '<p>Один</p><p>два</p>')).toBe('Один два');
    expect(valueText(field('checkbox'), 'a\nb')).toBe('a, b');
    expect(valueText(field('image'), 'f1', () => ({ url: '/f', name: 'p.png' }))).toBe('p.png');
    const n = field('number');
    expect(['10', '9', '', '100'].sort((a, b) => compareValues(n, a, b))).toEqual([
      '9',
      '10',
      '100',
      '',
    ]);
  });
});

describe('database templates', () => {
  const fields = [
    field('text', { id: 't', name: 'Автор' }),
    field('url', { id: 'u', name: 'Ссылка', options: { linkText: 'Читать' } }),
    field('image', { id: 'i', name: 'Обложка' }),
    field('date', { id: 'd', name: 'Год & место' }),
  ];
  const o = {
    user: 'Иван <b>',
    added: '1 мая',
    modified: '2 мая',
    moreUrl: '/r/1',
    moreLabel: 'Подробнее',
    date: (d: string) => `день ${d}`,
    file: (id: string) => (id === 'f1' ? { url: '/files/f1/c.png', name: 'c.png' } : undefined),
  };

  it('puts values, links and pictures in the template, escaping text', () => {
    const html = renderTemplate(
      '<p>[[Автор]] <em>[[Ссылка]]</em> [[Обложка]] [[Год &amp; место]] [[Нет такого]]</p><p>##user## · ##timeadded## ##more## ##edit##</p>',
      fields,
      { t: '<script>', u: 'https://x.org/?a=1&b=2', i: 'f1', d: '2026-05-01' },
      o,
    );
    expect(html).toBe(
      '<p>&lt;script&gt; <em><a href="https://x.org/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Читать</a></em> <img src="/files/f1/c.png" alt="Обложка"> день 2026-05-01 [[Нет такого]]</p><p>Иван &lt;b&gt; · 1 мая <a href="/r/1">Подробнее</a> </p>',
    );
  });

  it('has a template for each field when the teacher wrote none', () => {
    expect(defaultTemplate(fields.slice(0, 1), 'list')).toBe(
      '<p><strong>Автор:</strong> [[Автор]]</p><p>##more##</p>',
    );
  });
});
