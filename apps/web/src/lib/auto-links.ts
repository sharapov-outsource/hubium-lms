import type { AutoLink } from '@hubium/module-sdk';

/** One word of an auto-link with its matcher. */
export interface LinkTerm {
  word: string;
  url: string;
  title: string;
  re: RegExp;
}

const WORD = '[\\p{L}\\p{N}_]';
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matchers for every word of the links, longest first so "machine learning" beats "machine". */
export function linkTerms(links: AutoLink[]): LinkTerm[] {
  const out: LinkTerm[] = [];
  for (const l of links)
    for (const word of new Set(l.words.map((w) => w.trim()).filter(Boolean))) {
      const body = literal(word);
      out.push({
        word,
        url: l.url,
        title: l.title,
        re: new RegExp(
          l.fullMatch ? `(?<!${WORD})${body}(?!${WORD})` : body,
          l.caseSensitive ? 'u' : 'iu',
        ),
      });
    }
  return out.sort((a, b) => b.word.length - a.word.length);
}

/**
 * The earliest place in `text` where a term links to a page not linked yet (the longest
 * term when several start there).
 */
export function findLink(
  text: string,
  terms: LinkTerm[],
  used: ReadonlySet<string>,
): { start: number; end: number; term: LinkTerm } | null {
  let best: { start: number; end: number; term: LinkTerm } | null = null;
  for (const term of terms) {
    if (used.has(term.url)) continue;
    const m = term.re.exec(text);
    if (m && (!best || m.index < best.start))
      best = { start: m.index, end: m.index + m[0].length, term };
  }
  return best;
}
