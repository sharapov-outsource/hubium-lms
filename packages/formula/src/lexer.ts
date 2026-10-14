// Tokens of a formula. Two dialects share the arithmetic:
//   question   variables in braces: {x}, {a_1}            (calculated questions, as Moodle)
//   gradebook  references to grade items: [[idnumber]], and the stored forms ##gi<id>## and
//              ##gc<id>## (an item or a category by id, so renaming an id number keeps them)

export type Dialect = 'question' | 'gradebook';

export type RefKind = 'var' | 'idnumber' | 'item' | 'category';

export type Token =
  | { t: 'num'; v: number; pos: number; end: number }
  | { t: 'id'; v: string; pos: number; end: number }
  | { t: 'ref'; kind: RefKind; v: string; pos: number; end: number }
  | { t: 'op'; v: Op; pos: number; end: number }
  | { t: 'eof'; pos: number; end: number };

export type Op = '+' | '-' | '*' | '/' | '%' | '^' | '**' | '(' | ')' | ',';

export type FormulaErrorCode =
  | 'syntax'
  | 'unknownFunction'
  | 'unknownName'
  | 'arity'
  | 'domain'
  | 'limit';

export class FormulaError extends Error {
  constructor(
    readonly code: FormulaErrorCode,
    message: string,
    /** Offset in the source, for pointing at the mistake. */
    readonly pos: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

export const LIMITS = { length: 2000, tokens: 512, depth: 50 } as const;

const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/y;
const IDNUMBER = /\[\[([^[\]]+)\]\]/y;
const STORED = /##g([ic])([0-9A-Za-z-]+)##/y;
const OPS: Op[] = ['**', '+', '-', '*', '/', '%', '^', '(', ')', ','];

function match(re: RegExp, src: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(src);
}

export function tokenize(src: string, dialect: Dialect): Token[] {
  if (src.length > LIMITS.length)
    throw new FormulaError('limit', `Formula is longer than ${LIMITS.length} characters`, 0);
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (out.length >= LIMITS.tokens)
      throw new FormulaError('limit', `Formula has more than ${LIMITS.tokens} parts`, i);
    let m: RegExpExecArray | null;
    if ((m = match(NUMBER, src, i))) {
      out.push({ t: 'num', v: Number(m[0]), pos: i, end: i + m[0].length });
      i += m[0].length;
    } else if ((m = match(IDENT, src, i))) {
      out.push({ t: 'id', v: m[0], pos: i, end: i + m[0].length });
      i += m[0].length;
    } else if (dialect === 'question' && (m = match(VAR, src, i))) {
      out.push({ t: 'ref', kind: 'var', v: m[1]!, pos: i, end: i + m[0].length });
      i += m[0].length;
    } else if (dialect === 'gradebook' && (m = match(IDNUMBER, src, i))) {
      const name = m[1]!.trim();
      if (!name) throw new FormulaError('syntax', 'Empty reference [[ ]]', i);
      out.push({ t: 'ref', kind: 'idnumber', v: name, pos: i, end: i + m[0].length });
      i += m[0].length;
    } else if (dialect === 'gradebook' && (m = match(STORED, src, i))) {
      const kind = m[1] === 'i' ? 'item' : 'category';
      out.push({ t: 'ref', kind, v: m[2]!, pos: i, end: i + m[0].length });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new FormulaError('syntax', `Unexpected character "${c}"`, i);
      out.push({ t: 'op', v: op, pos: i, end: i + op.length });
      i += op.length;
    }
  }
  out.push({ t: 'eof', pos: src.length, end: src.length });
  return out;
}
