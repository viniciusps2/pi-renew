import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICT_SUCCESS,
  VERDICT_NO_CONTINUATION,
  VERDICT_ALREADY_PROCESSING,
  VERDICT_PENDING,
  SUPERVISION_VERDICTS,
  isSupervisionVerdict,
  DEFAULT_SUPERVISION_WINDOW_MS,
  supervisionSignalName,
  classifyRestartExtensionError,
  superviseRestart,
} from '../supervision.js';

// The exact SDK streaming-guard throw (docs/delegate-restart-streaming-throw.md §14, the
// agent-session.js throw). Contains BOTH "already processing" and "streamingBehavior".
const SDK_THROW =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

/** An `extension_error` event carrying the given message, at the given ms clock. */
function extError(ts, error, event) {
  return { type: 'extension_error', ts, error, event };
}

// --- superviseRestart — the pure "feed events -> verdict" function (tasks 4.1 + 4.3) ---

test('a settled continuation turn within the window is VERDICT_SUCCESS', () => {
  // A settled turn at ts 4000, window 10000, observed while the window is still open (now 8000):
  // success is decided from the settle's own ts, not from `now`.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'agent_settled', ts: 4000 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 8000 }), VERDICT_SUCCESS);
});

test('a settled turn at exactly t0 + windowMs is VERDICT_SUCCESS (inclusive boundary)', () => {
  // The settle lands at exactly the window edge (ts 10000, t0 0, window 10000). `now` is set so
  // the window has *also* elapsed (now - t0 = 10000 >= windowMs) — so this single test proves the
  // inclusive boundary beats the window-elapsed check: a turn arriving "just inside W" is a success,
  // not a no-continuation. A `<` (exclusive) boundary would fall through to NO_CONTINUATION.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'agent_settled', ts: 10000 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 10000 }), VERDICT_SUCCESS);
});

test('a settled turn just outside the window is NOT success (boundary from the other side)', () => {
  // ts 10001 is 1ms past the window edge; with the window now elapsed, that settles to the failure.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'agent_settled', ts: 10001 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 20000 }), VERDICT_NO_CONTINUATION);
});

test('no settled turn: PENDING while the window is open, NO_CONTINUATION once it elapses (the 4.3 pair)', () => {
  // The load-bearing 4.3 assertion: the SAME slice reads PENDING before the window elapses and
  // NO_CONTINUATION once it has — a failure is never reported while the window is still open, which
  // is the "slow-but-healthy vs truly-dead" distinction the design's risk row demands.
  const events = [{ type: 'agent_start', ts: 0 }]; // activity, but it has not settled

  // Window open (now - t0 = 5000 < 10000): must be PENDING, never NO_CONTINUATION.
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 5000 }), VERDICT_PENDING);
  // Window elapsed (now - t0 = 10000 >= 10000): NO_CONTINUATION.
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 10000 }), VERDICT_NO_CONTINUATION);
});

test('an agent_start with no following agent_settled reads as NOT settled (the settle trap)', () => {
  // A tool-call assistant message (message_end) arrives mid-turn, but the settle source is
  // agent_settled and nothing else (session.js#foldEvents); a message_end must not read as settled.
  // Here the window has elapsed, so "not settled" lands on the failure rather than a success.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'message_end', ts: 3000 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 20000 }), VERDICT_NO_CONTINUATION);
});

test('an agent_settled followed by a later agent_start resolves to NOT settled (fold rule reset)', () => {
  // The most recent of {agent_start, agent_settled} is agent_start, so the run reopens — even though
  // an agent_settled appeared earlier in the same slice, that turn no longer reads as settled.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'agent_settled', ts: 2000 },
    { type: 'agent_start', ts: 5000 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 20000 }), VERDICT_NO_CONTINUATION);
});

test('an "already processing" extension_error is VERDICT_ALREADY_PROCESSING immediately, even before the window', () => {
  // The loud face (D5): decided the moment the error appears, NOT gated on the window. `now - t0`
  // is only 2000 (< windowMs 10000), so this could not be a window timeout — it is the error itself.
  const events = [extError(0, SDK_THROW, 'send_user_message')];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 2000 }), VERDICT_ALREADY_PROCESSING);
});

test('an "already processing" error wins over a settled turn (precedence: the loud face first)', () => {
  // Even with a settled turn present, the restart-failed extension_error is checked first and wins.
  const events = [
    { type: 'agent_start', ts: 0 },
    extError(1000, SDK_THROW, 'send_user_message'),
    { type: 'agent_settled', ts: 5000 },
  ];
  assert.strictEqual(superviseRestart(events, { windowMs: 10000, now: 8000 }), VERDICT_ALREADY_PROCESSING);
});

test('an empty post-restart slice is VERDICT_PENDING (nothing to supervise)', () => {
  assert.strictEqual(superviseRestart([], { windowMs: 10000, now: 100000 }), VERDICT_PENDING);
});

// --- classifyRestartExtensionError (task 4.2) ---

test('the exact SDK "already processing" throw string is restart-failed', () => {
  assert.strictEqual(classifyRestartExtensionError(SDK_THROW), 'restart-failed');
});

test('the F143 "Cannot read properties of undefined (reading sessionId)" error is NOT restart-failed', () => {
  assert.strictEqual(
    classifyRestartExtensionError("pi-renew: Cannot read properties of undefined (reading 'sessionId')"),
    'not-restart-failed',
  );
});

test('an unrelated send_user_message extension_error is NOT restart-failed', () => {
  assert.strictEqual(
    classifyRestartExtensionError(extError(0, 'pi-renew: some unrelated runtime error', 'send_user_message')),
    'not-restart-failed',
  );
});

test('"Agent is already processing." with no streamingBehavior is NOT restart-failed (exact, not blanket)', () => {
  // Has one of the two required substrings but not the other: this is the case that a blanket
  // "any error mentioning already processing" classifier would wrongly flag.
  assert.strictEqual(classifyRestartExtensionError('Agent is already processing.'), 'not-restart-failed');
});

test('classifyRestartExtensionError accepts both a bare string and an {error} object, to the same verdict', () => {
  // Positive class: bare string and event object agree.
  assert.strictEqual(classifyRestartExtensionError(SDK_THROW), 'restart-failed');
  assert.strictEqual(classifyRestartExtensionError({ type: 'extension_error', error: SDK_THROW }), 'restart-failed');
  // Negative class: bare string and event object agree too.
  assert.strictEqual(
    classifyRestartExtensionError("pi-renew: Cannot read properties of undefined (reading 'sessionId')"),
    'not-restart-failed',
  );
  assert.strictEqual(
    classifyRestartExtensionError({
      type: 'extension_error',
      event: 'send_user_message',
      error: "pi-renew: Cannot read properties of undefined (reading 'sessionId')",
    }),
    'not-restart-failed',
  );
  // A missing / null error field reads as an empty message, not a throw.
  assert.strictEqual(classifyRestartExtensionError({ type: 'extension_error' }), 'not-restart-failed');
});

// --- the verdict machinery: tokens, membership, and the named signal ---

test('SUPERVISION_VERDICTS is frozen and holds exactly the four token literals', () => {
  assert.ok(Object.isFrozen(SUPERVISION_VERDICTS), 'the verdict set must be frozen');
  // Exactly four keys, and their values are exactly the four exported tokens.
  assert.strictEqual(Object.keys(SUPERVISION_VERDICTS).length, 4);
  assert.deepStrictEqual(
    [...Object.values(SUPERVISION_VERDICTS)].sort(),
    [VERDICT_ALREADY_PROCESSING, VERDICT_NO_CONTINUATION, VERDICT_PENDING, VERDICT_SUCCESS].sort(),
  );
  // The tokens are the exact literals the decision pins.
  assert.strictEqual(VERDICT_SUCCESS, 'success');
  assert.strictEqual(VERDICT_NO_CONTINUATION, 'no-continuation');
  assert.strictEqual(VERDICT_ALREADY_PROCESSING, 'already-processing');
  assert.strictEqual(VERDICT_PENDING, 'pending');
  // Frozen: mutating it throws under strict mode (ESM is always strict).
  assert.throws(() => {
    SUPERVISION_VERDICTS.SUCCESS = 'hacked';
  }, TypeError);
});

test('isSupervisionVerdict is true for each token and false for a made-up one', () => {
  for (const v of [VERDICT_SUCCESS, VERDICT_NO_CONTINUATION, VERDICT_ALREADY_PROCESSING, VERDICT_PENDING]) {
    assert.strictEqual(isSupervisionVerdict(v), true, `expected isSupervisionVerdict("${v}") to be true`);
  }
  assert.strictEqual(isSupervisionVerdict('made-up-token'), false);
  assert.strictEqual(isSupervisionVerdict(''), false);
  assert.strictEqual(isSupervisionVerdict(undefined), false);
});

test('supervisionSignalName maps each token to its restart-supervision:<token> name', () => {
  assert.strictEqual(supervisionSignalName(VERDICT_SUCCESS), 'restart-supervision:success');
  assert.strictEqual(supervisionSignalName(VERDICT_NO_CONTINUATION), 'restart-supervision:no-continuation');
  assert.strictEqual(supervisionSignalName(VERDICT_ALREADY_PROCESSING), 'restart-supervision:already-processing');
  assert.strictEqual(supervisionSignalName(VERDICT_PENDING), 'restart-supervision:pending');
});

test('supervisionSignalName throws on an unknown verdict', () => {
  assert.throws(() => supervisionSignalName('definitely-not-a-verdict'), /unknown supervision verdict/);
  assert.throws(() => supervisionSignalName(''), /unknown supervision verdict/);
});

test('DEFAULT_SUPERVISION_WINDOW_MS is the 60 s default the decision pins', () => {
  assert.strictEqual(DEFAULT_SUPERVISION_WINDOW_MS, 60000);
  // The window is overridable: a call that omits windowMs uses the default, and a settle well past
  // it (with the window elapsed) is no-continuation, not success.
  const events = [
    { type: 'agent_start', ts: 0 },
    { type: 'agent_settled', ts: 120000 }, // 120 s after t0, past the 60 s default
  ];
  assert.strictEqual(superviseRestart(events, { now: 300000 }), VERDICT_NO_CONTINUATION);
});
