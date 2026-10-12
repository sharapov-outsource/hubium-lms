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

/** Converts a public video URL to an embeddable player URL, or null if unsupported. */
export function toEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^m\./, '');
  if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
  if (host.endsWith('youtube.com')) {
    const id =
      u.searchParams.get('v') ??
      (u.pathname.startsWith('/embed/') ? u.pathname.split('/')[2] : null);
    if (u.pathname.startsWith('/shorts/'))
      return `https://www.youtube-nocookie.com/embed/${u.pathname.split('/')[2]}`;
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'rutube.ru') {
    const m =
      /\/video\/([0-9a-f]{32})/.exec(u.pathname) ??
      /\/play\/embed\/([0-9a-f]{32})/.exec(u.pathname);
    return m ? `https://rutube.ru/play/embed/${m[1]}` : null;
  }
  if (host === 'vk.com' || host === 'vkvideo.ru') {
    const m = /video(-?\d+)_(\d+)/.exec(u.pathname + u.search);
    return m ? `https://vkvideo.ru/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2` : null;
  }
  if (host === 'vimeo.com') {
    const m = /^\/(\d+)/.exec(u.pathname);
    return m ? `https://player.vimeo.com/video/${m[1]}` : null;
  }
  return null;
}

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
      div: ['data-embed'],
      span: ['class'],
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
