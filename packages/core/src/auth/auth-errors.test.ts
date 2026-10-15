import { describe, expect, it } from 'vitest';
import { authErrorText } from './auth-errors.ts';

describe('Better Auth refusals for people', () => {
  it('read in the language by their code, else as they came', () => {
    expect(authErrorText({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, 'ru')).toBe(
      'Учётная запись с этим адресом почты уже есть',
    );
    expect(authErrorText({ code: 'LOGIN_AS_ADMIN', message: 'Only…' }, 'de')).toBe(
      'Nur Website-Administratoren können sich als Administrator anmelden',
    );
    // a password policy refusal is already in the person's language
    expect(authErrorText({ code: 'PASSWORD_POLICY', message: 'Не короче 12 символов' }, 'ru')).toBe(
      'Не короче 12 символов',
    );
    // a code that is a group of messages, not one, is not a message
    expect(authErrorText({ code: 'password', message: 'Plain' }, 'ru')).toBe('Plain');
    expect(authErrorText(undefined, 'ru')).toBeUndefined();
  });
});
