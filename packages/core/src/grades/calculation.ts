import { evaluate, FormulaError, parseFormula, refs, rewriteRefs } from '@hubium/formula';

// Calculated grade items, as Moodle's: a formula over other items and categories. Teachers
// write references as [[idnumber]]; they are stored as ##gi<id>## / ##gc<id>## so renaming
// an ID number changes nothing. Pure: the gradebook recomputes with it, and the setup page
// checks formulas with it.

export interface CalcItem {
  id: string;
  idNumber: string | null;
  categoryId: string | null;
  calculation: string | null;
}

export interface CalcCategory {
  id: string;
  idNumber: string | null;
  parentId: string | null;
}

export class CalculationError extends Error {
  constructor(
    readonly code:
      | 'syntax'
      | 'unknownFunction'
      | 'unknownName'
      | 'arity'
      | 'domain'
      | 'limit'
      | 'unknownIdNumber'
      | 'cycle',
    message: string,
    readonly pos = 0,
  ) {
    super(message);
    this.name = 'CalculationError';
  }
}

const parse = (src: string) => {
  try {
    return parseFormula(src, { dialect: 'gradebook' });
  } catch (e) {
    if (e instanceof FormulaError) throw new CalculationError(e.code, e.message, e.pos);
    throw e;
  }
};

/**
 * The stored form of a formula as written: [[idnumber]] → ##gi<id>## or ##gc<id>##.
 * Throws on a mistake or an ID number the course does not have.
 */
export function storeCalculation(src: string, items: CalcItem[], categories: CalcCategory[]) {
  parse(src);
  const byIdNumber = new Map<string, string>();
  for (const i of items) if (i.idNumber) byIdNumber.set(i.idNumber.toLowerCase(), `##gi${i.id}##`);
  for (const c of categories)
    if (c.idNumber) byIdNumber.set(c.idNumber.toLowerCase(), `##gc${c.id}##`);
  const stored = rewriteRefs(src.trim(), 'gradebook', (r) => {
    // references already stored (e.g. from a Moodle backup) stay when they exist
    if (r.kind === 'item' && items.some((i) => i.id === r.name)) return `##gi${r.name}##`;
    if (r.kind === 'category' && categories.some((c) => c.id === r.name)) return `##gc${r.name}##`;
    const to = r.kind === 'idnumber' ? byIdNumber.get(r.name.trim().toLowerCase()) : undefined;
    if (!to)
      throw new CalculationError(
        'unknownIdNumber',
        `No item or category has the ID number "${r.name}"`,
      );
    return to;
  });
  return stored.startsWith('=') ? stored : `=${stored}`;
}

/** The formula as teachers read it: [[idnumber]] (or [[?]] for what is gone). */
export function displayCalculation(
  stored: string,
  items: CalcItem[],
  categories: CalcCategory[],
): string {
  return rewriteRefs(stored, 'gradebook', (r) => {
    const target =
      r.kind === 'item'
        ? items.find((i) => i.id === r.name)
        : r.kind === 'category'
          ? categories.find((c) => c.id === r.name)
          : null;
    return r.kind === 'idnumber' ? `[[${r.name}]]` : `[[${target?.idNumber ?? '?'}]]`;
  });
}

/** Items and categories a stored formula uses. */
export function calculationRefs(stored: string) {
  const all = refs(parse(stored));
  return {
    items: all.filter((r) => r.kind === 'item').map((r) => r.name),
    categories: all.filter((r) => r.kind === 'category').map((r) => r.name),
  };
}

/** A category and everything below it. */
function subtree(categoryId: string, categories: CalcCategory[]): Set<string> {
  const out = new Set([categoryId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of categories)
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
  }
  return out;
}

/** The category an item counts in: its own, or the course's (root) without one. */
const homeOf = (i: CalcItem, categories: CalcCategory[]) =>
  i.categoryId ?? categories.find((c) => !c.parentId)?.id ?? null;

/**
 * The calculated items in the order to compute them, each after everything it uses (an
 * item it names, or any calculated item inside a category it names). Throws on a cycle,
 * which also catches a formula using a category the item itself counts in.
 */
export function calculationOrder(items: CalcItem[], categories: CalcCategory[]): string[] {
  const calc = items.filter((i) => i.calculation);
  const deps = new Map<string, string[]>();
  for (const i of calc) {
    const r = calculationRefs(i.calculation!);
    const inside = new Set(r.categories.flatMap((c) => [...subtree(c, categories)]));
    deps.set(i.id, [
      ...r.items.filter((id) => calc.some((x) => x.id === id)),
      ...calc.filter((x) => inside.has(homeOf(x, categories) ?? '')).map((x) => x.id),
    ]);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting')
      throw new CalculationError('cycle', 'The formula depends on itself', 0);
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) visit(d);
    state.set(id, 'done');
    order.push(id);
  };
  for (const i of calc) visit(i.id);
  return order;
}

/**
 * The value of a stored formula for one student, as Moodle's: an empty reference counts as
 * 0, but with every reference empty (or one gone) there is no grade; nor when the formula
 * cannot be computed (e.g. division by zero).
 */
export function calculate(
  stored: string,
  value: (ref: { kind: 'item' | 'category'; id: string }) => number | null | undefined,
): number | null {
  const f = parse(stored);
  const used = refs(f);
  const values = new Map<string, number | null>();
  for (const r of used) {
    if (r.kind !== 'item' && r.kind !== 'category') return null;
    const v = value({ kind: r.kind, id: r.name });
    if (v === undefined) return null;
    values.set(`${r.kind}:${r.name}`, v);
  }
  if (used.length && [...values.values()].every((v) => v === null)) return null;
  try {
    const out = evaluate(f, (r) => values.get(`${r.kind}:${r.name}`) ?? 0);
    return Number.isFinite(out) ? out : null;
  } catch (e) {
    if (e instanceof FormulaError) return null;
    throw e;
  }
}
