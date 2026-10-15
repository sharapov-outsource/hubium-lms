import { describe, expect, it } from 'vitest';
import { chapterBlock, chapterNumbers, movedOrder } from './server.ts';

const row = (id: string, subchapter = false) => ({ id, subchapter });
const ids = (list: { id: string }[]) => list.map((c) => c.id).join(' ');

describe('book chapters', () => {
  const book = [row('a'), row('a1', true), row('a2', true), row('b'), row('c'), row('c1', true)];

  it('numbers chapters and subchapters in reading order', () => {
    expect([...chapterNumbers(book).values()]).toEqual(['1', '1.1', '1.2', '2', '3', '3.1']);
    // a subchapter first in the book counts as a chapter
    expect([...chapterNumbers([row('x', true), row('y', true)]).values()]).toEqual(['1', '1.1']);
  });

  it('takes a chapter with its subchapters', () => {
    expect(ids(chapterBlock(book, 'a'))).toBe('a a1 a2');
    expect(ids(chapterBlock(book, 'a1'))).toBe('a1');
    expect(ids(chapterBlock(book, 'b'))).toBe('b');
    expect(chapterBlock(book, 'nope')).toEqual([]);
  });

  it('moves a chapter with its subchapters, and a subchapter alone', () => {
    expect(ids(movedOrder(book, 'b', 'up'))).toBe('b a a1 a2 c c1');
    expect(ids(movedOrder(book, 'a', 'down'))).toBe('b a a1 a2 c c1');
    expect(ids(movedOrder(book, 'c', 'up'))).toBe('a a1 a2 c c1 b');
    expect(ids(movedOrder(book, 'a2', 'up'))).toBe('a a2 a1 b c c1');
    // nothing moves past the ends, and a subchapter never becomes the first row
    expect(ids(movedOrder(book, 'a', 'up'))).toBe(ids(book));
    expect(ids(movedOrder(book, 'c', 'down'))).toBe(ids(book));
    expect(ids(movedOrder(book, 'a1', 'up'))).toBe(ids(book));
  });
});
