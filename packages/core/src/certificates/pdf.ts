import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, rgb } from 'pdf-lib';
import {
  type CertificateFieldT,
  type CertificateValues,
  fieldText,
  type Orientation,
  PAGE_MM,
  wrapText,
} from './template.ts';

// A certificate as a PDF: the background picture over the whole page, then the fields in
// Roboto (Cyrillic, Latin and Greek), embedded as subsets.

const PT_PER_MM = 72 / 25.4;
const LINE_HEIGHT = 1.2;

/** Locates the Roboto files of roboto-fontface (next.config.ts adds them to the trace). */
function fontDir(): string {
  try {
    const req = createRequire(import.meta.url);
    const dir = path.join(
      path.dirname(req.resolve('roboto-fontface/package.json')),
      'fonts',
      'roboto',
    );
    if (existsSync(path.join(dir, 'Roboto-Regular.woff'))) return dir;
  } catch {}
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const store = path.join(dir, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      const hit = readdirSync(store).find((d) => d.startsWith('roboto-fontface@'));
      if (hit) return path.join(store, hit, 'node_modules', 'roboto-fontface', 'fonts', 'roboto');
    }
    dir = path.dirname(dir);
  }
  throw new Error('The certificate font (roboto-fontface) is not installed');
}

const fonts = new Map<string, Promise<Buffer>>();
function fontBytes(name: 'Roboto-Regular.woff' | 'Roboto-Bold.woff'): Promise<Buffer> {
  let hit = fonts.get(name);
  if (!hit) {
    hit = readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ fontDir(), name));
    hit.catch(() => fonts.delete(name));
    fonts.set(name, hit);
  }
  return hit;
}

function color(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export interface CertificateDocument {
  orientation: Orientation;
  fields: CertificateFieldT[];
  values: CertificateValues;
  /** PNG or JPEG, stretched to cover the page. */
  background?: Uint8Array | null;
  title: string;
  author: string;
  createdAt: Date;
}

export async function renderCertificatePdf(d: CertificateDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([
    fontBytes('Roboto-Regular.woff').then((b) => doc.embedFont(b, { subset: true })),
    fontBytes('Roboto-Bold.woff').then((b) => doc.embedFont(b, { subset: true })),
  ]);
  const [wMm, hMm] = PAGE_MM[d.orientation];
  const pw = wMm * PT_PER_MM;
  const ph = hMm * PT_PER_MM;
  const page = doc.addPage([pw, ph]);

  if (d.background?.length) {
    const png = d.background[0] === 0x89;
    const img = png ? await doc.embedPng(d.background) : await doc.embedJpg(d.background);
    const scale = Math.max(pw / img.width, ph / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    page.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
  }

  for (const f of d.fields) {
    const text = fieldText(f, d.values);
    if (!text.trim()) continue;
    const font: PDFFont = f.bold ? bold : regular;
    const width = (s: string) => font.widthOfTextAtSize(s, f.size);
    const ascent = font.heightAtSize(f.size, { descender: false });
    const lines = wrapText(text, f.width * PT_PER_MM, width);
    lines.forEach((line, i) => {
      const lw = width(line);
      const anchor = f.x * PT_PER_MM;
      const x = f.align === 'center' ? anchor - lw / 2 : f.align === 'right' ? anchor - lw : anchor;
      const top = f.y * PT_PER_MM + i * f.size * LINE_HEIGHT;
      page.drawText(line, { x, y: ph - top - ascent, size: f.size, font, color: color(f.color) });
    });
  }

  doc.setTitle(d.title);
  doc.setAuthor(d.author);
  doc.setCreator('Hubium LMS');
  doc.setProducer('Hubium LMS');
  doc.setCreationDate(d.createdAt);
  doc.setModificationDate(d.createdAt);
  return doc.save();
}
