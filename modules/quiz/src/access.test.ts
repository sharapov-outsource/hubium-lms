import { describe, expect, it } from 'vitest';
import {
  type AccessRules,
  checkStart,
  effectivePasswords,
  networkAllowed,
  nextAttemptAt,
} from './access.ts';
import { normalisePages, pageForNewSlot } from './server.ts';

const rules = (o: Partial<AccessRules> = {}): AccessRules => ({
  passwords: [],
  subnet: '',
  delay1Sec: 0,
  delay2Sec: 0,
  ...o,
});
const now = new Date('2026-10-15T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('quiz access rules', () => {
  it('takes the password of the learner, then of their groups, then of the quiz', () => {
    expect(effectivePasswords('quiz', null, [])).toEqual(['quiz']);
    expect(effectivePasswords('quiz', 'mine', ['g1'])).toEqual(['mine']);
    expect(effectivePasswords('quiz', '', ['g1'])).toEqual([]);
    expect(effectivePasswords('quiz', null, ['g1', null, 'g2', 'g1'])).toEqual(['g1', 'g2']);
    // a group without a password lifts it: the most lenient applies
    expect(effectivePasswords('quiz', null, ['g1', ''])).toEqual([]);
    expect(effectivePasswords('', null, [null])).toEqual([]);
  });

  it('waits delay1 after the first attempt and delay2 after later ones', () => {
    const r = rules({ delay1Sec: 600, delay2Sec: 3600 });
    expect(nextAttemptAt(r, [])).toBeNull();
    expect(nextAttemptAt(r, [minutesAgo(5)])).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(nextAttemptAt(r, [minutesAgo(120), minutesAgo(30)])).toEqual(
      new Date(now.getTime() + 30 * 60_000),
    );
    expect(checkStart(r, { ip: null, now, finished: [minutesAgo(5)], preview: false })).toEqual({
      reason: 'delay',
      until: new Date(now.getTime() + 5 * 60_000),
    });
    expect(checkStart(r, { ip: null, now, finished: [minutesAgo(11)], preview: false })).toBeNull();
    expect(checkStart(r, { ip: null, now, finished: [minutesAgo(5)], preview: true })).toBeNull();
  });

  it('checks the network and the password', () => {
    const r = rules({ subnet: '192.168.1.0/24', passwords: ['Секрет'] });
    expect(networkAllowed(r, '192.168.1.7')).toBe(true);
    expect(networkAllowed(r, '10.0.0.1')).toBe(false);
    expect(networkAllowed(rules(), null)).toBe(true);
    const at = { now, finished: [], preview: false };
    expect(checkStart(r, { ...at, ip: '10.0.0.1', password: 'Секрет' })).toEqual({
      reason: 'subnet',
    });
    expect(checkStart(r, { ...at, ip: '192.168.1.7' })).toEqual({ reason: 'password' });
    expect(checkStart(r, { ...at, ip: '192.168.1.7', password: 'секрет' })).toEqual({
      reason: 'password',
    });
    expect(checkStart(r, { ...at, ip: '192.168.1.7', password: 'Секрет' })).toBeNull();
  });
});

describe('quiz pages', () => {
  it('starts a new page every perPage questions and keeps pages consecutive', () => {
    expect(pageForNewSlot([], 2)).toBe(1);
    expect(pageForNewSlot([1], 2)).toBe(1);
    expect(pageForNewSlot([1, 1], 2)).toBe(2);
    expect(pageForNewSlot([1, 1, 2], 0)).toBe(2);
    expect(normalisePages([1, 1, 3, 3, 4])).toEqual([1, 1, 2, 2, 3]);
    expect(normalisePages([2, 2, 5])).toEqual([1, 1, 2]);
  });
});
