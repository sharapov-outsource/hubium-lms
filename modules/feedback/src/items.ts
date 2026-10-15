// Item types and answer checks of mod-feedback, shared by its server code and its forms.

export const ITEM_TYPES = ['info', 'text', 'textarea', 'choice', 'number', 'pagebreak'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
/** Item types that take an answer. */
export const ANSWERED: readonly ItemType[] = ['text', 'textarea', 'choice', 'number'];

export interface Item {
  id: string;
  sortOrder: number;
  type: ItemType;
  label: string;
  required: boolean;
  choices: string[];
  multiple: boolean;
  display: 'radio' | 'dropdown';
  min: number | null;
  max: number | null;
}

export type Answer = string | string[] | number;

/** Question numbers ("1", "2", …) of the items that take answers. */
export function itemNumbers(items: Item[]): Map<string, number> {
  let n = 0;
  return new Map(items.filter((i) => ANSWERED.includes(i.type)).map((i) => [i.id, ++n]));
}

/** Items split into pages at page breaks (empty pages left out). */
export function itemPages(items: Item[]): Item[][] {
  const pages: Item[][] = [[]];
  for (const i of items) {
    if (i.type === 'pagebreak') pages.push([]);
    else pages.at(-1)!.push(i);
  }
  return pages.filter((p) => p.length);
}

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
      if (i.required) throw new Error(`"${i.label}": an answer is required`);
    };
    if (i.type === 'choice') {
      const picked = (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
        .map(String)
        .filter(Boolean);
      if (!picked.length) {
        missing();
        continue;
      }
      if (!i.multiple && picked.length > 1) throw new Error(`"${i.label}": choose one option`);
      if (picked.some((p) => !i.choices.includes(p)))
        throw new Error(`"${i.label}": no such option`);
      out[i.id] = i.multiple ? [...new Set(picked)] : picked[0]!;
    } else if (i.type === 'number') {
      if (v === undefined || v === null || v === '') {
        missing();
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`"${i.label}": a number is expected`);
      if ((i.min !== null && n < i.min) || (i.max !== null && n > i.max))
        throw new Error(`"${i.label}": the number is out of range`);
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
