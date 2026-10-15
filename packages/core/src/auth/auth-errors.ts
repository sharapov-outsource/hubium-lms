import type { Locale } from '@hubium/i18n';
import { baseMessage, createTranslator } from '@hubium/i18n/packs';

// Better Auth's refusals, its own and Hubium's, carry a machine code beside their English
// text. The code names their message in the language packs, errors.authCodes.<CODE>; a
// refusal people do not meet has no message there and keeps its own text.

/** A Better Auth refusal in a language, or nothing when its code has no message. */
export function authErrorText(
  body: { code?: unknown; message?: unknown } | undefined,
  locale: Locale,
): string | undefined {
  const key = typeof body?.code === 'string' ? `errors.authCodes.${body.code}` : '';
  if (key && baseMessage(key) !== undefined) return createTranslator(locale)(key);
  return typeof body?.message === 'string' && body.message ? body.message : undefined;
}
