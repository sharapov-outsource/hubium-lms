import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { resolveLogins } from './logins.ts';

describe('people named by login', () => {
  const t = useTestDb();

  it('tells whether an address has an account only to those who may use the answer', async () => {
    const student = await ctxFor(t.db, 'student1@hubium.local');
    const manage = (ctx: Awaited<ReturnType<typeof ctxFor>>) => ({
      allowed: () => ctx.perm.require('cohort:manage'),
      field: 'login',
    });
    // the same refusal for an account that exists and for one that does not
    for (const login of ['teacher@hubium.local', 'nobody@hubium.local'])
      await expect(resolveLogins(student, login, manage(student))).rejects.toBeInstanceOf(
        ForbiddenError,
      );

    const admin = await ctxFor(t.db, 'admin@test.local');
    const teacher = await t.db.user.findUniqueOrThrow({ where: { username: 'teacher' } });
    expect(await resolveLogins(admin, 'TEACHER@hubium.local, teacher', manage(admin))).toEqual([
      teacher.id,
    ]);
    await expect(
      resolveLogins(admin, 'teacher\nnobody@hubium.local', manage(admin)),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
