import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIdleSeconds, IdleWatchdog, surfaceBytesFromCatalogue } from '../idle.js';

test('computeIdleSeconds rises with prompt size once past the floor', () => {
  const small = computeIdleSeconds({ promptBytes: 200 });
  const large = computeIdleSeconds({ promptBytes: 200_000 });
  // Both concrete, both computed — not a `>=`, which a constant function would also satisfy.
  assert.strictEqual(small, 60); // 200 bytes rounds to nothing past the floor
  assert.strictEqual(large, 226); // ceil(200000/1024) + 30 = 196 + 30
  assert.ok(large > small);
});

test('computeIdleSeconds never returns less than the 60s floor', () => {
  for (const promptBytes of [0, 1, 1024, 5, 999]) {
    assert.ok(computeIdleSeconds({ promptBytes }) >= 60);
  }
});

test('an explicit idle override is returned verbatim, including 0', () => {
  assert.strictEqual(computeIdleSeconds({ promptBytes: 999_999, explicitIdle: 0 }), 0);
  assert.strictEqual(computeIdleSeconds({ promptBytes: 0, explicitIdle: 45 }), 45);
});

test('the watchdog suspends while a tool call is in flight, and fires once it ends', () => {
  let nowMs = 0;
  const clock = () => nowMs;
  const watchdog = new IdleWatchdog({ idleSeconds: 10, now: clock });

  watchdog.feed({ type: 'tool_execution_start' });
  nowMs += 30_000; // well past the 10s timeout
  assert.strictEqual(watchdog.timedOut(), false, 'a running tool must suspend the timeout');

  watchdog.feed({ type: 'tool_execution_end' });
  nowMs += 5_000; // under the timeout since the tool ended
  assert.strictEqual(watchdog.timedOut(), false);

  nowMs += 10_000; // now past it, with no tool pending
  assert.strictEqual(watchdog.timedOut(), true, 'silence after the tool ends must resume the clock');
});

test('surfaceBytesFromCatalogue(26710) is the worked example that proves the conversion does its job', () => {
  // The measured anchor (see idle.js's header comment above CATALOGUE_TO_PROMPT_BYTES): a
  // full-surface get_commands response is 26,710 bytes; the equivalent prompt-byte estimate
  // is 96,156, which the formula turns into 124s. Feeding the RAW, un-converted catalogue
  // size into computeIdleSeconds instead does nothing (60s, the bare floor) — asserting both
  // halves is the point: the conversion is what makes the rise happen at all.
  const surfaceBytes = surfaceBytesFromCatalogue(26710);
  assert.strictEqual(surfaceBytes, 96156);
  assert.strictEqual(computeIdleSeconds({ surfaceBytes }), 124);
  assert.strictEqual(computeIdleSeconds({ surfaceBytes: 26710 }), 60, 'the un-converted number would have done nothing');
});

test('surfaceBytesFromCatalogue is monotonic: a larger catalogue yields a larger surface estimate', () => {
  assert.ok(surfaceBytesFromCatalogue(50_000) > surfaceBytesFromCatalogue(10_000));
  assert.strictEqual(surfaceBytesFromCatalogue(0), 0);
});

test('surfaceBytesFromCatalogue applies a ratio in the measured band', () => {
  // Deliberately a BAND, not the exact constant. idle.js's header comment states the rule this
  // file follows: the tests assert the helper's *shape* so that a later re-measurement of the
  // anchor invalidates no test. Pinning CATALOGUE_TO_PROMPT_BYTES to 3.6 here would break that
  // rule, and asserting round(n * CATALOGUE_TO_PROMPT_BYTES) would be worse than useless — it
  // recomputes the implementation from the same constant the implementation uses, so it passes
  // for every possible value. The exact worked example above (26710 -> 96156 -> 124s) is what
  // pins the real behaviour with hard literals.
  const ratio = surfaceBytesFromCatalogue(100_000) / 100_000;
  assert.ok(ratio > 3 && ratio < 4.5, `catalogue-to-prompt ratio ${ratio} is outside the measured band`);
});
