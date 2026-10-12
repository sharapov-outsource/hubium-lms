import { describe, expect, it } from 'vitest';
import { embedFor, label, page, url } from './server.ts';

describe('content modules', () => {
  it('page sanitises HTML on parse', () => {
    const s = page.settings.schema.parse({ content: '<p>ok</p><script>x</script>' });
    expect(s.content).toBe('<p>ok</p>');
  });
  it('label defaults to empty content', () => {
    expect(label.settings.schema.parse({})).toEqual({ content: '' });
  });
  it('url only accepts http(s)', () => {
    expect(url.settings.schema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(url.settings.schema.safeParse({ url: 'ftp://x.ru/file' }).success).toBe(false);
    expect(url.settings.schema.parse({ url: 'https://example.com' }).display).toBe('newtab');
  });
  it('detects embeddable videos', () => {
    expect(embedFor('https://youtu.be/abc')).toContain('youtube-nocookie');
    expect(embedFor('https://example.com')).toBeNull();
  });
  it('page text extraction for search/AI', () => {
    expect(page.extractText?.({ settings: { content: '<h2>A</h2><p>b</p>' } } as never)).toBe(
      'A\nb',
    );
  });
});
