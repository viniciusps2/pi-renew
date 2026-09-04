import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogue, resolveModelId, DEFAULT_MODEL_ID } from '../model.js';

// A fixture catalogue shaped like real `pi --list-models` output: a header row, whitespace-
// aligned columns, and — deliberately — BOTH a row for provider "openrouter" model "qwen"
// AND a row for provider "openrouter" model "qwen/qwen3.8-27b". Real output contains exactly
// this ambiguity (`openrouter  qwen/qwen3.8-27b`), and only the second row proves a resolver
// really splits on the FIRST "/": a `candidate.split("/")[1]` implementation asked to resolve
// "openrouter/qwen/qwen3.8-27b" would compute model "qwen" instead of "qwen/qwen3.8-27b" —
// and because the "openrouter qwen" row also exists, that wrong implementation would still
// find *a* match and report success, just against the wrong id. Without that decoy row a
// buggy implementation and a correct one would be indistinguishable by their exit code alone.
const FIXTURE_CATALOGUE = [
  'provider    model                context  max-out  thinking  images',
  'llm-1       qwen3.8-27b          260K     16.4K    yes       no',
  'llm-1       Qwen3.8-Flash-Next   184.3K   16.4K    yes       no',
  'openrouter  qwen                 262.1K   131.1K   yes       yes',
  'openrouter  qwen/qwen3.8-27b     262.1K   131.1K   yes       yes',
  '',
].join('\n');

test('an id absent from the catalogue is rejected, naming the id in the message', () => {
  const listModels = () => FIXTURE_CATALOGUE;
  assert.throws(
    () => resolveModelId('llm-1/definitely-not-a-model', { listModels }),
    // Both halves matter: the message must name the id a human has to go and fix, and the
    // error must carry the exit code the CLI reports (2 = usage), since that number is what
    // the acceptance criterion is actually about and nothing else pins it.
    (err) => err.message.includes('llm-1/definitely-not-a-model') && err.exitCode === 2,
  );
});

test('an unqualified id is rejected before the catalogue is consulted', () => {
  let called = false;
  const listModels = () => {
    called = true;
    return FIXTURE_CATALOGUE;
  };
  assert.throws(() => resolveModelId('qwen3.8-27b', { listModels }), /unqualified/);
  // Not "and it also happened to throw" — the catalogue reader must never even run for an
  // unqualified id, per decision 5 ("rejected as unqualified, exit 2, before any catalogue
  // lookup").
  assert.strictEqual(called, false);
});

test('a candidate id splits on the FIRST "/" only, resolving the full model column', () => {
  const listModels = () => FIXTURE_CATALOGUE;
  const resolved = resolveModelId('openrouter/qwen/qwen3.8-27b', { listModels });
  assert.deepEqual(resolved, {
    provider: 'openrouter',
    model: 'qwen/qwen3.8-27b',
    id: 'openrouter/qwen/qwen3.8-27b',
  });
});

test('the default pin resolves, and an explicit different catalogued id overrides it', () => {
  const listModels = () => FIXTURE_CATALOGUE;
  const pinned = resolveModelId(DEFAULT_MODEL_ID, { listModels });
  // The pin is asserted against the fixture, not against the live catalogue: this suite is
  // offline by design. Re-pinning DEFAULT_MODEL_ID (model.js) therefore REQUIRES the new row to
  // be present in the fixture above — if it is not, this test fails rather than silently passing,
  // which is the point of asserting the pin at all. (2026-08-28: the pin flipped back to
  // llm-1/qwen3.8-27b, F139/D-H87; the Flash-Next row stays in the fixture as an ordinary row.)
  assert.strictEqual(pinned.id, 'llm-1/qwen3.8-27b');

  const overridden = resolveModelId('openrouter/qwen', { listModels });
  assert.strictEqual(overridden.id, 'openrouter/qwen');
});

test('the catalogue parser skips the header row', () => {
  // The header's own first two whitespace-separated words are literally "provider" and
  // "model" — an off-by-one that forgot to skip row 0 would silently mint a fake catalogue
  // entry for provider "provider", model "model".
  const text = ['provider  model  context  max-out  thinking  images', 'llm-1  qwen3.8-27b  260K  16.4K  yes  no', ''].join(
    '\n',
  );
  const rows = parseCatalogue(text);
  assert.ok(!rows.some((row) => row.provider === 'provider' && row.model === 'model'));
  assert.ok(rows.some((row) => row.provider === 'llm-1' && row.model === 'qwen3.8-27b'));
});
