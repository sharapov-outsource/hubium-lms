import type { ReactNode } from 'react';

/** A letter without its accent (é → e, ü → u, ё → е) when that is still one letter. */
const fold = (ch: string) => {
  const bare = ch.normalize('NFD').replace(/\p{M}/gu, '');
  return bare.length === 1 ? bare : ch;
};

/** Lower case without accents, spaces, underscores and slashes alike; keeps the length. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\x20-\x7e\s]/g, fold)
    .replace(/[\s_/]/g, ' ');
}

const query = (search: string) => normalizeSearch(search).trim().replace(/ +/g, ' ');

/**
 * How well `search` matches an option, for list filters: 0 hides it. The whole query found
 * in `main` ranks first (at the start of a word above the middle), then every word of the
 * query found somewhere in `main`, then words found only in `extra` (keywords, aliases).
 */
export function matchScore(search: string, main: string, extra = ''): number {
  const q = query(search);
  if (!q) return 1;
  const m = normalizeSearch(main);
  const at = m.indexOf(q);
  if (at === 0 || (at > 0 && m[at - 1] === ' ')) return 1;
  if (at > 0) return 0.9;
  const words = q.split(' ');
  if (words.every((w) => m.includes(w))) return 0.7;
  const all = `${m} ${normalizeSearch(extra)}`;
  return words.every((w) => all.includes(w)) ? 0.4 : 0;
}

/** `text` with the parts that match `search` marked, as the filter above finds them. */
export function Highlight({ text, search }: { text: string; search: string }): ReactNode {
  const q = query(search);
  const m = normalizeSearch(text);
  // Positions carry over to the original text only while lower-casing keeps the length.
  if (!q || m.length !== text.length) return text;
  const words = m.includes(q) ? [q] : q.split(' ');
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = m.indexOf(w); at !== -1 && w; at = m.indexOf(w, at + w.length)) {
      marked.fill(true, at, at + w.length);
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && marked[i] === marked[start]) continue;
    const part = text.slice(start, i);
    parts.push(
      marked[start] ? (
        <mark key={start} className="rounded-sm bg-accent-soft font-medium text-foreground">
          {part}
        </mark>
      ) : (
        part
      ),
    );
    start = i;
  }
  return parts;
}
