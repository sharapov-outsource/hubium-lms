import { createTranslator } from '@hubium/i18n/packs';
import { z } from 'zod';

// A certificate template: an A4 page, landscape or portrait, with a background picture
// and text fields placed by coordinates. Pure: values come filled in from elsewhere.

export const ORIENTATIONS = ['landscape', 'portrait'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/** Page size in millimetres. */
export const PAGE_MM: Record<Orientation, [number, number]> = {
  landscape: [297, 210],
  portrait: [210, 297],
};

/** What a field prints: its own text, or a value of the issue after the text as a label. */
export const FIELD_KINDS = ['text', 'name', 'course', 'date', 'grade', 'code', 'url'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

const mm = z.coerce.number().min(0).max(297);

export const CertificateField = z.object({
  kind: z.enum(FIELD_KINDS),
  /** The text of a text field; the label before the value of the others. */
  text: z.string().max(500).default(''),
  /** From the left edge to the anchor (left end, middle or right end, as aligned). */
  x: mm,
  /** From the top edge to the top of the first line. */
  y: mm,
  /** Points. */
  size: z.coerce.number().min(4).max(144).default(14),
  /** Lines wrap at this width; 0: they do not. */
  width: mm.default(0),
  align: z.enum(['left', 'center', 'right']).default('left'),
  bold: z.boolean().default(false),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#000000'),
});
export type CertificateFieldT = z.infer<typeof CertificateField>;

export const CertificateFields = z.array(CertificateField).max(30);

/** The values an issue fills in, formatted. */
export type CertificateValues = Record<Exclude<FieldKind, 'text'>, string>;

/** What a field prints for an issue; empty when it has nothing to say. */
export function fieldText(f: CertificateFieldT, values: CertificateValues): string {
  if (f.kind === 'text') return f.text;
  const value = values[f.kind];
  return value ? `${f.text}${value}` : '';
}

/**
 * Breaks text into lines no wider than `max` (by `width`); words longer than a line stay
 * whole. Line breaks in the text are kept.
 */
export function wrapText(text: string, max: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!max) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next) > max) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A sensible first layout, in the given language: title, recipient, course, date, code. */
export function defaultFields(orientation: Orientation, locale: string): CertificateFieldT[] {
  const t = createTranslator(locale);
  const [w, h] = PAGE_MM[orientation];
  const mid = w / 2;
  const top = orientation === 'landscape' ? 35 : 60;
  const base = { width: 0, align: 'center', bold: false, color: '#1f2937' } as const;
  return [
    {
      ...base,
      kind: 'text',
      text: t('certificates.defaults.title'),
      x: mid,
      y: top,
      size: 40,
      bold: true,
    },
    {
      ...base,
      kind: 'text',
      text: t('certificates.defaults.intro'),
      x: mid,
      y: top + 35,
      size: 14,
    },
    { ...base, kind: 'name', text: '', x: mid, y: top + 48, size: 30, bold: true },
    {
      ...base,
      kind: 'text',
      text: t('certificates.defaults.completed'),
      x: mid,
      y: top + 72,
      size: 14,
    },
    { ...base, kind: 'course', text: '', x: mid, y: top + 84, size: 20, bold: true, width: w - 60 },
    {
      ...base,
      kind: 'date',
      text: t('certificates.defaults.date'),
      x: 25,
      y: h - 30,
      size: 11,
      align: 'left',
    },
    {
      ...base,
      kind: 'code',
      text: t('certificates.defaults.code'),
      x: w - 25,
      y: h - 30,
      size: 11,
      align: 'right',
    },
    {
      ...base,
      kind: 'url',
      text: '',
      x: w - 25,
      y: h - 23,
      size: 8,
      align: 'right',
      color: '#6b7280',
    },
  ];
}
