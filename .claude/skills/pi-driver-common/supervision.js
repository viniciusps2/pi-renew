// supervision.js — the pure core that turns a post-restart event slice into a supervision verdict.
//
// This is the decision-only half of the driver-side supervision that
// `pi-renew-restart-reliability` §4 asks for: given the slice of events a *replacement* session
// produced after a restart, decide exactly one of four verdicts (a settled continuation, a bounded
// no-continuation failure, an immediate "already processing" failure, or "not yet decidable"). The
// LIVE driver that feeds this a real slice — the part that detects that a restart actually happened
// and reports the verdict as a named event — is a separate, later batch. This file is deliberately
// pure and timer-free so it is unit-testable in isolation: the clock is injected through
// `superviseRestart(events, { now })`, mirroring idle.js's `now` injection rather than reading
// Date.now itself.
//
// The settle rule this module reuses is session.js#foldEvents', cited rather than re-derived: a run
// is settled exactly when the most recent of {agent_start, agent_settled} seen so far is
// agent_settled (agent_start resets it, agent_settled sets it; the settle source is agent_settled
// and nothing else — a tool call is an assistant message and must not read as "done").
//
// The "distinct, stable signal" this produces is a *named verdict + signal name*, NOT a sixth exit
// code: the five-code table in exit-codes.js is shared by all three drivers and is left untouched.
// See CONTRACT.md, "Restart supervision (a verdict, not a seventh verb)".

/** A settled continuation turn appeared in the replacement session within the window. */
export const VERDICT_SUCCESS = 'success';

/** The window elapsed with no settled continuation turn — the bounded, distinct restart failure. */
export const VERDICT_NO_CONTINUATION = 'no-continuation';

/** An "already processing" extension_error was observed: a loud, immediate restart failure,
 * decided the moment it appears rather than being gated on the window. */
export const VERDICT_ALREADY_PROCESSING = 'already-processing';

/** Not yet decidable: the window has not elapsed and there is no terminal evidence yet. */
export const VERDICT_PENDING = 'pending';

/**
 * The full verdict set, frozen so a caller cannot silently extend or mutate it. The four values are
 * exactly the four tokens above; a distinct-signal consumer (the later live batch) can key on these
 * without re-spelling the literals. Kept frozen — matching how exit-codes.js keeps its table stable —
 * so a mutation attempt throws under strict mode instead of drifting a driver's behaviour.
 * @type {Readonly<{SUCCESS: string, NO_CONTINUATION: string, ALREADY_PROCESSING: string, PENDING: string}>}
 */
export const SUPERVISION_VERDICTS = Object.freeze({
  SUCCESS: VERDICT_SUCCESS,
  NO_CONTINUATION: VERDICT_NO_CONTINUATION,
  ALREADY_PROCESSING: VERDICT_ALREADY_PROCESSING,
  PENDING: VERDICT_PENDING,
});

// A Set view of the same four tokens for cheap membership tests (isSupervisionVerdict below).
const SUPERVISION_VERDICT_SET = new Set([
  VERDICT_SUCCESS,
  VERDICT_NO_CONTINUATION,
  VERDICT_ALREADY_PROCESSING,
  VERDICT_PENDING,
]);

/**
 * Is `v` one of the four supervision verdict tokens?
 * @param {unknown} v
 * @returns {boolean} true iff `v` is one of the four exported verdict tokens.
 */
export function isSupervisionVerdict(v) {
  return SUPERVISION_VERDICT_SET.has(v);
}

/**
 * Default supervision window, in milliseconds (60 s). Comfortably above the observed healthy
 * handover/replacement latency (a re-key was measured ~4 s after the send; the on-disk replacement
 * was born ~23 s after the trigger, in the failure analysis this module came from), so a
 * slow-but-healthy handoff is not a false positive, while still bounding the wait. Overridable per
 * call; tests use small injected windows and never depend on this default.
 * @type {number}
 */
export const DEFAULT_SUPERVISION_WINDOW_MS = 60000;

// The one-to-one verdict → named-signal map. The signal name is the string the later live batch
// will emit as a named event; it is deliberately distinct from (and additive to) the five-code
// exit table, which this module never touches.
const VERDICT_TO_SIGNAL_NAME = {
  [VERDICT_SUCCESS]: 'restart-supervision:success',
  [VERDICT_NO_CONTINUATION]: 'restart-supervision:no-continuation',
  [VERDICT_ALREADY_PROCESSING]: 'restart-supervision:already-processing',
  [VERDICT_PENDING]: 'restart-supervision:pending',
};

/**
 * The named event / status string for a supervision verdict, for the later live batch to emit.
 * One-to-one with the four tokens:
 *   "success" → "restart-supervision:success"
 *   "no-continuation" → "restart-supervision:no-continuation"
 *   "already-processing" → "restart-supervision:already-processing"
 *   "pending" → "restart-supervision:pending"
 * @param {string} verdict One of the four supervision verdict tokens.
 * @returns {string} The matching `restart-supervision:<token>` name.
 * @throws {Error} If `verdict` is not one of the four tokens (/unknown supervision verdict/).
 */
export function supervisionSignalName(verdict) {
  const name = VERDICT_TO_SIGNAL_NAME[verdict];
  if (name === undefined) {
    throw new Error(`supervisionSignalName: unknown supervision verdict "${verdict}"`);
  }
  return name;
}

/**
 * Classify a single `extension_error` as restart-failure evidence or not (task 4.2).
 *
 * EXACT rule, not a blanket "any error": the (lowercased) message must contain **both**
 * "already processing" **and** "streamingbehavior" to be `"restart-failed"`; otherwise it is
 * `"not-restart-failed"`. Requiring *both* substrings is what keeps it exact — an unrelated error
 * that happens to say "already processing" but not "streamingBehavior" is NOT this class, and
 * neither is any other kind of error. This is the "already processing / specify streamingBehavior"
 * class design D5 folds into *supervision* (the extension cannot see it — fire-and-forget — so it is
 * the driver's to catch, and it is the *loud*, immediate face of a restart that never completed).
 *
 * Accepts either a bare message string or an `extension_error` event object (for an object, its
 * `error` field is read; a missing/`null`/`undefined` field reads as an empty message).
 *
 * Worked examples (mirrored verbatim in the test):
 *   - the SDK throw (docs …-throw.md §14, the `agent-session.js` throw):
 *       "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
 *       → "restart-failed"
 *   - "pi-renew: Cannot read properties of undefined (reading 'sessionId')" (F143)
 *       → "not-restart-failed"
 *   - a send `extension_error` (`event:"send_user_message"`) with no such text
 *       → "not-restart-failed"
 *   - a message of only "Agent is already processing." (no "streamingBehavior")
 *       → "not-restart-failed"
 * @param {string | {error?: string}} err The raw message, or an `extension_error` event object.
 * @returns {"restart-failed"|"not-restart-failed"}
 */
export function classifyRestartExtensionError(err) {
  // Accept a bare string or an {error} object; an object with no usable `error` reads as "".
  const message = (typeof err === 'string' ? err : err?.error ?? '').toString();
  const lowered = message.toLowerCase();
  if (lowered.includes('already processing') && lowered.includes('streamingbehavior')) {
    return 'restart-failed';
  }
  return 'not-restart-failed';
}

/**
 * Fold a **post-restart event slice** into a single supervision verdict (tasks 4.1 + 4.3).
 *
 * `events` is the *post-restart* slice the caller has already delimited (the function does NOT search
 * for a session boundary — the caller decides where the slice starts). Each event may carry
 * `type: string` and `ts: number` (ms clock), reusing the RPC event vocabulary session.js uses
 * (`agent_start`, `agent_settled`, `message_end`, `extension_error`, `session`/`session_info`).
 *
 * `opts.windowMs` is the supervision window (default `DEFAULT_SUPERVISION_WINDOW_MS`); `opts.now`
 * is the **current** clock in the same ms units as the events' `ts` (injected, never read from
 * Date.now here — mirroring idle.js's clock injection, so tests use no real timers).
 *
 * `t0` is the `ts` of the **first** event (the start of observation). If the slice is empty there
 * is nothing to supervise → `VERDICT_PENDING`.
 *
 * Precedence (first match wins):
 *   1. any `extension_error` in the slice that `classifyRestartExtensionError` calls
 *      `"restart-failed"` → `VERDICT_ALREADY_PROCESSING` — immediate, decided the moment it
 *      appears, **not** gated on the window (the loud face D5 folds into supervision).
 *   2. else a **settled continuation turn** (the slice's most recent `{agent_start, agent_settled}`
 *      resolves to `agent_settled` — session.js#foldEvents' settle rule) whose `ts <= t0 + windowMs`
 *      → `VERDICT_SUCCESS`. The boundary is INCLUSIVE: a settled turn at exactly `t0 + windowMs`
 *      still counts ("just inside W").
 *   3. else if `now - t0 >= windowMs` (the window elapsed with no settled turn) →
 *      `VERDICT_NO_CONTINUATION` — the bounded, distinct failure.
 *   4. else → `VERDICT_PENDING`.
 *
 * "Some activity before W ⇒ not a failure" (the D4 false-positive risk row): `VERDICT_NO_CONTINUATION`
 * is reachable **only** once `now - t0 >= windowMs`. While the window is still open (`now - t0 <
 * windowMs`), the verdict is at worst `VERDICT_PENDING`, even if the only events are activity that
 * has not yet settled — this is what distinguishes "slow-but-healthy" (activity, then settles) from
 * "truly dead" (nothing at all, the window elapses).
 *
 * @param {Array<{type?: string, ts?: number, error?: string, [key: string]: unknown}>} events
 *   The ordered post-restart event slice.
 * @param {object} [opts]
 * @param {number} [opts.windowMs] The supervision window in ms (default `DEFAULT_SUPERVISION_WINDOW_MS`).
 * @param {number} opts.now The current clock, in the same ms units as the events' `ts`.
 * @returns {"success"|"no-continuation"|"already-processing"|"pending"}
 */
export function superviseRestart(events, { windowMs = DEFAULT_SUPERVISION_WINDOW_MS, now } = {}) {
  // (1) The loud face: any "already processing / streamingBehavior" extension_error decides the
  //     verdict immediately, the moment it appears — before the window is even consulted.
  for (const event of events) {
    if (event && event.type === 'extension_error' && classifyRestartExtensionError(event) === 'restart-failed') {
      return VERDICT_ALREADY_PROCESSING;
    }
  }

  // An empty slice has no first event, hence no t0 to measure a window against: nothing to supervise.
  const first = events[0];
  if (!first) return VERDICT_PENDING;
  const t0 = first.ts;

  // (2) settle rule — session.js#foldEvents': agent_start resets, agent_settled sets; the settle
  //     source is agent_settled and nothing else. Track whether the slice's most recent
  //     {agent_start, agent_settled} resolves to agent_settled, and its ts (the settled turn's ts).
  let settled = false;
  /** @type {number|undefined} */
  let settledTs;
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'agent_start') {
      settled = false;
      settledTs = undefined;
    } else if (event.type === 'agent_settled') {
      settled = true;
      settledTs = event.ts;
    }
  }

  // A settled continuation turn that landed within the window is a success (boundary inclusive:
  // `settledTs <= t0 + windowMs`). `settledTs != null` guards a settle event that carries no ts.
  if (settled && settledTs != null && settledTs <= t0 + windowMs) {
    return VERDICT_SUCCESS;
  }

  // (3) the window elapsed with no settled turn: the bounded, distinct failure. Only reachable once
  //     `now - t0 >= windowMs` — while the window is open the verdict stays PENDING below.
  if (now - t0 >= windowMs) {
    return VERDICT_NO_CONTINUATION;
  }

  // (4) not yet decidable.
  return VERDICT_PENDING;
}
