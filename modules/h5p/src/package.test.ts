import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { h5pFixture } from './fixtures.ts';
import { allowedFile, checkPackage, durationSeconds, gradeOf, resultOf } from './package.ts';

const open = (zip: Uint8Array) => {
  const files = unzipSync(zip);
  const text = (p: string) => (files[p] ? new TextDecoder().decode(files[p]) : null);
  return { names: Object.keys(files), text };
};

describe('H5P packages', () => {
  it('reads a package with its libraries', () => {
    const p = open(h5pFixture());
    expect(checkPackage(p.names, p.text('h5p.json')!, (d) => p.text(`${d}/library.json`))).toEqual({
      title: 'Проверка',
      mainLibrary: 'H5P.HubiumCheck',
      libraries: ['H5P.HubiumCheck-1.0'],
    });
  });

  it('says what is missing', () => {
    const p = open(h5pFixture({ withLibrary: false }));
    expect(() =>
      checkPackage(p.names, p.text('h5p.json')!, (d) => p.text(`${d}/library.json`)),
    ).toThrow('does not include the library H5P.HubiumCheck-1.0');
    expect(() => checkPackage([], 'not json', () => null)).toThrow(/not an H5P package/);
    expect(() => checkPackage([], '{"mainLibrary":"X"}', () => null)).toThrow(/content.json/);
  });

  it('keeps only the file types H5P accepts', () => {
    expect(allowedFile('content/images/photo.JPG')).toBe(true);
    expect(allowedFile('H5P.MultiChoice-1.16/js/multichoice.js')).toBe(true);
    expect(allowedFile('content/page.html')).toBe(false);
    expect(allowedFile('run.php')).toBe(false);
    expect(allowedFile('__MACOSX/content/._x.json')).toBe(false);
    expect(allowedFile('content/.hidden.json')).toBe(false);
    expect(allowedFile('README')).toBe(false);
  });
});

describe('xAPI results', () => {
  const statement = (verb: string, more: object = {}) => ({
    verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` },
    result: { score: { raw: 3, max: 4 }, completion: true, success: false, duration: 'PT1M2.4S' },
    ...more,
  });

  it('takes the whole content’s completed or answered statements', () => {
    expect(resultOf(statement('completed'))).toEqual({
      rawScore: 3,
      maxScore: 4,
      scaled: 0.75,
      completion: true,
      success: false,
      durationSec: 62,
    });
    expect(resultOf(statement('answered'))?.scaled).toBe(0.75);
    expect(resultOf(statement('attempted'))).toBeNull();
    // a question inside a set reports to its parent: not counted
    expect(
      resultOf(
        statement('answered', { context: { contextActivities: { parent: [{ id: 'x' }] } } }),
      ),
    ).toBeNull();
  });

  it('durations and grading methods', () => {
    expect(durationSeconds('PT1H')).toBe(3600);
    expect(durationSeconds('P1DT1S')).toBe(86_401);
    expect(durationSeconds('soon')).toBeNull();
    expect(gradeOf('HIGHEST', [0.5, null, 0.8])).toBe(0.8);
    expect(gradeOf('AVERAGE', [0.5, 1])).toBe(0.75);
    expect(gradeOf('FIRST', [0.5, 1])).toBe(0.5);
    expect(gradeOf('LAST', [0.5, 1])).toBe(1);
    expect(gradeOf('LAST', [])).toBeNull();
  });
});
