import type { Node } from '@hubium/db';
import { createTestDatabase, type TestDatabase } from '@hubium/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeat } from './hub.ts';

// The outages of a node as the cloud learns of them from its heartbeats: the windows the
// work done on the node without a connection must fall in to be replayed.

describe('the outages of a node', () => {
  let t: TestDatabase;
  let node: Node;

  /** A heartbeat from the node, the cloud last having heard it `silentMs` ago. */
  const beat = async (mode: 'ONLINE' | 'OFFLINE' | 'SYNC' | 'READONLY', silentMs = 1000) => {
    node = await t.db.node.update({
      where: { id: node.id },
      data: { lastSeenAt: new Date(Date.now() - silentMs) },
    });
    await heartbeat(t.db, node, { mode, release: 'test' });
  };
  const outages = () =>
    t.db.nodeOutage.findMany({ where: { nodeId: node.id }, orderBy: { startedAt: 'asc' } });

  beforeAll(async () => {
    t = await createTestDatabase();
    node = await t.db.node.create({ data: { name: 'Филиал', dbRole: 'hubium_node_test' } });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('opens one when the node falls silent, and closes it once the node has synced', async () => {
    await beat('ONLINE');
    await beat('SYNC', 120_000);
    const [o] = await outages();
    expect(o).toMatchObject({ endedAt: expect.any(Date), syncedAt: null });
    expect(Date.now() - o!.startedAt.getTime()).toBeGreaterThanOrEqual(120_000);
    await beat('ONLINE');
    expect((await outages())[0]!.syncedAt).toBeInstanceOf(Date);
  });

  it('opens another when the line goes again before the node’s sync is over', async () => {
    await t.db.nodeOutage.deleteMany({ where: { nodeId: node.id } });
    // heard again after an outage; its sync begins, and the line goes before it is over
    await beat('SYNC', 120_000);
    await beat('SYNC', 90_000);
    const [first, second] = await outages();
    expect(second).toBeDefined();
    // the second window holds what the node did while silent again
    expect(Date.now() - second!.startedAt.getTime()).toBeGreaterThanOrEqual(90_000);
    expect(second!.startedAt.getTime()).toBeGreaterThan(first!.startedAt.getTime());
    // the node works alone again after a restart, the cloud hearing it
    await beat('OFFLINE');
    expect(await outages()).toHaveLength(3);
    await beat('SYNC');
    await beat('ONLINE');
    expect((await outages()).map((o) => o.syncedAt)).toEqual([
      expect.any(Date),
      expect.any(Date),
      expect.any(Date),
    ]);
  });

  it('opens one when the node’s admin has it work alone', async () => {
    await t.db.nodeOutage.deleteMany({ where: { nodeId: node.id } });
    await beat('ONLINE');
    await beat('OFFLINE');
    await beat('OFFLINE');
    expect(await outages()).toMatchObject([{ endedAt: null, syncedAt: null }]);
    // a quick sync between two heartbeats: the next one finds the node ONLINE
    await beat('ONLINE');
    expect(await outages()).toMatchObject([
      { endedAt: expect.any(Date), syncedAt: expect.any(Date) },
    ]);
  });
});
