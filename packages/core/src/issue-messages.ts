import { type MsgInput, msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { MsgOrText } from './errors.ts';

// What a field that fails its schema says to people. zod's own messages ("Too small:
// expected string to have >=3 characters") are for developers: they become messages of the
// language packs by the kind of issue. A schema's own message stays; one that is a key of the
// packs ("errors.…", "mod.…") becomes that message, a custom issue's params its values.

const zodEnglish = z.locales.en().localeError;
const KEY = /^(errors|mod)\.[\w.]+$/;

function zodDefault(issue: z.core.$ZodIssue): boolean {
  const r = zodEnglish(issue as never);
  const text = typeof r === 'string' ? r : (r?.message ?? '');
  // a finished issue no longer holds the input, so zod's text names no received type
  return issue.code === 'invalid_type'
    ? issue.message.startsWith(text.split(', received')[0]!)
    : issue.message === text;
}

const NUMERIC = new Set(['number', 'int', 'bigint']);

/** A schema's issue as a message for people. */
export function issueMsg(issue: z.core.$ZodIssue): MsgOrText {
  if (!zodDefault(issue)) {
    if (!KEY.test(issue.message)) return issue.message;
    // a custom issue's params are its message's values
    const params = issue.code === 'custom' ? issue.params : undefined;
    return msg(issue.message, params as MsgInput | undefined);
  }
  switch (issue.code) {
    case 'invalid_type':
      return issue.message.endsWith('received undefined')
        ? msg('errors.field.required')
        : msg('errors.field.invalid');
    case 'too_small': {
      const n = Number(issue.minimum);
      if (issue.origin === 'string')
        return n <= 1 ? msg('errors.field.required') : msg('errors.field.tooShort', { n });
      if (issue.origin === 'array' || issue.origin === 'set')
        return msg('errors.field.tooFew', { n });
      if (NUMERIC.has(issue.origin))
        return msg(issue.inclusive === false ? 'errors.field.above' : 'errors.field.tooSmall', {
          n,
        });
      return msg('errors.field.invalid');
    }
    case 'too_big': {
      const n = Number(issue.maximum);
      if (issue.origin === 'string') return msg('errors.field.tooLong', { n });
      if (issue.origin === 'array' || issue.origin === 'set')
        return msg('errors.field.tooMany', { n });
      if (NUMERIC.has(issue.origin))
        return msg(issue.inclusive === false ? 'errors.field.below' : 'errors.field.tooBig', {
          n,
        });
      return msg('errors.field.invalid');
    }
    case 'invalid_format':
      return issue.format === 'email'
        ? msg('errors.field.email')
        : issue.format === 'url'
          ? msg('errors.field.url')
          : msg('errors.field.invalid');
    case 'invalid_value':
      return msg('errors.field.option');
    default:
      return msg('errors.field.invalid');
  }
}
