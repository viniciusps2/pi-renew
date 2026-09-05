import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogue, resolveModelId, readDefaultModelId } from '../model.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('an explicit catalogued id resolves', () => {
  const listModels = () => FIXTURE_CATALOGUE;
  // There is no default pin to assert any more: a driver given no --model passes none, so the
  // only id this resolver ever sees is one a caller named explicitly.
  assert.strictEqual(resolveModelId('openrouter/qwen', { listModels }).id, 'openrouter/qwen');
  assert.strictEqual(resolveModelId('llm-1/qwen3.8-27b', { listModels }).id, 'llm-1/qwen3.8-27b');
});

// --- readDefaultModelId: reporting only, and null rather than a guess ------------------
function settingsFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-driver-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

test('readDefaultModelId joins defaultProvider and the unqualified defaultModel', () => {
  // This is the real shape: `pi` stores the provider separately and the model unqualified.
  const settingsPath = settingsFile({ defaultProvider: 'llm-1', defaultModel: 'qwen3.8-27b-superfast' });
  assert.strictEqual(readDefaultModelId({ settingsPath }), 'llm-1/qwen3.8-27b-superfast');
});

test('readDefaultModelId leaves an already-qualified defaultModel alone', () => {
  const settingsPath = settingsFile({ defaultProvider: 'llm-1', defaultModel: 'openrouter/qwen' });
  assert.strictEqual(readDefaultModelId({ settingsPath }), 'openrouter/qwen');
});

test('readDefaultModelId returns null rather than guessing', () => {
  // Every one of these must be null, never a substituted id: a driver treats null as "unknown"
  // and still runs with no --model, which is the whole point of removing the pin.
  assert.strictEqual(readDefaultModelId({ settingsPath: join(tmpdir(), 'no-such-settings-file.json') }), null);
  assert.strictEqual(readDefaultModelId({ settingsPath: settingsFile('{ not json') }), null);
  assert.strictEqual(readDefaultModelId({ settingsPath: settingsFile({ defaultProvider: 'llm-1' }) }), null);
  assert.strictEqual(readDefaultModelId({ settingsPath: settingsFile({ defaultModel: 'qwen3.8-27b' }) }), null);
  assert.strictEqual(readDefaultModelId({ settingsPath: settingsFile({ defaultProvider: '', defaultModel: 'x' }) }), null);
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
