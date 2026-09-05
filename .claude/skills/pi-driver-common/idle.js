// idle.js — the idle floor formula and the event-aware watchdog that applies it.
//
// Two separate concerns live here, deliberately kept apart:
//   1. computeIdleSeconds — a pure function: given how big the loaded surface is, how long
//      should we wait for the first token before calling it a stall?
//   2. IdleWatchdog — a small stateful object that owns exactly one rule inherited from the
//      one-shot driver (skills/pi-subagent/pi-agent.sh): a tool call in flight suspends the
//      idle clock, because a legitimately long silent tool (a ten-minute test run that prints
//      nothing) is not a stall. Copy that rule, don't re-derive it.

// Measured anchor for the constants below (see CONTRACT.md for the full write-up): a cold
// start with the full extension surface loaded and -a reported usage.input = 23974 tokens
// and its first message_update arrived at 13,274 ms; the same model with -ne -nt produced
// its first event at 499 ms. ~24K tokens is ~96KB. Plugging that into the formula below
// gives 124s — comfortably past the 90s that a later task records as having killed a real
// run — while a trivial prompt stays at the 60s floor. Do not re-tune the curve here; the
// tests assert its *shape* (rises with size, never below the floor, explicit override wins
// verbatim) so a future re-tune of the constants invalidates no test.
const IDLE_FLOOR_SECONDS = 60;
const IDLE_BYTES_PER_SECOND = 1024;
const IDLE_MARGIN_SECONDS = 30;

/**
 * The idle timeout (in seconds) a driver should apply before treating model silence as a
 * stall, given how much text the model has to read before it can respond.
 *
 * @param {object} [opts]
 * @param {number} [opts.promptBytes] Size of the prompt text being sent, in bytes.
 * @param {number} [opts.surfaceBytes] Size of the loaded tool/extension surface, in bytes.
 * @param {number} [opts.explicitIdle] A caller-supplied override. When present (including
 *   `0`, which means "disabled"), it is returned verbatim and the formula is not consulted —
 *   an explicit choice always wins over a computed guess.
 * @returns {number}
 */
export function computeIdleSeconds({ promptBytes = 0, surfaceBytes = 0, explicitIdle } = {}) {
  if (explicitIdle !== undefined) return explicitIdle;
  const bytes = promptBytes + surfaceBytes;
  return Math.max(IDLE_FLOOR_SECONDS, Math.ceil(bytes / IDLE_BYTES_PER_SECOND) + IDLE_MARGIN_SECONDS);
}

// The formula above was written against PROMPT bytes (see the anchor comment above: ~24K
// tokens of PROMPT is ~96KB), but the quantity a driver can cheaply *measure* without a model
// call is the size of the `get_commands` catalogue response — the tool/extension surface
// description, not a prompt. The two are not the same number, and feeding the raw catalogue
// size straight into computeIdleSeconds does nothing: measured in this repo, a full-surface
// `get_commands` response is 26,710 bytes, and ceil(26710/1024)+30 = 57, which the 60s floor
// swallows completely — no rise at all.
//
// Measured anchor for the conversion, both halves from this repo with the full surface loaded
// and -a: the prompt is ~95,896 bytes (this is the same 23,974-input-token measurement the
// header comment above already calls "~96KB"), while a `get_commands` response for that same
// surface is 26,710 bytes. 95896 / 26710 = 3.59 (rounded to 3.6 below). Per this file's
// existing convention, tests assert the helper's *shape* (monotonic, ~3.6x, one worked
// example) rather than pinning the constant, so a later re-measurement does not invalidate a
// test.
export const CATALOGUE_TO_PROMPT_BYTES = 3.6;

/**
 * Convert a measured `get_commands` catalogue response size into the prompt-byte-equivalent
 * quantity `computeIdleSeconds`'s formula actually documents (see the anchor comment above).
 * @param {number} catalogueBytes Byte length of the raw `get_commands` response line.
 * @returns {number}
 */
export function surfaceBytesFromCatalogue(catalogueBytes) {
  return Math.round(catalogueBytes * CATALOGUE_TO_PROMPT_BYTES);
}

/**
 * Event-aware idle watchdog. Feed it every event a session produces; ask it whether the
 * silence since the last event has exceeded the timeout. While a tool call is in flight the
 * answer is always "no" — the model is legitimately busy, not stuck.
 */
export class IdleWatchdog {
  /**
   * @param {object} opts
   * @param {number} opts.idleSeconds Timeout in seconds; `0` disables the watchdog entirely
   *   (mirrors computeIdleSeconds's explicit-0-means-disabled convention).
   * @param {() => number} [opts.now] Clock source, in milliseconds. Injected so tests never
   *   depend on real timers.
   */
  constructor({ idleSeconds, now = Date.now }) {
    this.idleSeconds = idleSeconds;
    this.now = now;
    this.lastActiveMs = now();
    // Count rather than a boolean: tool calls are not guaranteed to be non-overlapping in
    // principle, and a count is exactly as cheap to maintain and strictly more correct.
    this.pendingToolCalls = 0;
  }

  /**
   * Record one parsed event from the session stream. Any event at all counts as activity
   * (matches pi-agent.sh: "any new output ... counts as activity"), and tool_execution_start
   * / tool_execution_end additionally step the in-flight counter that suspends the timeout.
   * @param {{type?: string}} event
   */
  feed(event) {
    this.lastActiveMs = this.now();
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'tool_execution_start') {
      this.pendingToolCalls += 1;
    } else if (event.type === 'tool_execution_end') {
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
    }
  }

  /**
   * Has the watchdog's timeout elapsed since the last activity, with no tool in flight?
   * @returns {boolean}
   */
  timedOut() {
    if (this.idleSeconds <= 0) return false; // 0 = disabled, verbatim
    if (this.pendingToolCalls > 0) return false; // suspended: a tool is legitimately busy
    return this.now() - this.lastActiveMs >= this.idleSeconds * 1000;
  }
}
