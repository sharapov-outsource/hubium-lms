import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Highlight, matchScore } from './lib/search.tsx';

describe('list search', () => {
  it('finds the query anywhere in the label, ignoring case and ё', () => {
    expect(matchScore('нач', 'Python для начинающих')).toBeGreaterThan(0);
    expect(matchScore('ИНАЮ', 'Python для начинающих')).toBeGreaterThan(0);
    expect(matchScore('ежик', 'Ёжик в тумане')).toBeGreaterThan(0);
    expect(matchScore('java', 'Python для начинающих')).toBe(0);
  });

  it('ignores accents: élève, Übung and their plain spellings find each other', () => {
    expect(matchScore('eleve', 'Élève de première')).toBeGreaterThan(0);
    expect(matchScore('übung', 'Ubungen')).toBeGreaterThan(0);
    expect(matchScore('citta', 'La città di Roma')).toBeGreaterThan(0);
  });

  it('ranks a word start above the middle, and both above scattered words', () => {
    const start = matchScore('для', 'Python для начинающих');
    const middle = matchScore('ля', 'Python для начинающих');
    const words = matchScore('начин python', 'Python для начинающих');
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(0);
  });

  it('counts keywords for less than the label', () => {
    const label = matchScore('моск', 'Москва');
    const keyword = matchScore('моск', 'Europe/Moscow', 'Москва, стандартное время');
    expect(keyword).toBeGreaterThan(0);
    expect(label).toBeGreaterThan(keyword);
  });

  it('treats an empty query as a match and slashes or underscores as spaces', () => {
    expect(matchScore('  ', 'anything')).toBe(1);
    expect(matchScore('new york', 'America/New_York')).toBe(1);
  });

  it('marks every occurrence of the query in the label', () => {
    const parts = Highlight({ text: 'Анна и Аннушка', search: 'анн' }) as (
      | string
      | ReactElement<{ children: string }>
    )[];
    const marked = parts
      .filter((p): p is ReactElement<{ children: string }> => isValidElement(p))
      .map((p) => p.props.children);
    expect(marked).toEqual(['Анн', 'Анн']);
    expect(Highlight({ text: 'Анна', search: '' })).toBe('Анна');
  });
});
