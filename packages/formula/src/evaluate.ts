import { lookupFunction } from './functions.ts';
import { FormulaError, type RefKind } from './lexer.ts';
import type { Formula, Node } from './parser.ts';

/** The value of a reference; throw FormulaError('unknownName') for one that does not exist. */
export type Resolve = (ref: { kind: RefKind; name: string; pos: number }) => number;

/**
 * Evaluates a parsed formula. Any result or intermediate value that is not a finite number
 * (division by zero, sqrt(-1), overflow) is an error, so callers never store NaN.
 */
export function evaluate(f: Formula, resolve: Resolve): number {
  const finite = (v: number, pos: number, what: string): number => {
    if (!Number.isFinite(v))
      throw new FormulaError('domain', `${what} is not a finite number`, pos);
    return v;
  };
  const run = (n: Node): number => {
    switch (n.type) {
      case 'num':
        return n.value;
      case 'ref':
        return finite(resolve({ kind: n.kind, name: n.name, pos: n.pos }), n.pos, n.name);
      case 'neg':
        return -run(n.arg);
      case 'bin': {
        const a = run(n.left);
        const b = run(n.right);
        const v =
          n.op === '+'
            ? a + b
            : n.op === '-'
              ? a - b
              : n.op === '*'
                ? a * b
                : n.op === '/'
                  ? a / b
                  : n.op === '%'
                    ? a % b
                    : a ** b;
        return finite(v, n.pos, 'The result');
      }
      case 'call': {
        const fn = lookupFunction(f.dialect, n.name);
        if (!fn) throw new FormulaError('unknownFunction', `Unknown function "${n.name}"`, n.pos);
        return finite(fn.fn(...n.args.map(run)), n.pos, `${n.name}()`);
      }
    }
  };
  return run(f.ast);
}
