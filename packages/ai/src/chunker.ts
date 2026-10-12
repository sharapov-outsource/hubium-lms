import { estimateTokens } from './mock.ts';

// Heading-aware chunking for retrieval: sections split on headings, long sections split on
// paragraph boundaries into ~500-token chunks with a small overlap; every chunk carries the
// heading path so it reads on its own.

export interface Chunk {
  index: number;
  heading: string;
  text: string;
  tokenCount: number;
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** HTML → plain text with Markdown-style headings preserved. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, l: string, t: string) => `\n\n${'#'.repeat(Number(l))} ${t}\n\n`,
    )
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number; title?: string } = {},
): Chunk[] {
  const max = opts.maxTokens ?? 500;
  const overlap = opts.overlapTokens ?? 50;
  const sections: { heading: string; paras: string[] }[] = [];
  const path: string[] = [];
  let cur = { heading: opts.title ?? '', paras: [] as string[] };
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^(#{1,6})\s+(.+)$/);
    if (h && !b.includes('\n')) {
      if (cur.paras.length) sections.push(cur);
      path.length = Math.min(path.length, h[1]!.length - 1);
      path[h[1]!.length - 1] = h[2]!.trim();
      cur = {
        heading: [opts.title, ...path.filter(Boolean)].filter(Boolean).join(' › '),
        paras: [],
      };
      continue;
    }
    cur.paras.push(b);
  }
  if (cur.paras.length) sections.push(cur);

  const chunks: Chunk[] = [];
  const push = (heading: string, body: string) =>
    chunks.push({
      index: chunks.length,
      heading,
      text: body,
      tokenCount: estimateTokens(body),
    });
  for (const s of sections) {
    let buf = '';
    for (const p of s.paras.flatMap((p) => splitLong(p, max))) {
      if (buf && estimateTokens(buf) + estimateTokens(p) > max) {
        push(s.heading, buf);
        buf = tail(buf, overlap);
      }
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    if (buf.trim()) push(s.heading, buf);
  }
  return chunks;
}

function splitLong(p: string, max: number): string[] {
  if (estimateTokens(p) <= max) return [p];
  const out: string[] = [];
  let buf = '';
  for (const s of p.split(/(?<=[.!?…])\s+/)) {
    if (buf && estimateTokens(buf + s) > max) {
      out.push(buf.trim());
      buf = '';
    }
    buf += `${s} `;
    while (estimateTokens(buf) > max) {
      out.push(buf.slice(0, max * 4));
      buf = buf.slice(max * 4);
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function tail(s: string, tokens: number): string {
  if (tokens <= 0) return '';
  const t = s.slice(-tokens * 4);
  const cut = t.search(/\s/);
  return cut > 0 ? t.slice(cut + 1) : t;
}
