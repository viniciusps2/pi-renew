import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { foldEvents, foldSessionEntries, outcomeForFold } from '../session.js';
import { exitCodeForOutcome } from '../exit-codes.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// The three session-file fixtures live under .claude/skills/pi-subagent-tmux/test/fixtures/ — one
// copy, one source of truth — read across from the repo root rather than duplicated here. The tmux
// driver is a development-only skill and deliberately sits outside the skills/ tree pi loads, so
// this reaches up to the repo root instead of across a sibling directory.
const TMUX_FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.claude',
  'skills',
  'pi-subagent-tmux',
  'test',
  'fixtures',
);

/** Load a captured fixture and parse every non-blank line as one event. */
function loadFixture(name) {
  const text = readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** Load a captured *session-file* fixture (pi-subagent-tmux's, not this package's own). */
function loadSessionFixture(name) {
  const text = readFileSync(path.join(TMUX_FIXTURES_DIR, name), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** Load only the first `lineCount` lines of a fixture — simulates reading mid-stream. */
function loadFixturePrefix(name, lineCount) {
  return loadFixture(name).slice(0, lineCount);
}

test('rpc-tool.jsonl: not settled truncated after tool_execution_end, settled in full', () => {
  // Line 25 of rpc-tool.jsonl is the tool_execution_end for the one `bash` call; the run's
  // second turn (the model's actual answer) hasn't started yet at that point.
  const truncated = foldEvents(loadFixturePrefix('rpc-tool.jsonl', 25));
  assert.strictEqual(truncated.settled, false);

  const full = foldEvents(loadFixture('rpc-tool.jsonl'));
  assert.strictEqual(full.settled, true);
});

test('rpc-tool.jsonl: not settled truncated after the tool-call-carrying assistant message', () => {
  // Line 21 is the message_end for the FIRST assistant message — the one whose content is
  // thinking + a toolCall, with no text block. A settle detector keyed on "a new assistant
  // message arrived" would wrongly call this settled; agent_settled doesn't appear until
  // line 44.
  const truncated = foldEvents(loadFixturePrefix('rpc-tool.jsonl', 21));
  assert.strictEqual(truncated.settled, false);
});

test('rpc-notools.jsonl folds to settled-with-text containing "OK"', () => {
  const folded = foldEvents(loadFixture('rpc-notools.jsonl'));
  assert.strictEqual(folded.settled, true);
  assert.ok(folded.lastAssistantText.includes('OK'), folded.lastAssistantText);
  assert.strictEqual(outcomeForFold(folded), 'settled-with-text');
});

test('rpc-died.jsonl folds to died, mapping to exit 3', () => {
  // The fixture is a truncated stream with no agent_settled anywhere in it (SIGKILL mid
  // message) — folding it as "ended" is what turns "not settled" into "died".
  const folded = foldEvents(loadFixture('rpc-died.jsonl'), { ended: true });
  assert.strictEqual(folded.settled, false);
  assert.strictEqual(folded.died, true);
  assert.strictEqual(outcomeForFold(folded), 'died');
  assert.strictEqual(exitCodeForOutcome(outcomeForFold(folded)), 3);
});

test('the derived no-text fixture folds to settled with empty text, mapping to exit 4', () => {
  const folded = foldEvents(loadFixture('rpc-notext.jsonl'), { ended: true });
  assert.strictEqual(folded.settled, true);
  assert.strictEqual(folded.died, false);
  assert.strictEqual(folded.lastAssistantText, '');
  const outcome = outcomeForFold(folded);
  assert.strictEqual(outcome, 'settled-no-text');
  assert.strictEqual(exitCodeForOutcome(outcome), 4);
  // Distinct from rpc-died.jsonl's outcome, even though both eventually stop producing text.
  assert.notStrictEqual(exitCodeForOutcome(outcome), 3);
});

test('rpc-exterr.jsonl settles successfully AND reports exactly one extension error', () => {
  // The point of this fixture: a thrown extension error does not change the settle outcome
  // (decision 14) — both halves must hold at once, not one at the expense of the other.
  const folded = foldEvents(loadFixture('rpc-exterr.jsonl'));
  assert.strictEqual(outcomeForFold(folded), 'settled-with-text');
  assert.strictEqual(folded.extensionErrors.length, 1);
  assert.strictEqual(folded.extensionErrors[0].event, 'context');
});

// --- foldSessionEntries — the tmux backend's persisted-session-file counterpart to foldEvents

test('session-settled.jsonl folds to settled-with-text, exit 0', () => {
  const folded = foldSessionEntries(loadSessionFixture('session-settled.jsonl'));
  assert.strictEqual(folded.settled, true);
  assert.strictEqual(folded.lastAssistantText, 'REDACTED-assistant-text');
  assert.strictEqual(outcomeForFold(folded), 'settled-with-text');
  assert.strictEqual(exitCodeForOutcome(outcomeForFold(folded)), 0);
  // A clean session must surface NO errors. Without this the error test below passes even for
  // an implementation that collects EVERY assistant message into erroredStopReasons, since
  // that fixture happens to hold exactly one.
  assert.deepStrictEqual(folded.erroredStopReasons, []);
});

test('session-midturn.jsonl folds to NOT settled even though it contains an assistant text block (decision 13)', () => {
  const entries = loadSessionFixture('session-midturn.jsonl');
  // Sanity-check the fixture actually has the shape decision 13 requires, so this test cannot
  // pass vacuously against a fixture that was silently replaced with something trivial. The
  // fixture has TWO toolUse-stopped assistant messages — the first carries no text (thinking
  // + toolCall only), the second carries thinking + text + toolCall — so this must find the
  // one that actually has a text block, not just any toolUse message.
  const midTurnAssistant = entries.find(
    (e) =>
      e.type === 'message' &&
      e.message?.role === 'assistant' &&
      e.message?.stopReason === 'toolUse' &&
      e.message.content.some((b) => b.type === 'text'),
  );
  assert.ok(midTurnAssistant, 'fixture must contain a toolUse-stopped assistant message with a text block');

  const folded = foldSessionEntries(entries);
  assert.strictEqual(folded.settled, false);
  // The mid-turn text block IS still tracked (not thrown away), it just must not be reported
  // as a finished answer — outcomeForFold only classifies once settled or died.
  assert.strictEqual(folded.lastAssistantText, 'REDACTED-assistant-text');
});

test('session-settled-no-text.jsonl folds to settled with empty text, mapping to exit 4', () => {
  const folded = foldSessionEntries(loadSessionFixture('session-settled-no-text.jsonl'));
  assert.strictEqual(folded.settled, true);
  assert.strictEqual(folded.died, false);
  assert.strictEqual(folded.lastAssistantText, '');
  const outcome = outcomeForFold(folded);
  assert.strictEqual(outcome, 'settled-no-text');
  assert.strictEqual(exitCodeForOutcome(outcome), 4);
  // session-settled-no-text.jsonl is a DERIVATION of session-settled.jsonl (the caller dropped
  // the trailing text block from the final message), not an independently captured run — see
  // the brief's decision 20 and the fixture table it names.
});

test('a trailing assistant message with stopReason "error" is not settled, and is surfaced', () => {
  // Synthetic minimal record, using the exact field shapes the real fixtures already
  // establish (role/content/stopReason/rawStopReason) — not a new fixture file.
  const entries = [
    {
      type: 'message',
      timestamp: '2026-08-26T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', rawStopReason: 'server_error' },
    },
  ];
  const folded = foldSessionEntries(entries);
  assert.strictEqual(folded.settled, false);
  assert.strictEqual(folded.erroredStopReasons.length, 1);
  assert.strictEqual(folded.erroredStopReasons[0].stopReason, 'error');
});

test('stopReason "length" is settled; an unrecognised stopReason is not', () => {
  const lengthEntries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stopReason: 'length' } },
  ];
  assert.strictEqual(foldSessionEntries(lengthEntries).settled, true);

  const unrecognisedEntries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stopReason: 'some-new-value-not-in-the-union' } },
  ];
  assert.strictEqual(foldSessionEntries(unrecognisedEntries).settled, false);
});

test('paneDead: true with no settle folds to died, mapping to exit 3', () => {
  const entries = loadSessionFixture('session-midturn.jsonl'); // last message is a toolResult, never settles
  const folded = foldSessionEntries(entries, { paneDead: true });
  assert.strictEqual(folded.settled, false);
  assert.strictEqual(folded.died, true);
  assert.strictEqual(outcomeForFold(folded), 'died');
  assert.strictEqual(exitCodeForOutcome(outcomeForFold(folded)), 3);
});

test('an empty entry list with paneDead: false is neither settled nor died (the absent-file case)', () => {
  const folded = foldSessionEntries([], { paneDead: false });
  assert.strictEqual(folded.settled, false);
  assert.strictEqual(folded.died, false);
  assert.strictEqual(outcomeForFold(folded), null);
});

test('foldSessionEntries returns foldEvents\'s shape plus exactly one extra field', () => {
  const sessionShape = Object.keys(foldSessionEntries([])).sort();
  const eventShape = Object.keys(foldEvents([])).sort();
  for (const key of eventShape) {
    assert.ok(sessionShape.includes(key), `foldSessionEntries is missing "${key}"`);
  }
  // Both directions, not just one: outcomeForFold/exitCodeForOutcome are shared by both
  // backends, so an accidental extra field here is drift between them. erroredStopReasons is
  // the ONE deliberate addition (the session file's counterpart to extension errors).
  const extra = sessionShape.filter((key) => !eventShape.includes(key));
  assert.deepStrictEqual(extra, ['erroredStopReasons']);
});
