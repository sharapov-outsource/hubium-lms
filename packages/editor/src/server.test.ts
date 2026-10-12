import { describe, expect, it } from 'vitest';
import { excerpt, extractText, isEmptyRichText, sanitizeRichText, toEmbedUrl } from './server.ts';

describe('sanitizeRichText', () => {
  it('removes scripts, event handlers and javascript: links', () => {
    const out = sanitizeRichText(
      '<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>',
    );
    expect(out).not.toMatch(/script|onclick|javascript/);
    expect(out).toContain('<p>hi');
  });
  it('keeps formatting, tables and safe links with rel', () => {
    const out = sanitizeRichText(
      '<h2>T</h2><p><strong>b</strong> <a href="https://x.ru">l</a></p><table><tbody><tr><td>1</td></tr></tbody></table>',
    );
    expect(out).toContain('<h2>T</h2>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('<td>1</td>');
  });
  it('allows iframes only from video hosts', () => {
    expect(sanitizeRichText('<iframe src="https://evil.com/x"></iframe>')).not.toContain(
      'evil.com',
    );
    expect(sanitizeRichText('<iframe src="https://rutube.ru/play/embed/abc"></iframe>')).toContain(
      'rutube.ru',
    );
  });
  it('drops non-image data URIs', () => {
    expect(sanitizeRichText('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain(
      'data:text',
    );
  });
});

describe('text helpers', () => {
  it('extracts text with line breaks', () => {
    expect(extractText('<h2>Title</h2><p>One &amp; two</p><ul><li>a</li><li>b</li></ul>')).toBe(
      'Title\nOne & two\na\nb',
    );
  });
  it('builds excerpts', () => {
    expect(excerpt('<p>abcdefghij</p>', 5)).toBe('abcd…');
  });
  it('detects empty content', () => {
    expect(isEmptyRichText('<p></p><p> </p>')).toBe(true);
    expect(isEmptyRichText('<p><img src="/files/x"></p>')).toBe(false);
  });
});

describe('toEmbedUrl', () => {
  it.each([
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    [
      'https://rutube.ru/video/0123456789abcdef0123456789abcdef/',
      'https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef',
    ],
    [
      'https://vk.com/video-12345_67890',
      'https://vkvideo.ru/video_ext.php?oid=-12345&id=67890&hd=2',
    ],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
  ])('%s', (input, expected) => {
    expect(toEmbedUrl(input)).toBe(expected);
  });
  it('rejects unknown hosts', () => {
    expect(toEmbedUrl('https://example.com/video')).toBeNull();
    expect(toEmbedUrl('not a url')).toBeNull();
  });
});
