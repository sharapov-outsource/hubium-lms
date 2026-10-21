import { describe, expect, it } from 'vitest';
import { isRowWrite, writeGuardMode } from './write-guard.ts';
import { currentWriteScope, withWriteScope } from './write-scope.ts';

describe('write guard', () => {
  it('tells statements that change rows from the rest', () => {
    expect(isRowWrite('INSERT INTO "User" (id) VALUES (?)')).toBe(true);
    expect(isRowWrite('update "User" set "lastAccessAt" = now() where id = ?')).toBe(true);
    expect(isRowWrite('WITH x AS (SELECT 1) DELETE FROM "Session" WHERE id = ?')).toBe(true);
    expect(isRowWrite('TRUNCATE "EventLog"')).toBe(true);
    expect(isRowWrite('SELECT pg_notify(?, ?)')).toBe(false);
    expect(isRowWrite('SELECT * FROM "QuizAttempt" WHERE id = ? FOR UPDATE')).toBe(false);
    expect(isRowWrite('SELECT * FROM pgboss.job FOR UPDATE SKIP LOCKED')).toBe(false);
  });

  it('reads its mode from the environment and refuses a mistyped one', () => {
    expect(writeGuardMode(undefined)).toBe('off');
    expect(writeGuardMode('')).toBe('off');
    expect(writeGuardMode('off')).toBe('off');
    expect(writeGuardMode('report')).toBe('report');
    expect(writeGuardMode('strict')).toBe('strict');
    expect(() => writeGuardMode('on')).toThrow(/off, report or strict/);
  });

  it('keeps a scope across awaits and drops it outside', async () => {
    expect(currentWriteScope()).toBeUndefined();
    const seen = await withWriteScope('touch', 'view', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentWriteScope();
    });
    expect(seen).toEqual({ kind: 'touch', name: 'view' });
    expect(currentWriteScope()).toBeUndefined();
  });
});
