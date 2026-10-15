import { describe, expect, it } from 'vitest';
import { moveColumn } from './columns';

describe('moving report columns', () => {
  const columns = ['name', 'email', 'lastAccess'];

  it('keeps the sort on the column that moves', () => {
    expect(moveColumn(columns, { column: 1, desc: true }, 1, -1)).toEqual({
      columns: ['email', 'name', 'lastAccess'],
      sort: { column: 0, desc: true },
    });
  });

  it('keeps the sort on the column that is moved past', () => {
    expect(moveColumn(columns, { column: 1, desc: false }, 2, -1)).toEqual({
      columns: ['name', 'lastAccess', 'email'],
      sort: { column: 2, desc: false },
    });
  });

  it('leaves the sort alone when other columns move, and the ends in place', () => {
    expect(moveColumn(columns, { column: 2, desc: false }, 0, 1).sort).toEqual({
      column: 2,
      desc: false,
    });
    expect(moveColumn(columns, null, 1, 1)).toEqual({
      columns: ['name', 'lastAccess', 'email'],
      sort: null,
    });
    expect(moveColumn(columns, { column: 0, desc: false }, 0, -1)).toEqual({
      columns,
      sort: { column: 0, desc: false },
    });
  });
});
