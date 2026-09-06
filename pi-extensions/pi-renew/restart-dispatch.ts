/**
 * Pre-dispatch resolvability check + machine-readable status token for the
 * `new-session` restart path.
 *
 * WHY a separate module: `pi-renew.ts` is the extension entry point; it is
 * loaded once per session. The dispatch check and the status token are the
 * *observable surface* of that dispatch — the one thing an external actor
 * (driver, reminder, test) can key on without parsing prose. Keeping them in
 * their own module lets the driver (§4) and the reminder (§2.3) import a
 * stable API without importing the whole extension factory.
 *
 * The `DispatchRunner` interface is the narrowest observable model of the
 * dispatching runner the extension can build from `pi.getCommands()` alone.
 * The SDK's real `getCommand` is private; deriving it from the public list is
 * the faithful, observable proxy (design D2: the extension can only see its
 * own preconditions).
 */
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { resolveRestartCommandName } from "./pi-renew";

/**
 * The minimal surface the extension needs from the dispatching runner to
 * evaluate whether a restart can actually be dispatched: the command list and
 * a single-command lookup. In production the only implementation is built
 * from `pi.getCommands()`.
 */
export interface DispatchRunner {
  listCommands(): SlashCommandInfo[];
  getCommand(name: string): SlashCommandInfo | undefined;
}

/**
 * Evaluates whether a `new-session` restart can be dispatched through
 * `runner`, returning the resolved command name on success or an exact,
 * stable reason string on failure.
 *
 * Check order (fixed, do not reorder):
 * 1. `name === null` (nothing in the list matches) — the arm the existing
 *    `restart-failure.test.ts` integration test covers.
 * 2. `runner.getCommand(name) === undefined` — the list/lookup disagreement
 *    arm, proven only by the pure unit test in `restart-dispatch.test.ts`.
 * 3. Otherwise the dispatch is viable.
 *
 * The function is pure: no I/O, no side effects, no closure over `pi`.
 */
export function resolveDispatchableRestart(
  runner: DispatchRunner
): { ok: true; name: string } | { ok: false; reason: string } {
  const name = resolveRestartCommandName(runner.listCommands());
  if (name === null) {
    return {
      ok: false,
      reason: "the pi-renew command is not registered, so no restart could be dispatched",
    };
  }
  if (runner.getCommand(name) === undefined) {
    return {
      ok: false,
      reason:
        "the pi-renew command resolves by name but is not available on the dispatching runner, so no restart could be dispatched",
    };
  }
  return { ok: true, name };
}

/**
 * The shared model-facing signal for both the high-context reminder (§2.3)
 * and the tool-result stand-down text. A pure function: takes a boolean,
 * returns a string. No I/O, no clock, no random — deterministic for the same
 * input.
 */
export function renderRestartSignal(inFlight: boolean): string {
  if (inFlight) {
    return "A restart is already in progress. Stand down — do not call `renew_from_handover` again this run; it will complete on its own.";
  }
  return "Stop work and renew the session now.";
}

/**
 * The machine-readable status token carried on the tool result's `details`
 * field. The only valid values are `"pending"` (a fresh dispatch was
 * initiated; the outcome is not yet known) and `"stand-down"` (a repeat
 * request was blocked by an in-flight record). There is intentionally no
 * `"done"` value: the extension cannot observe a fire-and-forget dispatch
 * completing, so it must never claim completion (spec "No false
 * completion").
 */
export type RestartStatus = "pending" | "stand-down";

/**
 * Builds the `details` object for a restart tool result. Returns `{ status }`
 * plus `restartId` only when `extra?.restartId` is defined, so the shape is
 * minimal: a fresh dispatch carries just `{ status: "pending" }`, while a
 * stand-down carries `{ status: "stand-down", restartId: <n> }`.
 */
export function resultDetails(
  status: RestartStatus,
  extra?: { restartId?: number }
): { status: RestartStatus; restartId?: number } {
  if (extra?.restartId !== undefined) {
    return { status, restartId: extra.restartId };
  }
  return { status };
}

/**
 * The run modes in which this session can never be renewed. Mirrors the guard
 * in `executeRenewal` exactly (`ctx.mode === "print" || ctx.mode === "json"`):
 * `ctx.compact()` is fire-and-forget and does not start until the agent run has
 * settled, and a one-shot process is torn down at that point.
 */
const ONE_SHOT_MODES = new Set(["print", "json"]);

/**
 * The environment override, for a delegated session the mode alone cannot
 * identify. A worker driven over `--mode rpc` IS long-lived, so a restart would
 * technically succeed — and would still be wrong, because the parent is
 * blocking on a report, not on a renewed child. A launcher that spawns a
 * sub-agent sets this so the extension reports instead of restarting.
 */
export const REPORT_ONLY_ENV_VAR = "PI_RENEW_REPORT_ONLY";

/**
 * Whether this session must report rather than renew. True when the run mode
 * cannot support a restart at all, or when the launcher declared the session a
 * delegate via `PI_RENEW_REPORT_ONLY`.
 *
 * `"0"`, `"false"` and `""` are explicit opt-OUTs, so a launcher can export the
 * variable unconditionally and switch it per child. An UNSET variable is not an
 * opt-out — it leaves the decision to the mode.
 *
 * Pure over its arguments: `env` is injected, never read from `process.env`
 * here, so a test can drive both arms without mutating global state.
 */
export function isReportOnlySession(
  mode: string | undefined,
  env: Record<string, string | undefined> = {}
): boolean {
  const declared = env[REPORT_ONLY_ENV_VAR];
  if (declared !== undefined) {
    const normalized = declared.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "false") return false;
    return true;
  }
  return mode !== undefined && ONE_SHOT_MODES.has(mode);
}

/**
 * The shared model-facing directive for a report-only session — the counterpart
 * to `renderRestartSignal`, used verbatim by BOTH the high-context reminder and
 * the `tool_call` block reason. One string, two call sites, on purpose: a model
 * that is told one thing by the reminder and something else by the blocked tool
 * result will try to satisfy both.
 *
 * It names no tool as a next step and no file to write. The report IS the
 * deliverable: the caller reads it off this session's final answer.
 */
export function renderReportOnlyDirective(): string {
  return [
    "This session cannot be renewed or restarted — it is a one-shot or delegated run, and every renewal tool is blocked here.",
    "Do not call `renew_session` or `renew_from_handover`. There is no handover file to write.",
    "Stop work now and end your turn with a final report, written as your answer. Include, in this order:",
    "- **Stopped early** — say plainly that you ran out of context window, and that the work is INCOMPLETE. Do not describe a partial result as a finished one.",
    "- **Done** — what you actually completed, naming the files you changed.",
    "- **Not done** — what is still missing from your brief, in the order it should be picked up.",
    "- **Next** — the single next action a fresh session should take first.",
    "- **Context to carry over** — decisions you made, what you learned, and what a fresh session should avoid repeating.",
    "Produce no further tool calls. Your caller reads this report and starts a fresh session from it.",
  ].join("\n");
}
