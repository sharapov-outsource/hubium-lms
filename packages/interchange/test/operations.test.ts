import { duplicateOperationNames, listModules, listOperations } from '@hubium/core';
import '@hubium/core/testing';
import { describe, expect, it } from 'vitest';
import '../src/index.ts';

// A local node records operations and module actions by name and the cloud replays them,
// with what the node may do with each without a connection: names are unique, and every
// one says what that is.

const POLICIES = ['replay', 'guarded', 'side', 'online'];

describe('the operations', () => {
  it('have names of their own', () => {
    expect(listOperations().length).toBeGreaterThan(200);
    expect(duplicateOperationNames()).toEqual([]);
    const ops = new Set(listOperations().map((o) => o.name));
    const actions = listModules().flatMap((m) =>
      Object.keys(m.actions ?? {}).map((a) => `${m.key}.${a}`),
    );
    expect(actions.length).toBeGreaterThan(100);
    expect(actions.filter((a) => ops.has(a))).toEqual([]);
  });

  it('say what a local node does with them without a connection', () => {
    const missing = [
      ...listOperations()
        .filter((o) => !POLICIES.includes(o.offline))
        .map((o) => o.name),
      ...listModules().flatMap((m) =>
        Object.entries(m.actions ?? {})
          .filter(([, a]) => !POLICIES.includes(a.offline))
          .map(([name]) => `${m.key}.${name}`),
      ),
    ];
    expect(missing).toEqual([]);
  });
});
