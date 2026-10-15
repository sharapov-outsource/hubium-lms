import { ModuleError, msg } from '@hubium/module-sdk';
import { ANSWERED, type Answer, type Item } from './items.ts';

// Answers of mod-feedback checked on the server; the messages are for the person answering.

/**
 * Checks submitted answers against the items: required ones given, choices among the
 * options, numbers in range. Unknown items and empty answers are left out.
 */
export function checkAnswers(items: Item[], raw: Record<string, unknown>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const i of items) {
    if (!ANSWERED.includes(i.type)) continue;
    const v = raw[i.id];
    const missing = () => {
      if (i.required)
        throw new ModuleError(
          'BAD_REQUEST',
          msg('mod.feedback.errors.answerRequired', { label: i.label }),
        );
    };
    if (i.type === 'choice') {
      const picked = (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
        .map(String)
        .filter(Boolean);
      if (!picked.length) {
        missing();
        continue;
      }
      if (!i.multiple && picked.length > 1)
        throw new ModuleError(
          'BAD_REQUEST',
          msg('mod.feedback.errors.oneOption', { label: i.label }),
        );
      if (picked.some((p) => !i.choices.includes(p)))
        throw new ModuleError(
          'BAD_REQUEST',
          msg('mod.feedback.errors.noOption', { label: i.label }),
        );
      out[i.id] = i.multiple ? [...new Set(picked)] : picked[0]!;
    } else if (i.type === 'number') {
      if (v === undefined || v === null || v === '') {
        missing();
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n))
        throw new ModuleError(
          'BAD_REQUEST',
          msg('mod.feedback.errors.numberExpected', { label: i.label }),
        );
      if ((i.min !== null && n < i.min) || (i.max !== null && n > i.max))
        throw new ModuleError(
          'BAD_REQUEST',
          msg('mod.feedback.errors.numberRange', { label: i.label }),
        );
      out[i.id] = n;
    } else {
      const text = typeof v === 'string' ? v.trim() : '';
      if (!text) {
        missing();
        continue;
      }
      out[i.id] = text.slice(0, i.type === 'text' ? 1000 : 20_000);
    }
  }
  return out;
}
