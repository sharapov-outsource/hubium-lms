import { BlockWriter } from './blocks.ts';
import { attr, tidy, walkXml } from './xml.ts';

// Text of Office Open XML (DOCX, PPTX) and OpenDocument (ODT, ODP) files, read from the XML
// parts of the unpacked archive. Formatting, images, comments and speaker notes are left out.

/** Paragraph styles that are headings, from word/styles.xml (built-in names are English). */
function wordHeadingStyles(stylesXml: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!stylesXml) return out;
  let id: string | null = null;
  walkXml(stylesXml, {
    open(name, attrs) {
      if (name === 'w:style') {
        id = attr(attrs, 'w:type') === 'paragraph' ? attr(attrs, 'w:styleId') : null;
      } else if (name === 'w:name' && id) {
        const n = (attr(attrs, 'w:val') ?? '').toLowerCase();
        const m = /^heading ([1-6])$/.exec(n);
        if (m) out.set(id, Number(m[1]));
        else if (n === 'title') out.set(id, 1);
      }
    },
  });
  return out;
}

export function docxText(documentXml: string, stylesXml?: string): string {
  const headings = wordHeadingStyles(stylesXml);
  const w = new BlockWriter();
  let inText = 0;
  // Word stores text boxes twice: as DrawingML and as a VML fallback. Read the first only.
  let fallback = 0;
  walkXml(documentXml, {
    open(name, attrs) {
      if (name === 'mc:Fallback') fallback++;
      if (fallback) return;
      switch (name) {
        case 'w:p':
          w.openParagraph();
          break;
        case 'w:pStyle':
          w.heading(headings.get(attr(attrs, 'w:val') ?? '') ?? 0);
          break;
        case 'w:outlineLvl': {
          // 0–5 are heading levels; 9 means body text.
          const level = Number(attr(attrs, 'w:val'));
          if (level >= 0 && level <= 5) w.heading(level + 1);
          break;
        }
        case 'w:numPr':
          w.listItem();
          break;
        case 'w:t':
          inText++;
          break;
        case 'w:tab':
          w.text(' ');
          break;
        case 'w:br':
        case 'w:cr':
          w.text('\n');
          break;
        case 'w:tr':
          w.openRow();
          break;
        case 'w:tc':
          w.openCell();
          break;
      }
    },
    close(name) {
      if (name === 'mc:Fallback') fallback--;
      if (fallback) return;
      if (name === 'w:t') inText--;
      else if (name === 'w:p') w.closeParagraph();
      else if (name === 'w:tc') w.closeCell();
      else if (name === 'w:tr') w.closeRow();
    },
    text(s) {
      if (inText > 0 && !fallback) w.text(s);
    },
  });
  return w.toString();
}

/** One slide: its title becomes a heading, the other shapes' paragraphs follow. */
export function pptxSlideText(slideXml: string): string {
  const blocks: string[] = [];
  let shape: { title: boolean; paras: string[] } | null = null;
  let para: string | null = null;
  let inText = 0;
  const row: string[] = [];
  let cell: string[] | null = null;
  walkXml(slideXml, {
    open(name, attrs) {
      if (name === 'p:sp') shape = { title: false, paras: [] };
      else if (name === 'p:ph' && shape) {
        const type = attr(attrs, 'type');
        if (type === 'title' || type === 'ctrTitle') shape.title = true;
      } else if (name === 'a:p') para = '';
      else if (name === 'a:t') inText++;
      else if (name === 'a:br') para = para === null ? null : `${para}\n`;
      else if (name === 'a:tr') row.length = 0;
      else if (name === 'a:tc') cell = [];
    },
    close(name) {
      if (name === 'a:t') inText--;
      else if (name === 'a:p' && para !== null) {
        const text = tidy(para);
        para = null;
        if (!text) return;
        if (cell) cell.push(text);
        else if (shape) shape.paras.push(text);
        else blocks.push(text);
      } else if (name === 'a:tc' && cell) {
        row.push(cell.join(' '));
        cell = null;
      } else if (name === 'a:tr') {
        const line = row.filter(Boolean).join(' | ');
        if (line) blocks.push(line);
      } else if (name === 'p:sp' && shape) {
        const s: { title: boolean; paras: string[] } = shape;
        shape = null;
        if (!s.paras.length) return;
        if (s.title) blocks.push(`## ${s.paras.join(' ').replace(/\n/g, ' ')}`);
        else blocks.push(...s.paras);
      }
    },
    text(s) {
      if (inText > 0 && para !== null) para += s;
    },
  });
  return blocks.join('\n\n');
}

/** OpenDocument text (ODT) or presentation (ODP) content.xml. */
export function odfText(contentXml: string): string {
  const w = new BlockWriter();
  // Skipped subtrees: comments, speaker notes, footnote numbers.
  let skip = 0;
  const frames: boolean[] = [];
  let lists = 0;
  walkXml(contentXml, {
    open(name, attrs) {
      if (
        name === 'office:annotation' ||
        name === 'presentation:notes' ||
        name === 'text:note-citation'
      ) {
        skip++;
        return;
      }
      if (skip) return;
      switch (name) {
        case 'draw:frame':
          frames.push(attr(attrs, 'presentation:class') === 'title');
          break;
        case 'text:list-item':
          lists++;
          break;
        case 'text:h':
          w.openParagraph();
          w.heading(Number(attr(attrs, 'text:outline-level') ?? 1));
          break;
        case 'text:p':
          w.openParagraph();
          if (frames.at(-1)) w.heading(2);
          else if (lists) w.listItem();
          break;
        case 'text:s':
          w.text(' '.repeat(Math.min(Number(attr(attrs, 'text:c') ?? 1) || 1, 100)));
          break;
        case 'text:tab':
          w.text(' ');
          break;
        case 'text:line-break':
          w.text('\n');
          break;
        case 'table:table-row':
          w.openRow();
          break;
        case 'table:table-cell':
        case 'table:covered-table-cell':
          w.openCell();
          break;
      }
    },
    close(name) {
      if (
        name === 'office:annotation' ||
        name === 'presentation:notes' ||
        name === 'text:note-citation'
      ) {
        skip--;
        return;
      }
      if (skip) return;
      switch (name) {
        case 'draw:frame':
          frames.pop();
          break;
        case 'text:list-item':
          lists--;
          break;
        case 'text:h':
        case 'text:p':
          w.closeParagraph();
          break;
        case 'table:table-row':
          w.closeRow();
          break;
        case 'table:table-cell':
        case 'table:covered-table-cell':
          w.closeCell();
          break;
      }
    },
    text(s) {
      if (!skip && w.inParagraph) w.text(s);
    },
  });
  return w.toString();
}
