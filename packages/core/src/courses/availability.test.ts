import { describe, expect, it } from 'vitest';
import {
  type AvailabilityFacts,
  type AvailabilityTree,
  evaluateAvailability,
  parseAvailability,
  pruneAvailability,
  referencedActivities,
} from './availability.ts';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const G1 = '33333333-3333-4333-8333-333333333333';

function facts(p: Partial<AvailabilityFacts> = {}): AvailabilityFacts {
  return {
    now: new Date('2026-03-01T10:00:00Z'),
    completion: new Map(),
    groupIds: new Set(),
    grades: new Map(),
    profile: {},
    ...p,
  };
}

const t = (op: '&' | '|', ...c: AvailabilityTree['c']): AvailabilityTree => ({ op, c });

describe('evaluateAvailability', () => {
  it('no tree means available', () => {
    expect(evaluateAvailability(null, facts()).available).toBe(true);
    expect(evaluateAvailability(t('&'), facts()).available).toBe(true);
  });
  it('date from / until', () => {
    const from = t('&', { type: 'date', op: '>=', at: '2026-03-02T00:00:00Z' });
    expect(evaluateAvailability(from, facts()).available).toBe(false);
    expect(
      evaluateAvailability(from, facts({ now: new Date('2026-03-02T00:00:00Z') })).available,
    ).toBe(true);
    const until = t('&', { type: 'date', op: '<', at: '2026-03-02T00:00:00Z' });
    expect(evaluateAvailability(until, facts()).available).toBe(true);
  });
  it('completion states', () => {
    const tree = t('&', { type: 'completion', activityId: A1, state: 'complete' });
    expect(evaluateAvailability(tree, facts()).available).toBe(false);
    expect(
      evaluateAvailability(tree, facts({ completion: new Map([[A1, 'complete']]) })).available,
    ).toBe(true);
    expect(
      evaluateAvailability(tree, facts({ completion: new Map([[A1, 'fail']]) })).available,
    ).toBe(true);
    const pass = t('&', { type: 'completion', activityId: A1, state: 'pass' });
    expect(
      evaluateAvailability(pass, facts({ completion: new Map([[A1, 'fail']]) })).available,
    ).toBe(false);
    const incomplete = t('&', { type: 'completion', activityId: A1, state: 'incomplete' });
    expect(evaluateAvailability(incomplete, facts()).available).toBe(true);
  });
  it('group membership (specific and any)', () => {
    expect(
      evaluateAvailability(
        t('&', { type: 'group', groupId: G1 }),
        facts({ groupIds: new Set([G1]) }),
      ).available,
    ).toBe(true);
    expect(evaluateAvailability(t('&', { type: 'group' }), facts()).available).toBe(false);
  });
  it('grade range in percent', () => {
    const tree = t('&', { type: 'grade', activityId: A2, min: 50, max: 90 });
    expect(evaluateAvailability(tree, facts()).available).toBe(false);
    expect(evaluateAvailability(tree, facts({ grades: new Map([[A2, 75]]) })).available).toBe(true);
    expect(evaluateAvailability(tree, facts({ grades: new Map([[A2, 90]]) })).available).toBe(
      false,
    );
  });
  it('profile conditions are case-insensitive', () => {
    const tree = t('&', { type: 'profile', field: 'email', op: 'endsWith', value: '@School.ru' });
    expect(
      evaluateAvailability(tree, facts({ profile: { email: 'kid@school.ru' } })).available,
    ).toBe(true);
    expect(
      evaluateAvailability(tree, facts({ profile: { email: 'kid@gmail.com' } })).available,
    ).toBe(false);
  });
  it('AND reports every missing condition', () => {
    const tree = t(
      '&',
      { type: 'group' },
      { type: 'completion', activityId: A1, state: 'complete' },
    );
    const r = evaluateAvailability(tree, facts());
    expect(r.available).toBe(false);
    expect(r.missing).toHaveLength(2);
  });
  it('OR needs any branch; nested trees work', () => {
    const tree = t(
      '|',
      { type: 'group', groupId: G1 },
      t(
        '&',
        { type: 'completion', activityId: A1, state: 'complete' },
        { type: 'date', op: '>=', at: '2026-01-01T00:00:00Z' },
      ),
    );
    expect(evaluateAvailability(tree, facts()).available).toBe(false);
    expect(
      evaluateAvailability(tree, facts({ completion: new Map([[A1, 'complete']]) })).available,
    ).toBe(true);
    expect(evaluateAvailability(tree, facts({ groupIds: new Set([G1]) })).available).toBe(true);
  });
  it('hidden flag only applies when unavailable', () => {
    const tree: AvailabilityTree = { op: '&', hidden: true, c: [{ type: 'group' }] };
    expect(evaluateAvailability(tree, facts()).hidden).toBe(true);
    expect(evaluateAvailability(tree, facts({ groupIds: new Set([G1]) })).hidden).toBe(false);
  });
  it('parses valid JSON and rejects junk', () => {
    expect(parseAvailability({ op: '&', c: [{ type: 'group' }] })).not.toBeNull();
    expect(parseAvailability({ op: 'x', c: [] })).toBeNull();
    expect(parseAvailability(null)).toBeNull();
  });
  it('lists referenced activities', () => {
    const tree = t(
      '|',
      { type: 'completion', activityId: A1, state: 'complete' },
      t('&', { type: 'grade', activityId: A2, min: 1 }),
    );
    expect(referencedActivities(tree)).toEqual([A1, A2]);
  });
  it('leaves out conditions on what is gone, as met', () => {
    const tree = t(
      '&',
      { type: 'completion', activityId: A1, state: 'complete' },
      t('|', { type: 'group', groupId: G1 }, { type: 'grade', activityId: A2, min: 50 }),
    );
    const exists = (p: Partial<NonNullable<AvailabilityFacts['exists']>> = {}) => ({
      activityIds: new Set([A1, A2]),
      groupIds: new Set([G1]),
      groupingIds: new Set<string>(),
      ...p,
    });
    expect(evaluateAvailability(tree, facts({ exists: exists() })).available).toBe(false);
    // the activity was deleted: only the alternatives are left
    const noA1 = facts({ exists: exists({ activityIds: new Set([A2]) }) });
    expect(evaluateAvailability(tree, noA1).missing).toHaveLength(2);
    expect(evaluateAvailability(tree, { ...noA1, grades: new Map([[A2, 60]]) }).available).toBe(
      true,
    );
    // nothing it names is left
    expect(
      evaluateAvailability(
        tree,
        facts({ exists: exists({ activityIds: new Set(), groupIds: new Set() }) }),
      ),
    ).toEqual({ available: true, hidden: false, missing: [] });

    expect(pruneAvailability(tree, (c) => c.type === 'group')).toEqual(
      t(
        '&',
        { type: 'completion', activityId: A1, state: 'complete' },
        t('|', { type: 'grade', activityId: A2, min: 50 }),
      ),
    );
    expect(pruneAvailability(tree, () => true)).toBeNull();
    expect(pruneAvailability({ ...tree, hidden: true }, (c) => c.type === 'grade')).toMatchObject({
      hidden: true,
    });
  });
});
