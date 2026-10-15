import type { Locale } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';

// Messages for people that errors carry: a key in the language packs and its values, put in
// the person's language where the error reaches them (server actions, module actions). Read
// as text — in logs, API answers, a message nobody translated — a message is in English, the
// language packs' base, so nothing that only prints an error has to know about them.

export type MsgValues = Record<string, string | number>;

export class Msg {
  constructor(
    /** A key of the language packs: core's `errors.<…>`, a module's `mod.<module>.<…>`. */
    readonly key: string,
    readonly values: MsgValues = {},
  ) {}

  /** The message in a language. */
  in(locale: Locale): string {
    return createTranslator(locale)(this.key, this.values);
  }

  toString(): string {
    return this.in('en');
  }
}

/** A message for people by its key in the language packs, with its values. */
export function msg(key: string, values?: MsgValues): Msg {
  return new Msg(key, values);
}

/** Whether a value is a message (by its shape: a bundle may hold two copies of the class). */
export function isMsg(v: unknown): v is Msg {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Msg).key === 'string' &&
    typeof (v as Msg).in === 'function'
  );
}

/** A message in a language: a Msg translated, text as it is. */
export function renderMsg(m: Msg | string, locale: Locale): string {
  return isMsg(m) ? m.in(locale) : m;
}
