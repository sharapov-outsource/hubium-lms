// Wiki text without the database: links between pages written as [[Title]] or
// [[Title|shown text]], and the difference between two versions of a page. Pure, so
// the page, its history and the tests share them.

const LINK = /\[\[([^\]|<>\n]{1,255})(?:\|([^\]<>\n]{1,255}))?\]\]/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** A title as pages are matched by: trimmed, single spaces. */
export const normTitle = (t: string) => decode(t).trim().replace(/\s+/g, ' ');

/** The titles a page's HTML links to, in order, once each. */
export function linkedTitles(html: string): string[] {
  const out = new Set<string>();
  for (const part of html.split(/(<[^>]*>)/))
    if (!part.startsWith('<')) for (const m of part.matchAll(LINK)) out.add(normTitle(m[1]!));
  return [...out].filter(Boolean);
}

/**
 * Turns [[Title]] in the text of a page's HTML into links: to the page when it exists,
 * otherwise to creating it (marked data-new). Text inside links and code stays.
 */
export function renderLinks(
  html: string,
  href: (title: string) => { url: string; exists: boolean },
): string {
  let skip = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<(a|code|pre)\b/i.test(part)) skip++;
        else if (/^<\/(a|code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
        return part;
      }
      if (skip) return part;
      return part.replace(LINK, (whole, rawTitle: string, rawShown?: string) => {
        const title = normTitle(rawTitle);
        if (!title) return whole;
        const { url, exists } = href(title);
        const shown = rawShown ? normTitle(rawShown) : title;
        return `<a href="${escapeHtml(url)}"${exists ? '' : ' data-new=""'}>${escapeHtml(shown)}</a>`;
      });
    })
    .join('');
}

/** The text of a page's HTML, a line per paragraph (what versions are compared by). */
export function htmlLines(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr|div)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

/** Words and the spaces between them, so a diff keeps the text as it was. */
const tokens = (s: string): string[] => [...(s.match(/\s+|[^\s]+/g) ?? [])];

/**
 * What changed from one text to another, word by word (a longest common subsequence).
 * Very long texts are compared line by line instead.
 */
export function diffText(before: string, after: string): DiffPart[] {
  let a = tokens(before);
  let b = tokens(after);
  if (a.length * b.length > 4_000_000) {
    a = before.split(/(?<=\n)/);
    b = after.split(/(?<=\n)/);
  }
  // trim the common start and end: most edits touch a small part
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else if (text) parts.push({ kind, text });
  };
  push('same', a.slice(0, start).join(''));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      push('same', midA[i]!);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) push('added', midB[j++]!);
    else push('removed', midA[i++]!);
  }
  push('same', a.slice(endA).join(''));
  return parts;
}
