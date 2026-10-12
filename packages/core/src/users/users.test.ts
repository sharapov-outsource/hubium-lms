import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import {
  bulkUploadUsers,
  createUser,
  deleteUser,
  listUsers,
  parseCsv,
  setUserSuspended,
  updateUser,
} from './users.ts';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
  it('detects semicolon separator (Excel ru)', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('skips blank lines', () => {
    expect(parseCsv('a\n\n\nb\n')).toEqual([['a'], ['b']]);
  });
});

describe('users service', () => {
  const t = useTestDb();

  it('admin creates a user; duplicate email is rejected', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const { id } = await createUser.run(ctx, {
      email: 'New@Example.com',
      firstName: 'New',
      lastName: 'User',
      password: 'Password123',
    });
    const u = await t.db.user.findUniqueOrThrow({ where: { id } });
    expect(u.email).toBe('new@example.com');
    expect(u.name).toBe('New User');
    await expect(
      createUser.run(ctx, {
        email: 'new@example.com',
        firstName: 'A',
        lastName: 'B',
        password: 'Password123',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const log = await t.db.eventLog.findFirst({
      where: { name: 'user.created', relatedUserId: id },
    });
    expect(log).not.toBeNull();
  });

  it('username-only user gets a placeholder email', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const { id } = await createUser.run(ctx, {
      username: 'kid01',
      firstName: 'Kid',
      lastName: 'One',
      password: 'Password123',
    });
    const u = await t.db.user.findUniqueOrThrow({ where: { id } });
    expect(u.email).toBe('kid01@users.invalid');
    expect(u.emailPlaceholder).toBe(true);
  });

  it('students cannot create or list users', async () => {
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    await expect(
      createUser.run(ctx, {
        email: 'x@example.com',
        firstName: 'X',
        lastName: 'Y',
        password: 'Password123',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listUsers(ctx, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('manager role (system assignment) can list users and search', async () => {
    const ctx = await ctxFor(t.db, 'manager@hubium.local');
    const res = await listUsers(ctx, { q: 'петров' });
    expect(res.items.map((u) => u.email)).toEqual(['student1@hubium.local']);
  });

  it('manager cannot grant site admin', async () => {
    const ctx = await ctxFor(t.db, 'manager@hubium.local');
    await expect(
      createUser.run(ctx, {
        email: 'boss@x.y',
        firstName: 'B',
        lastName: 'B',
        password: 'Password123',
        isSiteAdmin: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('update changes name and suspend kills sessions', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const s = await t.db.user.findUniqueOrThrow({ where: { email: 'student2@hubium.local' } });
    await t.db.session.create({
      data: { userId: s.id, token: 'tok-1', expiresAt: new Date(Date.now() + 1e6) },
    });
    await updateUser.run(ctx, { id: s.id, firstName: 'Маша' });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: s.id } })).name).toBe('Маша Сидорова');
    await setUserSuspended.run(ctx, { id: s.id, suspended: true });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('SUSPENDED');
    expect(await t.db.session.count({ where: { userId: s.id } })).toBe(0);
  });

  it('admin cannot suspend themselves', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    await expect(
      setUserSuspended.run(ctx, { id: ctx.perm.userId!, suspended: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('delete anonymises personal data', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const s = await t.db.user.findUniqueOrThrow({ where: { email: 'student3@hubium.local' } });
    await deleteUser.run(ctx, { id: s.id });
    const u = await t.db.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(u.status).toBe('DELETED');
    expect(u.email).toBe(`deleted-${s.id}@users.invalid`);
    expect(u.username).toBeNull();
    expect(await t.db.account.count({ where: { userId: s.id } })).toBe(0);
  });

  it('CSV upload creates valid rows and reports errors per line', async () => {
    const ctx = await ctxFor(t.db, 'admin@test.local');
    const csv = [
      'username;firstname;lastname;password;email',
      'csv1;Анна;Первая;Password123;csv1@example.com',
      'csv2;Борис;Второй;short;',
      'csv3;Вера;Третья;Password123;',
      'csv1;Дубль;Дублев;Password123;dup@example.com',
    ].join('\n');
    const r = await bulkUploadUsers.run(ctx, { csv });
    expect(r.created).toBe(2);
    expect(r.errors.map((e) => e.line)).toEqual([3, 5]);
  });
});
