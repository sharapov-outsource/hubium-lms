import assert from 'node:assert/strict';
import { test } from 'node:test';
import { satisfies } from './spdx.mjs';

const ok = new Set(['MIT', 'ISC', 'Apache-2.0', 'GPL-2.0-or-later']);

test('single licenses', () => {
  assert.equal(satisfies('MIT', ok), true);
  assert.equal(satisfies('SSPL-1.0', ok), false);
});

test('OR needs one accepted side, AND needs all', () => {
  assert.equal(satisfies('(MIT OR CC0-1.0)', ok), true);
  assert.equal(satisfies('BUSL-1.1 OR MIT', ok), true);
  assert.equal(satisfies('Apache-2.0 AND MIT', ok), true);
  assert.equal(satisfies('MIT and ISC', ok), true);
  assert.equal(satisfies('MIT AND CC-BY-NC-4.0', ok), false);
  assert.equal(satisfies('(MIT AND BUSL-1.1) OR (ISC AND Apache-2.0)', ok), true);
});

test('an exception keeps its base license', () => {
  assert.equal(satisfies('GPL-2.0-or-later WITH Classpath-exception-2.0', ok), true);
  assert.equal(satisfies('GPL-2.0-only WITH Classpath-exception-2.0', ok), false);
});

test('malformed expressions are reported', () => {
  assert.throws(() => satisfies('(MIT OR ISC', ok), SyntaxError);
  assert.throws(() => satisfies('MIT OR', ok), SyntaxError);
  assert.throws(() => satisfies('SEE LICENSE IN LICENSE.md', ok), SyntaxError);
});
