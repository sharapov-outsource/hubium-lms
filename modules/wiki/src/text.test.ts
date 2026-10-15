import { describe, expect, it } from 'vitest';
import { diffText, htmlLines, linkedTitles, renderLinks } from './text.ts';

describe('wiki links', () => {
  it('finds the titles a page links to', () => {
    expect(
      linkedTitles('<p>See [[ Python  basics ]] and [[Loops|cycles]], again [[Loops]].</p>'),
    ).toEqual(['Python basics', 'Loops']);
    // not in attributes
    expect(linkedTitles('<p><img alt="[[x]]">no</p>')).toEqual([]);
  });

  it('links existing pages and offers to create missing ones', () => {
    const html = renderLinks(
      '<p>[[Home]] or [[New page|a new one]]; <code>[[raw]]</code> <a href="/x">[[in link]]</a></p>',
      (t) => ({ url: `/w?title=${encodeURIComponent(t)}`, exists: t === 'Home' }),
    );
    expect(html).toBe(
      '<p><a href="/w?title=Home">Home</a> or <a href="/w?title=New%20page" data-new="">a new one</a>; <code>[[raw]]</code> <a href="/x">[[in link]]</a></p>',
    );
    // titles cannot break out of the markup
    expect(
      renderLinks('<p>[[a&quot; onclick=&quot;x]]</p>', () => ({ url: '/', exists: true })),
    ).toBe('<p><a href="/">a&quot; onclick=&quot;x</a></p>');
  });
});

describe('wiki versions', () => {
  it('reads the text of HTML a line per paragraph', () => {
    expect(
      htmlLines('<h2>Title</h2><p>One &amp; <b>two</b></p><ul><li>a</li><li>b</li></ul>'),
    ).toBe('Title\nOne & two\na\nb');
  });

  it('shows words added and removed', () => {
    expect(diffText('the quick brown fox', 'the slow brown dog')).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'added', text: 'slow' },
      { kind: 'removed', text: 'quick' },
      { kind: 'same', text: ' brown ' },
      { kind: 'added', text: 'dog' },
      { kind: 'removed', text: 'fox' },
    ]);
    expect(diffText('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(diffText('', 'new text')).toEqual([{ kind: 'added', text: 'new text' }]);
  });
});
