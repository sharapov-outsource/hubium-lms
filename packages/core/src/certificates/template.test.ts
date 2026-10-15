import { crc32, deflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { newCertificateCode, normalizeCertificateCode } from './certificates.ts';
import { renderCertificatePdf } from './pdf.ts';
import {
  CertificateFields,
  type CertificateValues,
  defaultFields,
  fieldText,
  wrapText,
} from './template.ts';

const values: CertificateValues = {
  name: 'Пётр Иванов',
  course: 'Основы программирования',
  date: '15 октября 2026 г.',
  grade: '95 %',
  code: 'ABCD-EFGH-JKMN',
  url: 'https://lms.example/verify/ABCD-EFGH-JKMN',
};

/** A 1×1 red PNG. */
function redPng(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('certificate templates', () => {
  it('prints values after their labels, and nothing for an empty value', () => {
    const [f] = CertificateFields.parse([{ kind: 'code', text: 'Код: ', x: 10, y: 10 }]);
    expect(fieldText(f!, values)).toBe('Код: ABCD-EFGH-JKMN');
    expect(fieldText(f!, { ...values, code: '' })).toBe('');
    const [t] = CertificateFields.parse([{ kind: 'text', text: 'Сертификат', x: 10, y: 10 }]);
    expect(fieldText(t!, values)).toBe('Сертификат');
  });

  it('wraps words at the width and keeps line breaks', () => {
    const width = (s: string) => s.length;
    expect(wrapText('один два три четыре', 9, width)).toEqual(['один два', 'три', 'четыре']);
    expect(wrapText('строка\nещё одна', 0, width)).toEqual(['строка', 'ещё одна']);
    // a word longer than a line stays whole
    expect(wrapText('сверхдлинноеслово да', 5, width)).toEqual(['сверхдлинноеслово', 'да']);
  });

  it('starts from a layout that fits the page, in the given language', () => {
    for (const o of ['landscape', 'portrait'] as const) {
      const fields = CertificateFields.parse(defaultFields(o, 'ru'));
      expect(fields.map((f) => f.kind)).toEqual(
        expect.arrayContaining(['name', 'course', 'date', 'code']),
      );
      expect(fields.find((f) => f.kind === 'text')?.text).toBe('Сертификат');
    }
    expect(defaultFields('landscape', 'en')[0]!.text).toBe('Certificate');
  });

  it('issues codes that are read back however they are typed', () => {
    const code = newCertificateCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeCertificateCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
    expect(normalizeCertificateCode('abcd-efgh-jkmo')).toBe('ABCD-EFGH-JKM0');
    expect(normalizeCertificateCode('ABCD-EFGH-JKMNU')).toBeNull();
    expect(normalizeCertificateCode('')).toBeNull();
  });

  it('draws an A4 PDF with Cyrillic text and the background', async () => {
    const png = redPng();
    const bytes = await renderCertificatePdf({
      orientation: 'landscape',
      fields: CertificateFields.parse(defaultFields('landscape', 'ru')),
      values,
      background: png,
      title: 'Сертификат — Пётр Иванов',
      author: 'Hubium',
      createdAt: new Date('2026-10-15T10:00:00Z'),
    });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([842, 595]);
    expect(doc.getTitle()).toBe('Сертификат — Пётр Иванов');
    // both faces embedded, and the picture
    const objects = doc.context.enumerateIndirectObjects().map(([, o]) => o);
    const dictOf = (o: unknown) =>
      o instanceof PDFDict ? o : o instanceof PDFRawStream ? o.dict : null;
    expect(objects.filter((o) => dictOf(o)?.get(PDFName.of('FontFile2')))).toHaveLength(2);
    expect(
      objects.filter((o) => dictOf(o)?.get(PDFName.of('Subtype')) === PDFName.of('Image')),
    ).toHaveLength(1);
  });
});
