// Item types of mod-feedback, shared by its server code and its forms (answers.ts checks
// answers on the server).

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
