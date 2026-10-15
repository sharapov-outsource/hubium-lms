// A database's fields and values without the database: checking what a form sends for
// each kind of field, the text of a value (search, sorting, CSV), and entries shown
// through the teacher's templates, where [[Field]] stands for a field's value. Pure, so
// the server, the pages and the tests share them.

export const fieldTypes = [
  'text',
  'textarea',
  'number',
  'date',
  'menu',
  'radio',
  'checkbox',
  'url',
  'file',
  'image',
] as const;
export type FieldType = (typeof fieldTypes)[number];
export const fileTypes: readonly FieldType[] = ['file', 'image'];
export const choiceTypes: readonly FieldType[] = ['menu', 'radio', 'checkbox'];

export interface Field {
  id: string;
  type: FieldType;
  name: string;
  description: string;
  required: boolean;
  options: { choices?: string[]; linkText?: string };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** A number as people write it ("3,5" too); NaN otherwise. */
export function readNumber(text: string): number {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : Number.NaN;
}

const isDay = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export type Checked = { value: string } | { error: 'required' | 'invalid' | 'tooLong' };

/**
 * A value from a form or a CSV cell, checked and in its stored form. Text areas are
 * sanitised by `sanitize`; files are stored apart and never pass here.
 */
export function cleanValue(f: Field, raw: unknown, sanitize: (html: string) => string): Checked {
  const list = Array.isArray(raw) ? raw.map(String) : null;
  const text = list ? list.join('\n') : raw === null || raw === undefined ? '' : String(raw);
  const empty = f.type === 'textarea' ? !stripTags(text) && !/<img/i.test(text) : !text.trim();
  if (empty) return f.required ? { error: 'required' } : { value: '' };
  const choices = f.options.choices ?? [];
  switch (f.type) {
    case 'text':
      return text.trim().length > 1000 ? { error: 'tooLong' } : { value: text.trim() };
    case 'textarea':
      return text.length > 100_000 ? { error: 'tooLong' } : { value: sanitize(text) };
    case 'number': {
      const n = readNumber(text);
      return Number.isFinite(n) ? { value: String(n) } : { error: 'invalid' };
    }
    case 'date':
      return isDay(text.trim()) ? { value: text.trim() } : { error: 'invalid' };
    case 'menu':
    case 'radio':
      return choices.includes(text.trim()) ? { value: text.trim() } : { error: 'invalid' };
    case 'checkbox': {
      const picked = (list ?? text.split(/\r?\n|;/)).map((x) => x.trim()).filter(Boolean);
      if (!picked.every((x) => choices.includes(x))) return { error: 'invalid' };
      // in the order of the choices, once each
      return { value: choices.filter((c) => picked.includes(c)).join('\n') };
    }
    case 'url': {
      const u = text.trim();
      try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol) || u.length > 2000) return { error: 'invalid' };
        return { value: u };
      } catch {
        return { error: 'invalid' };
      }
    }
    default:
      return { error: 'invalid' };
  }
}

export interface FileRef {
  url: string;
  name: string;
}

/** A value as plain text: for search, sorting and CSV. */
export function valueText(f: Field, v: string, file?: (id: string) => FileRef | undefined): string {
  if (!v) return '';
  if (f.type === 'textarea') return stripTags(v);
  if (f.type === 'checkbox') return v.split('\n').join(', ');
  if (f.type === 'file' || f.type === 'image') return file?.(v)?.name ?? '';
  return v;
}

/** Orders two values of a field: numbers as numbers, the rest as text; empty last. */
export function compareValues(f: Field, a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  if (f.type === 'number') return Number(a) - Number(b);
  return a.localeCompare(b);
}

/** A value as HTML in a template: text escaped, links, files and pictures. */
export function valueHtml(
  f: Field,
  v: string,
  o: { date(day: string): string; file(id: string): FileRef | undefined },
): string {
  if (!v) return '';
  switch (f.type) {
    case 'textarea':
      return v;
    case 'date':
      return esc(o.date(v));
    case 'checkbox':
      return esc(v.split('\n').join(', '));
    case 'url':
      return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(f.options.linkText || v)}</a>`;
    case 'file': {
      const ref = o.file(v);
      return ref ? `<a href="${esc(ref.url)}">${esc(ref.name)}</a>` : '';
    }
    case 'image': {
      const ref = o.file(v);
      return ref ? `<img src="${esc(ref.url)}" alt="${esc(f.name)}">` : '';
    }
    default:
      return esc(v);
  }
}

/** The template used when the teacher has written none: each field with its name. */
export function defaultTemplate(fields: Field[], kind: 'list' | 'single'): string {
  return (
    fields.map((f) => `<p><strong>${esc(f.name)}:</strong> [[${esc(f.name)}]]</p>`).join('') +
    (kind === 'list' ? '<p>##more##</p>' : '')
  );
}

const webUrl = (v: string) => (/^(https?:\/\/|mailto:)/i.test(v.trim()) ? v.trim() : '');

/**
 * A value inside an attribute of the template's markup (Moodle's `<a href="##moreurl##">`,
 * `<img src="[[Photo]]">`): in href and src only a web address (a link field's, a file's,
 * or text that is one), elsewhere the value as text; always escaped.
 */
function attrValue(
  f: Field,
  v: string,
  url: boolean,
  file: (id: string) => FileRef | undefined,
): string {
  if (f.type === 'file' || f.type === 'image') {
    const ref = v ? file(v) : undefined;
    return esc(url ? (ref?.url ?? '') : (ref?.name ?? ''));
  }
  const text = valueText(f, v);
  return esc(url ? webUrl(text) : text);
}

/**
 * An entry through a template: [[Field]] is the field's value; ##user##, ##timeadded##,
 * ##timemodified##, ##more## (a link to the entry) and ##moreurl## (its address) are filled
 * in; other ##tags## of Moodle's templates are left out. In text the value is HTML; inside
 * a tag's attribute it is a safe, escaped value (attrValue); the markup itself stays.
 */
export function renderTemplate(
  template: string,
  fields: Field[],
  values: Record<string, string>,
  o: {
    user: string;
    added: string;
    modified: string;
    moreUrl: string;
    moreLabel: string;
    date(day: string): string;
    file(id: string): FileRef | undefined;
  },
): string {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const tags: Record<string, string> = {
    user: esc(o.user),
    timeadded: esc(o.added),
    timemodified: esc(o.modified),
    more: `<a href="${esc(o.moreUrl)}">${esc(o.moreLabel)}</a>`,
    moreurl: esc(o.moreUrl),
  };
  const inAttribute = (tag: string) =>
    tag.replace(
      /(\s[\w:-]+\s*=\s*)(["'])([^"']*)\2/g,
      (_all, name: string, quote: string, value: string) => {
        const url = /^\s(href|src)\s*=/i.test(name);
        const filled = value
          .replace(/\[\[([^\]<>]{1,255})\]\]/g, (whole, raw: string) => {
            const f = byName.get(raw.replace(/&amp;/g, '&').trim());
            return f ? attrValue(f, values[f.id] ?? '', url, o.file) : whole;
          })
          .replace(/##([a-z]+)##/gi, (_, t: string) => {
            const key = t.toLowerCase();
            if (key === 'moreurl') return esc(o.moreUrl);
            if (url) return '';
            return key === 'user'
              ? esc(o.user)
              : key === 'timeadded'
                ? esc(o.added)
                : key === 'timemodified'
                  ? esc(o.modified)
                  : '';
          });
        return `${name}${quote}${filled}${quote}`;
      },
    );
  return template
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith('<')
        ? inAttribute(part)
        : part
            .replace(/\[\[([^\]<>]{1,255})\]\]/g, (whole, raw: string) => {
              const f = byName.get(raw.replace(/&amp;/g, '&').trim());
              return f ? valueHtml(f, values[f.id] ?? '', o) : whole;
            })
            .replace(/##([a-z]+)##/gi, (_, tag: string) => tags[tag.toLowerCase()] ?? ''),
    )
    .join('');
}
