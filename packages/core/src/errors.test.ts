import { ModuleError, msg } from '@hubium/module-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { toActionError } from './operation.ts';

describe('errors for people', () => {
  it('read in English as text, and in the language of whoever gets them', () => {
    const e = new ValidationError({ name: [msg('errors.field.tooShort', { n: 3 })] });
    expect(e.fieldErrors).toEqual({ name: ['At least 3 characters'] });
    expect(toActionError(e, 'ru')).toEqual({
      ok: false,
      code: 'VALIDATION',
      message: 'Не короче 3 символов',
      fieldErrors: { name: ['Не короче 3 символов'] },
    });
    // a text without a key yet stays as it is
    expect(toActionError(new ValidationError({ x: ['Plain'] }), 'de').fieldErrors).toEqual({
      x: ['Plain'],
    });
  });

  it("say why a schema refuses a value, not zod's own words", () => {
    const r = z
      .object({
        name: z.string().min(1),
        code: z.string().min(3),
        count: z.number().max(5),
        email: z.string().email(),
        kind: z.enum(['a', 'b']),
        own: z.string().max(1, 'Own words'),
        keyed: z.string().max(1, 'errors.field.invalid'),
      })
      .safeParse({ code: 'x', count: 9, email: 'no', kind: 'c', own: 'xx', keyed: 'xx' });
    expect(toActionError(r.error, 'ru').fieldErrors).toEqual({
      name: ['Обязательное поле'],
      code: ['Не короче 3 символов'],
      count: ['Не больше 5'],
      email: ['Введите адрес электронной почты'],
      kind: ['Выберите один из вариантов'],
      own: ['Own words'],
      keyed: ['Недопустимое значение'],
    });
  });

  it('name refusals, things not found and module errors in the language', () => {
    expect(toActionError(new ForbiddenError(), 'ru').message).toBe(
      'Недостаточно прав для этого действия',
    );
    const missing = new NotFoundError('Course');
    expect(missing.message).toBe('Course not found');
    expect(toActionError(missing, 'de').message).toBe('Nicht gefunden');
    const closed = new ModuleError('CONFLICT', msg('errors.inUse'));
    expect(closed.message).toBe('This value is already in use');
    expect(closed.msg?.in('it')).toBe('Questo valore è già in uso');
  });
});
