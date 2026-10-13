import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { samplePdf as pdf } from '../src/extract/fixtures.ts';
import { decodeText, documentKind, extractDocumentText } from '../src/extract/index.ts';
import { pageText } from '../src/extract/pdf.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const DOCX = zip({
  'word/styles.xml': `<w:styles ${W}>
    <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
    <w:style w:type="paragraph" w:styleId="a3"><w:name w:val="List Paragraph"/></w:style>
  </w:styles>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>Функции</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Функция объявляется </w:t></w:r><w:r><w:t>словом def &amp; вызывается</w:t></w:r><w:r><w:tab/><w:t>по имени.</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>аргументы</w:t></w:r></w:p>
    <w:p><w:r><w:delText>удалено</w:delText><w:instrText>PAGE</w:instrText></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>len</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>длина</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><mc:AlternateContent xmlns:mc="m"><mc:Choice><w:txbxContent><w:p><w:r><w:t>Врезка</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Врезка</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>
  </w:body></w:document>`,
});

const slide = (title: string, body: string) =>
  `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

const PPTX = zip({
  'ppt/slides/slide10.xml': slide('Итоги', 'Повторите циклы'),
  'ppt/slides/slide2.xml': slide('Циклы', 'for перебирает элементы'),
  'ppt/notesSlides/notesSlide2.xml': '<p:notes xmlns:a="a"><a:t>заметки докладчика</a:t></p:notes>',
});

const ODT = zip({
  'content.xml': `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>
    <text:h text:outline-level="2">Условия</text:h>
    <text:p>Оператор<text:s text:c="2"/>if <text:span>проверяет</text:span> условие<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Сноска</text:p></text:note-body></text:note>.</text:p>
    <office:annotation><text:p>комментарий рецензента</text:p></office:annotation>
    <text:list><text:list-item><text:p>elif</text:p></text:list-item></text:list>
    <table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body></office:document-content>`,
});

const ODP = zip({
  'content.xml': `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:draw="d" xmlns:presentation="p"><office:body><office:presentation>
    <draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Словари</text:p></draw:text-box></draw:frame>
    <draw:frame presentation:class="outline"><draw:text-box><text:p>Ключ и значение</text:p></draw:text-box></draw:frame>
    <presentation:notes><draw:frame><draw:text-box><text:p>не читать</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>
  </office:presentation></office:body></office:document-content>`,
});

const extract = (data: Uint8Array, name: string, mimeType = 'application/octet-stream') =>
  extractDocumentText(data, { name, mimeType });

describe('document text', () => {
  it('knows documents by extension or type', () => {
    expect(documentKind('Лекция.PDF', 'application/octet-stream')).toBe('pdf');
    expect(documentKind('file', 'application/vnd.oasis.opendocument.text')).toBe('odt');
    expect(documentKind('notes.md', '')).toBe('text');
    expect(documentKind('photo.jpg', 'image/jpeg')).toBeNull();
    expect(documentKind('old.doc', 'application/msword')).toBeNull();
  });

  it('reads Word: headings, lists, tables, one copy of text boxes, no deleted text', async () => {
    const r = await extract(DOCX, 'lecture.docx');
    expect(r?.text).toBe(
      [
        '# Функции',
        'Функция объявляется словом def & вызывается по имени.',
        '- аргументы',
        'len | длина',
        'Врезка',
      ].join('\n\n'),
    );
  });

  it('reads PowerPoint slides in order with titles as headings, without notes', async () => {
    const r = await extract(PPTX, 'slides.pptx');
    expect(r?.text).toBe('## Циклы\n\nfor перебирает элементы\n\n## Итоги\n\nПовторите циклы');
  });

  it('reads OpenDocument text and presentations', async () => {
    expect((await extract(ODT, 'a.odt'))?.text).toBe(
      ['## Условия', 'Сноска', 'Оператор if проверяет условие.', '- elif', 'a | b'].join('\n\n'),
    );
    expect((await extract(ODP, 'a.odp'))?.text).toBe('## Словари\n\nКлюч и значение');
  });

  it('reads the PDF text layer page by page and honours the page limit', async () => {
    const doc = pdf([['Hello PDF', 'second line'], ['Page two']]);
    expect((await extract(doc, 'a.pdf'))?.text).toBe('Hello PDF second line\n\nPage two');
    const one = await extractDocumentText(
      doc,
      { name: 'a.pdf', mimeType: 'application/pdf' },
      { maxChars: 1000, maxPages: 1, maxXmlBytes: 1e6 },
    );
    expect(one).toEqual({ text: 'Hello PDF second line', truncated: true });
  });

  it('joins wrapped PDF lines and hyphenated words', () => {
    expect(
      pageText([
        { str: 'Переменная хра-', hasEOL: true },
        { str: 'нит значение', hasEOL: true },
        { str: '', hasEOL: true },
        { str: 'Новый абзац', hasEOL: false },
      ]),
    ).toBe('Переменная хранит значение\n\nНовый абзац');
  });

  it('starts a paragraph after a blank line in the layout', () => {
    const line = (str: string, y: number) => ({
      str,
      hasEOL: true,
      transform: [1, 0, 0, 1, 72, y],
      height: 12,
    });
    expect(
      pageText([line('Первая строка', 700), line('вторая строка', 686), line('Новый абзац', 650)]),
    ).toBe('Первая строка вторая строка\n\nНовый абзац');
  });

  it('decodes UTF-8 and legacy Windows-1251 text, converts HTML', async () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeText(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBe('Привет');
    expect((await extract(strToU8('<h2>Тема</h2><p>текст</p>'), 'a.html'))?.text).toBe(
      '## Тема\n\nтекст',
    );
  });

  it('caps the text and refuses archives that expand beyond the budget', async () => {
    const long = strToU8(`${'а'.repeat(90)}\n\n${'б'.repeat(90)}`);
    expect(
      await extractDocumentText(
        long,
        { name: 'a.txt', mimeType: 'text/plain' },
        { maxChars: 100, maxPages: 1, maxXmlBytes: 1e6 },
      ),
    ).toEqual({ text: 'а'.repeat(90), truncated: true });
    const bomb = zip({
      'word/document.xml': `<w:document ${W}>${' '.repeat(2_000_000)}</w:document>`,
    });
    await expect(
      extractDocumentText(
        bomb,
        { name: 'a.docx', mimeType: '' },
        { maxChars: 100, maxPages: 1, maxXmlBytes: 1_000_000 },
      ),
    ).rejects.toThrow(/too large/);
    await expect(extract(strToU8('not a zip'), 'a.docx')).rejects.toThrow();
  });

  it('ignores files that are not documents', async () => {
    expect(await extract(new Uint8Array([1, 2, 3]), 'a.bin')).toBeNull();
  });
});
