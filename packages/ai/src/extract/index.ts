import { unzipSync } from 'fflate';
import { htmlToText } from '../chunker.ts';
import { docxText, odfText, pptxSlideText } from './office.ts';
import { pdfText } from './pdf.ts';

// Plain text of uploaded documents for search and the AI tutor. Files are untrusted: archives
// are unpacked only for the parts needed and within a size budget, and the output is capped.

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'odt' | 'odp' | 'text' | 'html';

const BY_EXTENSION: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  odt: 'odt',
  odp: 'odp',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  csv: 'text',
  html: 'html',
  htm: 'html',
};

const BY_MIME: Record<string, DocumentKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'text/html': 'html',
};

/** Which extractor reads this file, or null when it is not a supported document. */
export function documentKind(name: string, mimeType: string): DocumentKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (
    (ext && BY_EXTENSION[ext]) || BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()] || null
  );
}

export interface ExtractLimits {
  /** Characters kept per document. */
  maxChars: number;
  /** PDF pages read. */
  maxPages: number;
  /** Uncompressed bytes read from an office archive. */
  maxXmlBytes: number;
}

export const EXTRACT_LIMITS: ExtractLimits = {
  maxChars: 200_000,
  maxPages: 500,
  maxXmlBytes: 64 * 1024 * 1024,
};

export interface DocumentText {
  text: string;
  /** Pages or characters beyond the limits were left out. */
  truncated: boolean;
}

const utf8 = new TextDecoder();

/** UTF-8 (with or without BOM); legacy Windows-1251 text when the bytes are not UTF-8. */
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1251').decode(data);
  }
}

/** Unpacks the entries `want` accepts; sizes come from the headers and bound the buffers. */
function unzipParts(
  data: Uint8Array,
  want: (name: string) => boolean,
  limits: ExtractLimits,
): Record<string, string> {
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('Not a ZIP-based document');
  let total = 0;
  const files = unzipSync(data, {
    filter(f) {
      if (!want(f.name)) return false;
      total += Math.max(f.size, f.originalSize);
      if (total > limits.maxXmlBytes) throw new Error('Document is too large to read');
      return true;
    },
  });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, utf8.decode(v)]));
}

const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function cap(text: string, maxChars: number): DocumentText {
  // PostgreSQL text cannot hold NUL characters.
  const clean = text.replaceAll(String.fromCharCode(0), '').trim();
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  const cut = clean.lastIndexOf('\n\n', maxChars);
  return { text: clean.slice(0, cut > maxChars / 2 ? cut : maxChars).trim(), truncated: true };
}

/**
 * Extracts the text of a document; null when the type is not supported. Throws on damaged
 * or oversized files.
 */
export async function extractDocumentText(
  data: Uint8Array,
  file: { name: string; mimeType: string },
  limits: ExtractLimits = EXTRACT_LIMITS,
): Promise<DocumentText | null> {
  const kind = documentKind(file.name, file.mimeType);
  switch (kind) {
    case 'pdf': {
      const r = await pdfText(data, limits.maxPages);
      const capped = cap(r.text, limits.maxChars);
      return { text: capped.text, truncated: r.truncated || capped.truncated };
    }
    case 'docx': {
      const parts = unzipParts(
        data,
        (n) => n === 'word/document.xml' || n === 'word/styles.xml',
        limits,
      );
      if (!parts['word/document.xml']) throw new Error('Not a Word document');
      return cap(docxText(parts['word/document.xml'], parts['word/styles.xml']), limits.maxChars);
    }
    case 'pptx': {
      const parts = unzipParts(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), limits);
      const slides = Object.keys(parts).sort((a, b) => slideNumber(a) - slideNumber(b));
      if (!slides.length) throw new Error('Not a PowerPoint presentation');
      return cap(slides.map((n) => pptxSlideText(parts[n]!)).join('\n\n'), limits.maxChars);
    }
    case 'odt':
    case 'odp': {
      const parts = unzipParts(data, (n) => n === 'content.xml', limits);
      if (!parts['content.xml']) throw new Error('Not an OpenDocument file');
      return cap(odfText(parts['content.xml']), limits.maxChars);
    }
    case 'text':
      return cap(decodeText(data.subarray(0, limits.maxChars * 4)), limits.maxChars);
    case 'html':
      return cap(htmlToText(decodeText(data.subarray(0, limits.maxChars * 8))), limits.maxChars);
    default:
      return null;
  }
}
