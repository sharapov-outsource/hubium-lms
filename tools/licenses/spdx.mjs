// Evaluates SPDX license expressions ("MIT", "(MIT OR CC0-1.0)", "Apache-2.0 AND MIT",
// "GPL-2.0-or-later WITH Classpath-exception-2.0") against a set of accepted license ids.

/**
 * True when the expression can be satisfied with accepted licenses only: one side of an OR
 * is enough, every part of an AND is needed. An exception (WITH) only adds permissions, so
 * it is accepted when its base license is. Operators are matched in any letter case, since
 * package manifests write "MIT and ISC" as often as "MIT AND ISC".
 */
export function satisfies(expression, accepted) {
  const tokens = String(expression).replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const peek = () => tokens[i]?.toUpperCase();

  function license() {
    if (tokens[i] === '(') {
      i++;
      const ok = anyOf();
      if (tokens[i] !== ')') throw new SyntaxError(`Unbalanced parentheses in "${expression}"`);
      i++;
      return ok;
    }
    const id = tokens[i++];
    if (id === undefined || id === ')') throw new SyntaxError(`Unexpected end of "${expression}"`);
    if (peek() === 'WITH') i += 2;
    return accepted.has(id);
  }
  function allOf() {
    let ok = license();
    while (peek() === 'AND') {
      i++;
      const next = license();
      ok = ok && next;
    }
    return ok;
  }
  function anyOf() {
    let ok = allOf();
    while (peek() === 'OR') {
      i++;
      const next = allOf();
      ok = ok || next;
    }
    return ok;
  }

  const ok = anyOf();
  if (i < tokens.length) throw new SyntaxError(`Unexpected "${tokens[i]}" in "${expression}"`);
  return ok;
}
