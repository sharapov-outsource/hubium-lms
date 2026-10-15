import sanitize from 'sanitize-html';

// Server-side rich text handling. The editor produces HTML; we sanitise on every write
// (defence in depth: never trust the client) and extract plain text for search and AI.

export const EMBED_HOSTS = [
  'www.youtube-nocookie.com',
  'www.youtube.com',
  'rutube.ru',
  'vk.com',
  'vkvideo.ru',
  'player.vimeo.com',
];

export { toEmbedUrl } from './embed.ts';

export function sanitizeRichText(html: string): string {
  return sanitize(html ?? '', {
    allowedTags: [
      'p',
      'br',
      'hr',
      'h2',
      'h3',
      'h4',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'code',
      'pre',
      'blockquote',
      'ul',
      'ol',
      'li',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'colgroup',
      'col',
      'span',
      'sub',
      'sup',
      'mark',
      'iframe',
      'figure',
      'figcaption',
      'div',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'title', 'loading'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      col: ['style'],
      // formulas (Tiptap mathematics): the LaTeX source, rendered by KaTeX on display
      div: [
        'data-embed',
        { name: 'data-type', multiple: false, values: ['block-math'] },
        'data-latex',
      ],
      span: [
        'class',
        { name: 'data-type', multiple: false, values: ['inline-math'] },
        'data-latex',
      ],
    },
    allowedClasses: { span: ['math'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'http', 'data'] },
    allowedIframeHostnames: EMBED_HOSTS,
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer nofollow',
          ...(attribs.target ? { target: '_blank' } : {}),
        },
      }),
      iframe: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, loading: 'lazy', allowfullscreen: 'true' },
      }),
      b: 'strong',
      i: 'em',
    },
    exclusiveFilter: (frame) =>
      frame.tag === 'img' &&
      /^data:/.test(frame.attribs.src ?? '') &&
      !/^data:image\/(png|jpeg|gif|webp);/.test(frame.attribs.src ?? ''),
  });
}

/** Plain text for search indexes, previews, notifications and AI chunking. */
export function extractText(html: string): string {
  return sanitize(
    (html ?? '')
      // formulas keep their LaTeX, so search and the AI tutor see them
      .replace(/<(span|div)\b[^>]*\bdata-latex="([^"]*)"[^>]*>\s*<\/\1>/gi, (_, tag, latex) =>
        tag.toLowerCase() === 'div' ? `\n${latex}\n` : ` ${latex} `,
      )
      .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre|div)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n'),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function excerpt(html: string, max = 200): string {
  const t = extractText(html).replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function isEmptyRichText(html: string | null | undefined): boolean {
  return !html || (extractText(html) === '' && !/<(img|iframe)/i.test(html));
}
