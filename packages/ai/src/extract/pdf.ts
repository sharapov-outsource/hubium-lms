// PDF text through pdf.js (unpdf ships a server build without a worker thread). Line breaks inside
// a paragraph are joined, words split by a line-end hyphen are rejoined, and pages and
// paragraphs (wide vertical gaps) become blocks. Scanned pages have no text layer.

interface TextItem {
  str?: string;
  hasEOL?: boolean;
  /** [a, b, c, d, x, y]: y grows upwards. */
  transform?: number[];
  height?: number;
}

/**
 * The text of one page. pdf.js marks line ends but not paragraphs; a paragraph starts where
 * the gap to the previous line is clearly wider than the line height (a blank line).
 */
export function pageText(items: TextItem[]): string {
  let out = '';
  let lineY: number | null = null;
  let lineHeight = 0;
  let newLine = true;
  for (const it of items) {
    const y = it.transform?.[5];
    if (newLine && y !== undefined && (it.str ?? '').trim()) {
      if (lineY !== null && lineHeight > 0 && lineY - y > lineHeight * 1.8) out += '\n';
      lineY = y;
      lineHeight = it.height || lineHeight;
      newLine = false;
    }
    out += it.str ?? '';
    if (it.hasEOL) {
      out += '\n';
      newLine = true;
    }
  }
  return out
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export async function pdfText(
  data: Uint8Array,
  maxPages: number,
): Promise<{ text: string; truncated: boolean }> {
  const { getDocumentProxy } = await import('unpdf');
  // pdf.js takes ownership of the buffer it is given; keep the caller's intact.
  // Only the text layer is read: no fonts, image decoders (WebAssembly), XFA forms or canvas.
  const pdf = await getDocumentProxy(new Uint8Array(data), {
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    // Font data only matters for rendering; keep pdf.js from logging that it is missing.
    verbosity: 0,
  });
  try {
    const pages = Math.min(pdf.numPages, maxPages);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(pageText(content.items as TextItem[]));
      page.cleanup();
    }
    return { text: parts.filter(Boolean).join('\n\n'), truncated: pdf.numPages > maxPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
