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
    return "A restart is already in progress. Stand down — do not call `delegate_context_high` again this run; it will complete on its own.";
  }
  return "Stop work and delegate now.";
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
