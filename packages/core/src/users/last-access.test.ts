import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { noteUserAccess } from './last-access.ts';

describe('last visit', () => {
  const t = useTestDb();
  const read = () =>
    t.db.user.findUniqueOrThrow({
      where: { email: 'student2@hubium.local' },
      select: { id: true, lastAccessAt: true, updatedAt: true },
    });

  it('is written at most once a minute and leaves updatedAt alone', async () => {
    const before = await read();
    const at = new Date('2026-09-01T10:00:00Z');
    await noteUserAccess(t.db, before, at);
    const first = await read();
    expect(first.lastAccessAt).toEqual(at);
    expect(first.updatedAt).toEqual(before.updatedAt);
    // within the minute nothing changes, even from a stale copy of the user
    await noteUserAccess(t.db, before, new Date(at.getTime() + 30_000));
    expect((await read()).lastAccessAt).toEqual(at);
    const later = new Date(at.getTime() + 61_000);
    await noteUserAccess(t.db, first, later);
    expect((await read()).lastAccessAt).toEqual(later);
  });
});
