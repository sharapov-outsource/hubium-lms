import { lookupFunction } from './functions.ts';
import {
  type Dialect,
  FormulaError,
  LIMITS,
  type Op,
  type RefKind,
  type Token,
  tokenize,
} from './lexer.ts';

export type Node =
  | { type: 'num'; value: number; pos: number }
  | { type: 'ref'; kind: RefKind; name: string; pos: number }
  | { type: 'neg'; arg: Node; pos: number }
  | { type: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '^'; left: Node; right: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number };

export interface Formula {
  dialect: Dialect;
  ast: Node;
}

// Binding powers: power binds tighter than a leading minus (-2^2 = -4, as in PHP and
// spreadsheets) and is right-associative (2^3^2 = 2^9).
const INFIX: Partial<
  Record<Op, { lbp: number; rbp: number; op: '+' | '-' | '*' | '/' | '%' | '^' }>
> = {
  '+': { lbp: 10, rbp: 11, op: '+' },
  '-': { lbp: 10, rbp: 11, op: '-' },
  '*': { lbp: 20, rbp: 21, op: '*' },
  '/': { lbp: 20, rbp: 21, op: '/' },
  '%': { lbp: 20, rbp: 21, op: '%' },
  '^': { lbp: 40, rbp: 39, op: '^' },
  '**': { lbp: 40, rbp: 39, op: '^' },
};
const UNARY_BP = 30;

/**
 * Parses a formula. A gradebook formula may start with "=" (as Moodle shows them).
 * Throws FormulaError with the position of the mistake.
 */
export function parseFormula(src: string, opts: { dialect: Dialect }): Formula {
  const { dialect } = opts;
  // a leading "=" becomes a space, so positions still point into `src`
  const body = dialect === 'gradebook' ? src.replace(/^(\s*)=/, '$1 ') : src;
  const tokens = tokenize(body, dialect);
  let i = 0;
  const peek = (): Token => tokens[i]!;
  const next = (): Token => tokens[i++]!;
  const expectOp = (op: Op) => {
    const t = next();
    if (t.t !== 'op' || t.v !== op)
      throw new FormulaError(
        'syntax',
        t.t === 'eof' ? `Expected "${op}" at the end` : `Expected "${op}"`,
        t.pos,
      );
  };

  const expr = (rbp: number, depth: number): Node => {
    if (depth > LIMITS.depth)
      throw new FormulaError(
        'limit',
        `Formula is nested deeper than ${LIMITS.depth} levels`,
        peek().pos,
      );
    let left = prefix(depth);
    for (;;) {
      const t = peek();
      if (t.t !== 'op') {
        if (t.t !== 'eof') throw new FormulaError('syntax', 'Missing operator', t.pos);
        break;
      }
      const inf = INFIX[t.v];
      if (!inf || inf.lbp <= rbp) break;
      next();
      left = { type: 'bin', op: inf.op, left, right: expr(inf.rbp, depth + 1), pos: t.pos };
    }
    return left;
  };

  const prefix = (depth: number): Node => {
    const t = next();
    switch (t.t) {
      case 'num':
        return { type: 'num', value: t.v, pos: t.pos };
      case 'ref':
        return { type: 'ref', kind: t.kind, name: t.v, pos: t.pos };
      case 'id': {
        const f = lookupFunction(dialect, t.v);
        const name = dialect === 'gradebook' ? t.v.toLowerCase() : t.v;
        const call = peek().t === 'op' && (peek() as { v: Op }).v === '(';
        if (!f) {
          if (call) throw new FormulaError('unknownFunction', `Unknown function "${t.v}"`, t.pos);
          throw new FormulaError('unknownName', `Unknown name "${t.v}"`, t.pos);
        }
        if (!call) {
          // constants such as pi may be written without parentheses
          if (f.min === 0) return { type: 'call', name, args: [], pos: t.pos };
          throw new FormulaError('syntax', `"${t.v}" needs arguments in parentheses`, t.pos);
        }
        next();
        const args: Node[] = [];
        if (!(peek().t === 'op' && (peek() as { v: Op }).v === ')')) {
          for (;;) {
            args.push(expr(0, depth + 1));
            const sep = peek();
            if (sep.t === 'op' && sep.v === ',') {
              next();
              continue;
            }
            break;
          }
        }
        expectOp(')');
        if (args.length < f.min || args.length > f.max)
          throw new FormulaError(
            'arity',
            f.min === f.max
              ? `${t.v} takes ${f.min} argument(s), got ${args.length}`
              : `${t.v} takes ${f.min}${Number.isFinite(f.max) ? `–${f.max}` : ' or more'} arguments, got ${args.length}`,
            t.pos,
          );
        return { type: 'call', name, args, pos: t.pos };
      }
      case 'op':
        if (t.v === '(') {
          const inner = expr(0, depth + 1);
          expectOp(')');
          return inner;
        }
        if (t.v === '-') return { type: 'neg', arg: expr(UNARY_BP, depth + 1), pos: t.pos };
        if (t.v === '+') return expr(UNARY_BP, depth + 1);
        throw new FormulaError('syntax', `Unexpected "${t.v}"`, t.pos);
      case 'eof':
        throw new FormulaError('syntax', 'The formula ends too early', t.pos);
    }
  };

  const ast = expr(0, 0);
  const rest = peek();
  if (rest.t !== 'eof')
    throw new FormulaError('syntax', 'Unexpected text after the formula', rest.pos);
  return { dialect, ast };
}

/** References the formula uses, each once, in order of appearance. */
export function refs(f: Formula): { kind: RefKind; name: string }[] {
  const seen = new Map<string, { kind: RefKind; name: string }>();
  const walk = (n: Node): void => {
    if (n.type === 'ref') seen.set(`${n.kind}:${n.name}`, { kind: n.kind, name: n.name });
    else if (n.type === 'neg') walk(n.arg);
    else if (n.type === 'bin') {
      walk(n.left);
      walk(n.right);
    } else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(f.ast);
  return [...seen.values()];
}

/**
 * Rewrites the references of a formula's source and keeps everything else as written, e.g.
 * [[hw1]] → ##gi<id>## for storage and back for display. `fn` returns the replacement text.
 */
export function rewriteRefs(
  src: string,
  dialect: Dialect,
  fn: (ref: { kind: RefKind; name: string }) => string,
): string {
  const lead = dialect === 'gradebook' ? (src.match(/^\s*=/)?.[0] ?? '') : '';
  const body = src.slice(lead.length);
  let out = '';
  let last = 0;
  for (const t of tokenize(body, dialect)) {
    if (t.t !== 'ref') continue;
    out += body.slice(last, t.pos) + fn({ kind: t.kind, name: t.v });
    last = t.end;
  }
  return lead + out + body.slice(last);
}
