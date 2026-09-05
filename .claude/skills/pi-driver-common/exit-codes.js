// exit-codes.js — the numbering every driver skill (pi-subagent, pi-subagent-rpc,
// pi-subagent-tmux) reports through. See CONTRACT.md for the rules that decide *which*
// outcome a run had; this module only names the numbers once so three skills cannot drift
// into three different tables.
//
// The numbers themselves are NOT new: they are lifted verbatim from the existing one-shot
// driver (skills/pi-subagent/pi-agent.sh, "Exit codes: 0 ok · 2 usage · 3 no completion ·
// 4 completed but empty · 124 ceiling exceeded"). A cross-verification task later in this
// change (checking all drivers agree) is only meaningful if every driver adopts the same
// numbering rather than inventing its own — so these are constants, not a fresh design.

/** Settled, and the session produced assistant text. */
export const EXIT_SETTLED_WITH_TEXT = 0;

/** Usage error — bad flags, an unqualified or unknown model id, a missing run directory. */
export const EXIT_USAGE = 2;

/** The session died: the stream ended, or the process exited, with no `agent_settled`. */
export const EXIT_DIED = 3;

/** Settled, but the session produced no assistant text. */
export const EXIT_SETTLED_NO_TEXT = 4;

/** The absolute wall-clock ceiling was exceeded. */
export const EXIT_TIMEOUT = 124;

// The three outcomes a folded session (see session.js) can resolve to. Kept as string
// literals rather than an enum object so a test can assert the mapping without importing
// anything from this module but the function under test — see exit-codes.test.js.
const OUTCOME_TO_CODE = {
  'settled-with-text': EXIT_SETTLED_WITH_TEXT,
  'settled-no-text': EXIT_SETTLED_NO_TEXT,
  died: EXIT_DIED,
};

/**
 * Map a session outcome to its exit code.
 * @param {"settled-with-text"|"settled-no-text"|"died"} outcome
 * @returns {number}
 */
export function exitCodeForOutcome(outcome) {
  if (!Object.prototype.hasOwnProperty.call(OUTCOME_TO_CODE, outcome)) {
    throw new Error(`exitCodeForOutcome: unknown outcome "${outcome}"`);
  }
  return OUTCOME_TO_CODE[outcome];
}

/**
 * Human-readable reason for an exit code, for --help text and error messages.
 * @param {number} code
 * @returns {string}
 */
export function reasonForExitCode(code) {
  switch (code) {
    case EXIT_SETTLED_WITH_TEXT:
      return 'settled, and the session produced assistant text';
    case EXIT_USAGE:
      return 'usage error — bad flags, an unqualified or unknown model id, or a missing run directory';
    case EXIT_DIED:
      return 'the session died: the stream ended, or the process exited, with no agent_settled';
    case EXIT_SETTLED_NO_TEXT:
      return 'settled, but the session produced no assistant text';
    case EXIT_TIMEOUT:
      return 'the absolute wall-clock ceiling was exceeded';
    default:
      return `unrecognised exit code ${code}`;
  }
}
