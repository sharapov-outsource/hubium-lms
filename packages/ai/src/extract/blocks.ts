import { tidy } from './xml.ts';

// Collects the text of an office document as blocks: paragraphs, headings ("## Title", which
// the chunker turns into section paths) and table rows ("cell | cell"). Paragraphs may nest
// (text boxes, footnotes) and tables may nest; inner content becomes blocks of its own or,
// inside a table cell, part of the cell.

interface Para {
  text: string;
  level: number;
  list: boolean;
}

export class BlockWriter {
  readonly blocks: string[] = [];
  private paras: Para[] = [];
  private rows: string[][] = [];
  private cells: string[][] = [];

  get inParagraph() {
    return this.paras.length > 0;
  }

  openParagraph() {
    this.paras.push({ text: '', level: 0, list: false });
  }

  /** Marks the open paragraph as a heading of this level (1–6). */
  heading(level: number) {
    const p = this.paras.at(-1);
    if (p && level >= 1) p.level = Math.min(level, 6);
  }

  listItem() {
    const p = this.paras.at(-1);
    if (p) p.list = true;
  }

  text(s: string) {
    const p = this.paras.at(-1);
    if (p) p.text += s;
  }

  closeParagraph() {
    const p = this.paras.pop();
    if (!p) return;
    const text = tidy(p.text);
    if (!text) return;
    if (this.cells.length) {
      const cell = this.cells.at(-1)!;
      cell.push(text.replace(/\n/g, ' '));
    } else if (p.level) {
      this.blocks.push(`${'#'.repeat(p.level)} ${text.replace(/\n/g, ' ')}`);
    } else {
      this.blocks.push(p.list ? `- ${text}` : text);
    }
  }

  openRow() {
    this.rows.push([]);
  }

  openCell() {
    this.cells.push([]);
  }

  closeCell() {
    const cell = this.cells.pop();
    const row = this.rows.at(-1);
    if (cell && row) row.push(cell.join(' '));
  }

  closeRow() {
    const row = this.rows.pop();
    if (!row) return;
    const line = row.filter(Boolean).join(' | ');
    if (!line) return;
    // A row of a nested table stays inside the outer cell.
    if (this.cells.length) this.cells.at(-1)!.push(line);
    else this.blocks.push(line);
  }

  toString() {
    return this.blocks.join('\n\n');
  }
}
