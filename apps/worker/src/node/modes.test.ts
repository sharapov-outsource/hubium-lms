import type { ReplicaBState } from '@hubium/core/node/replicas';
import { initialNodeState } from '@hubium/core/node/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MachineDeps, ModeMachine, type Observed } from './modes.ts';

let now = 0;

function machine(over: Partial<MachineDeps> = {}) {
  const deps = {
    release: 'r1',
    offlineAfterMs: 120_000,
    promoteB: vi.fn(async () => {}),
    copyB: vi.fn(async () => {}),
    sync: vi.fn(async () => ({ done: true, lsn: '0/10' })),
    pendingOps: async () => 0,
    runningTimedAttempts: async () => 0,
    now: () => now,
    ...over,
  };
  return { deps, m: new ModeMachine(deps, initialNodeState('r1')) };
}

const seen = (cloudOk: boolean, b: ReplicaBState): Observed => ({
  cloudOk,
  cloudRelease: 'r1',
  cloudLsn: '0/20',
  a: { ready: true, replayLsn: '0/20', streaming: cloudOk, copying: false },
  b,
});

describe('the modes of a node', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse('2026-10-22T10:00:00Z');
  });
  afterEach(() => vi.useRealTimers());

  it('goes on with its own database when the agent starts and finds it in use', async () => {
    const { deps, m } = machine();
    // the agent starts without the line: the node works on as it did
    await m.tick(seen(false, 'promoted'));
    expect(m.state.mode).toBe('OFFLINE');
    expect(m.state.offlineSince).not.toBeNull();
    expect(deps.promoteB).not.toHaveBeenCalled();

    // the line is back: the journal goes to the cloud, then B is copied anew
    m.cloudAnswered();
    const sync = m.tick(seen(true, 'promoted'));
    await vi.advanceTimersByTimeAsync(5000);
    await sync;
    expect(deps.sync).toHaveBeenCalledOnce();
    expect(m.state.mode).toBe('ONLINE');
    expect(deps.copyB).toHaveBeenCalledOnce();
    await m.tick(seen(true, 'copying'));
    expect(m.state.mode).toBe('ONLINE');
  });

  it('copies its database anew when the agent stopped between the sync and the copy', async () => {
    const { deps, m } = machine();
    m.cloudAnswered();
    await m.tick(seen(true, 'promoted'));
    expect(m.state.mode).toBe('OFFLINE');
    const sync = m.tick(seen(true, 'promoted'));
    await vi.advanceTimersByTimeAsync(5000);
    await sync;
    expect(m.state.mode).toBe('ONLINE');
    expect(deps.copyB).toHaveBeenCalledOnce();
  });

  it('leaves its database to the requests on it after the sync', async () => {
    const { deps, m } = machine();
    m.cloudAnswered();
    await m.tick(seen(true, 'promoted'));
    const sync = m.tick(seen(true, 'promoted'));
    await vi.advanceTimersByTimeAsync(1000);
    // a tick while the sync waits before the copy: B is still in use, and that is expected
    await m.tick(seen(true, 'promoted'));
    expect(m.state.mode).toBe('ONLINE');
    await vi.advanceTimersByTimeAsync(4000);
    await sync;
    expect(deps.copyB).toHaveBeenCalledOnce();
  });

  it('takes its database over once the cloud is away long enough', async () => {
    const { deps, m } = machine();
    m.cloudAnswered();
    await m.tick(seen(true, 'ready'));
    expect(m.state.mode).toBe('ONLINE');
    m.cloudFailed();
    m.cloudFailed();
    await m.tick(seen(false, 'ready'));
    expect(m.state.mode).toBe('READONLY');
    now += 120_000;
    await m.tick(seen(false, 'ready'));
    expect(deps.promoteB).toHaveBeenCalledOnce();
    expect(m.state.mode).toBe('OFFLINE');
  });
});
