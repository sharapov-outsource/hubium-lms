import { ValidationError } from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'ru' }));
vi.mock('./session', () => ({
  getContext: async () => ({ actor: { kind: 'user', userId: 'u1', isSiteAdmin: false } }),
  requireNoGate: async () => {},
}));

const { formBool, formToObject, mappingFromForm, runAction } = await import('./action');

describe('runAction', () => {
  it('returns what the action returns', async () => {
    expect(await runAction(async () => ({ id: 'x' }))).toEqual({ ok: true, data: { id: 'x' } });
  });

  it("lets Next.js's redirect and notFound through", async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/x;307;',
    });
    await expect(
      runAction(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
    const notFound = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
    await expect(
      runAction(async () => {
        throw notFound;
      }),
    ).rejects.toBe(notFound);
  });

  it('says a refusal in the language of the page, at the form fields it names', async () => {
    const r = await runAction(
      async () => {
        throw new ValidationError({
          'site.name': [msg('errors.VALIDATION')],
          'mapping.fields.dept': [msg('errors.VALIDATION')],
        });
      },
      { fields: { 'site.name': 'siteName', 'mapping.fields.': 'map_field_' } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('VALIDATION');
    expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual(['map_field_dept', 'siteName']);
    // Russian, not the English of the message key
    expect(r.message).toMatch(/[а-я]/i);
  });

  it("says Better Auth's refusals with their status, in the language of the page", async () => {
    const r = await runAction(async () => {
      throw new APIError('UNAUTHORIZED', { message: 'Invalid password', code: 'INVALID_PASSWORD' });
    });
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(r.ok ? '' : r.message).toMatch(/[а-я]/i);
  });
});

describe('form helpers', () => {
  it('reads the text fields of a form, without the action ids or files', () => {
    const fd = new FormData();
    fd.set('name', 'Курс');
    fd.set('$ACTION_ID_abc', '');
    fd.set('file', new Blob(['x']), 'a.txt');
    expect(formToObject(fd)).toEqual({ name: 'Курс' });
  });

  it('reads a checkbox and the mapped profile fields', () => {
    expect(['on', 'true', '1', 'off', null].map((v) => formBool(v))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(
      mappingFromForm({ map_field_dept: ' ou ', map_field_room: '  ', mapEmail: 'mail' }),
    ).toEqual({ dept: 'ou' });
  });
});
