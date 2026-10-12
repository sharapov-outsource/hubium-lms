import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { scormFixture } from './fixtures.ts';
import {
  durationSeconds,
  extractZip,
  initialCmi,
  isCompleted,
  parseManifest,
  safeEntryPath,
  scorePercent,
  trackFromCmi,
} from './package.ts';

const tmpZip = (data: Uint8Array) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'scorm-')), 'p.zip');
  writeFileSync(f, data);
  return f;
};

const collect = async (file: string, limits?: Parameters<typeof extractZip>[2]) => {
  const out: Record<string, string> = {};
  await extractZip(
    file,
    async (p, stream) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      out[p] = Buffer.concat(chunks).toString();
    },
    limits,
  );
  return out;
};

describe('safe extraction', () => {
  it('normalises paths and rejects traversal', () => {
    expect(safeEntryPath('a/./b//c.html')).toBe('a/b/c.html');
    expect(safeEntryPath('..\\evil.js')).toBeNull();
    expect(safeEntryPath('a/../../x')).toBeNull();
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:/x')).toBeNull();
  });
  it('extracts a package', async () => {
    const files = await collect(tmpZip(scormFixture()));
    expect(Object.keys(files).sort()).toEqual(['imsmanifest.xml', 'sco/index.html']);
  });
  it('rejects zip-slip entries', async () => {
    const evil = zipSync({
      'imsmanifest.xml': strToU8('<manifest/>'),
      '../../evil.js': strToU8('x'),
    });
    await expect(collect(tmpZip(evil))).rejects.toThrow('Unsafe path');
  });
  it('rejects zip bombs and oversized archives', async () => {
    const bomb = zipSync({ 'big.txt': new Uint8Array(5 * 1024 * 1024) }, { level: 9 });
    await expect(collect(tmpZip(bomb))).rejects.toThrow('compression ratio');
    await expect(
      collect(tmpZip(scormFixture()), { maxEntries: 1, maxTotalBytes: 1e9, maxRatio: 1000 }),
    ).rejects.toThrow('Too many files');
    await expect(
      collect(tmpZip(scormFixture()), { maxEntries: 10, maxTotalBytes: 100, maxRatio: 1000 }),
    ).rejects.toThrow('too large');
  });
});

describe('manifest', () => {
  it('parses SCORM 1.2 with mastery score', async () => {
    const files = await collect(tmpZip(scormFixture('1.2')));
    expect(parseManifest(files['imsmanifest.xml']!)).toEqual({
      version: 'SCORM_12',
      title: 'Тестовый курс SCORM',
      scos: [{ identifier: 'item1', title: 'Урок 1', href: 'sco/index.html', masteryScore: 80 }],
    });
  });
  it('parses SCORM 2004 with item parameters', async () => {
    const files = await collect(tmpZip(scormFixture('2004')));
    const m = parseManifest(files['imsmanifest.xml']!);
    expect(m.version).toBe('SCORM_2004');
    expect(m.scos.map((s) => s.href)).toEqual(['index.html', 'index.html?part=2']);
  });
  it('fails without launchable items', () => {
    expect(() => parseManifest('<manifest><resources/></manifest>')).toThrow('no launchable');
    expect(() => parseManifest('<x/>')).toThrow('no <manifest>');
  });
});

describe('CMI', () => {
  it('reads durations in both formats', () => {
    expect(durationSeconds('0001:02:03.50')).toBe(3723.5);
    expect(durationSeconds('PT1H2M3S')).toBe(3723);
    expect(durationSeconds('P1DT1S')).toBe(86401);
    expect(durationSeconds('garbage')).toBe(0);
  });
  it('extracts 1.2 tracking and score', () => {
    const t = trackFromCmi('SCORM_12', {
      cmi: {
        core: {
          lesson_status: 'passed',
          lesson_location: 'p2',
          exit: 'suspend',
          session_time: '00:01:00',
          score: { raw: '42', min: '0', max: '50' },
        },
        suspend_data: 'x=1',
      },
    });
    expect(t).toMatchObject({
      completionStatus: 'passed',
      successStatus: 'passed',
      location: 'p2',
      suspendData: 'x=1',
      sessionTimeSec: 60,
    });
    expect(scorePercent(t)).toBe(84);
    expect(isCompleted(t)).toBe(true);
  });
  it('extracts 2004 tracking with scaled score', () => {
    const t = trackFromCmi('SCORM_2004', {
      completion_status: 'incomplete',
      success_status: 'unknown',
      score: { scaled: '0.5', raw: '' },
      session_time: 'PT30S',
    });
    expect(scorePercent(t)).toBe(50);
    expect(isCompleted(t)).toBe(false);
  });
  it('builds resume data only after a suspend', () => {
    const t = {
      ...trackFromCmi('SCORM_12', {
        core: { lesson_location: 'p2', exit: 'suspend', lesson_status: 'incomplete' },
        suspend_data: 's',
      }),
      totalTimeSec: 90,
    };
    const c = initialCmi('SCORM_12', { id: 'u', name: 'Ann' }, t, { masteryScore: 80 }) as {
      core: Record<string, unknown>;
      suspend_data: string;
      student_data: unknown;
    };
    expect(c.core).toMatchObject({
      entry: 'resume',
      lesson_location: 'p2',
      total_time: '0000:01:30',
      student_id: 'u',
    });
    expect(c.suspend_data).toBe('s');
    expect(c.student_data).toEqual({ mastery_score: '80' });
    const fresh = initialCmi('SCORM_2004', { id: 'u', name: 'Ann' }, null);
    expect(fresh).toMatchObject({
      entry: 'ab-initio',
      completion_status: 'unknown',
      learner_id: 'u',
    });
  });
});
