import type { AutoLink } from '@hubium/module-sdk';
import { describe, expect, it } from 'vitest';
import { findLink, linkTerms } from './auto-links';

const link = (words: string[], o: Partial<AutoLink> = {}): AutoLink => ({
  words,
  url: `/g?entry=${words[0]}`,
  title: words[0]!,
  caseSensitive: false,
  fullMatch: true,
  ...o,
});
const first = (text: string, links: AutoLink[], used: string[] = []) => {
  const r = findLink(text, linkTerms(links), new Set(used));
  return r ? text.slice(r.start, r.end) : null;
};

describe('glossary auto-links', () => {
  it('finds whole words in any case, letters of any alphabet included', () => {
    expect(first('Про Энтропию и энтропия', [link(['энтропия'])])).toBe('энтропия');
    expect(first('Entropy grows.', [link(['entropy'])])).toBe('Entropy');
    expect(first('entropyX', [link(['entropy'])])).toBeNull();
    expect(first('Ölwechsel und Öl', [link(['Öl'])])).toBe('Öl');
    expect(first('x Öl', [link(['Öl'])])).toBe('Öl');
  });

  it('finds parts of words when whole words are not asked for', () => {
    expect(first('Thermodynamics', [link(['dynamic'], { fullMatch: false })])).toBe('dynamic');
  });

  it('keeps case when asked', () => {
    expect(first('a pH of 7, PH', [link(['PH'], { caseSensitive: true })])).toBe('PH');
    expect(first('a ph value', [link(['PH'], { caseSensitive: true })])).toBeNull();
  });

  it('links the earliest place, and the longest word that starts there', () => {
    const links = [link(['machine']), link(['machine learning']), link(['data'])];
    expect(first('data for machine learning', links)).toBe('data');
    expect(first('Machine learning on data', links)).toBe('Machine learning');
  });

  it('matches other forms of the concept and skips pages linked already', () => {
    const links = [link(['matrix', 'matrices'])];
    expect(first('two matrices', links)).toBe('matrices');
    expect(first('two matrices', links, ['/g?entry=matrix'])).toBeNull();
  });

  it('takes words with signs in them literally', () => {
    expect(first('in C++ and C', [link(['C++'], { caseSensitive: true })])).toBe('C++');
    expect(first('a.b axb', [link(['a.b'])])).toBe('a.b');
    expect(first('axb', [link(['a.b'])])).toBeNull();
  });
});
