import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeForOutcome } from '../exit-codes.js';

test('exitCodeForOutcome maps all three outcomes to the pi-agent.sh numbering', () => {
  // Literals, not the module's own exported constants: a renumbering of EXIT_* must fail
  // this test rather than silently moving both sides of the comparison together.
  assert.strictEqual(exitCodeForOutcome('settled-with-text'), 0);
  assert.strictEqual(exitCodeForOutcome('settled-no-text'), 4);
  assert.strictEqual(exitCodeForOutcome('died'), 3);
});

test('exitCodeForOutcome rejects an outcome outside the three-way contract', () => {
  assert.throws(() => exitCodeForOutcome('timed-out'), /unknown outcome/);
});
