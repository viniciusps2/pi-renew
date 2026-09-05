import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Type, Static } from "typebox";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import {
  loadConfig,
  resolveModelId,
  getHighContextReminderConfig,
} from "./config";
import {
  RENEWAL_STATE_VERSION,
  type RenewalState,
  resolveRenewalState,
  writeRenewalState,
  reapRenewalStates,
  claimRestartOrdinal,
  sessionIdFromSessionFile,
} from "./renewal-state";
import {
  type RestartInflight,
  checkRestartInFlight,
  beginRestart,
  adoptRestartInflight,
  markRestartInflightDelivered,
  wasHandoffDelivered,
} from "./restart-inflight";
import {
  type DispatchRunner,
  resolveDispatchableRestart,
  resultDetails,
  renderRestartSignal,
  isReportOnlySession,
  renderReportOnlyDirective,
} from "./restart-dispatch";
import {
  validateRenewalContext,
  parseRenewCommandArgs,
  isPiRenewRestartCommandName,
} from "./renewal-context";
import { assembleRestartPayload } from "./restart-payload";
import {
  sendExtensionCommand,
  sendPayload,
  sendRestartPrelude,
  type CustomMessageSender,
  type UserMessageSender,
} from "./send-shapes";

/**
 * pi-renew — session renewal via restart or compaction
 *
 * Uses Pi's built-in compaction infrastructure to renew a session in place:
 *
 * 1. Agent calls renew_session with structured summary and next steps
 * 2. Tool sets a pendingRenewal flag and triggers ctx.compact()
 * 3. session_before_compact fires — if the flag is set, returns
 *    the agent's summary as a CompactionResult (skips the LLM call)
 * 4. If the flag is NOT set (normal /compact or auto-compaction),
 *    the handler returns nothing and Pi runs its default compaction
 *
 * Result: proper CompactionEntry in the session, old messages pruned,
 * zero LLM calls, and /compact still works normally.
 *
 * The extension is a restart primitive with no opinions about the caller's
 * workflow: it carries a summary, next steps and an opaque reason, plus a
 * caller-registered renewal context replayed verbatim into the replacement
 * session. It does not resolve personas by looking up prompt files and does
 * not mint artifact paths of its own — a caller wanting a specific persona
 * after a restart registers it in the renewal context instead.
 */

interface PendingRenewal {
  summary: string;
  nextSteps: string;
}

/**
 * Which high-context reminder this session gets.
 *
 * - `restart`     — the ordinary flow: write a handover, call `renew_from_handover`.
 * - `stand-down`  — a restart is already in flight; do nothing and let it land.
 * - `report-only` — this session can never restart (one-shot mode, or a launcher that
 *                   declared it a delegate). Stop and hand a report back to the caller,
 *                   who spawns a fresh session to continue. See `isReportOnlySession`.
 */
type ReminderVariant = "restart" | "stand-down" | "report-only";

const PLANNING_TASK_PATH_PATTERN = /([^\s"'`]+\/planning\/[^\s"'`]*task[^\s"'`]*\.md)\b/gi;

function getReminderMilestone(
  tokens: number | null | undefined,
  thresholdTokens: number,
  repeatEveryTokens: number
): number | null {
  if (tokens == null || tokens <= thresholdTokens) return null;
  const reminderIndex = Math.floor((tokens - thresholdTokens) / repeatEveryTokens);
  return thresholdTokens + reminderIndex * repeatEveryTokens;
}

// D-H24: the reminder used to mint its own tmpdir() path and tell the model to write
// there. That path was a private artifact convention the spec's "No workflow coupling"
// requirement forbids ("No private artifact paths"). The reminder now names no location
// at all — the caller chooses where to write the handover report and supplies that path
// back at call time, as renew_from_handover's required handoverPath argument.
function createHighContextReminder(
  tokens: number,
  thresholdTokens: number,
  contextWindow: number,
  variant: ReminderVariant = "restart"
): UserMessage {
  // D-RO1: `report-only` is checked FIRST, before `stand-down`. In a report-only
  // session no restart can be in flight in any way that matters — nothing here can
  // dispatch one — so an in-flight record read off disk (a stale file from an earlier
  // run in the same cwd) must not divert the model into standing down and waiting for
  // a restart that will never arrive. "This session cannot restart" outranks "a restart
  // is already running".
  const lines = variant === "report-only"
    ? [
        "System reminder: context usage is too high. Stop work and end this session now.",
        `Current estimated context: ${tokens} tokens of ${contextWindow} (threshold: ${thresholdTokens}).`,
        "",
        renderReportOnlyDirective(),
        "",
        "Do not inspect one more thing, do not debug, do not run more tests, and do not make more code changes in this session.",
        "Do not update task files, plan files, or any project files. Do not make any other change.",
      ]
    : variant === "stand-down"
    ? [
        `System reminder: context usage is too high. ${renderRestartSignal(true)}`,
        `Current estimated context: ${tokens} tokens of ${contextWindow} (threshold: ${thresholdTokens}).`,
        "Take no further action this run; do not call any renewal tool.",
      ]
    : [
        `System reminder: context usage is too high. ${renderRestartSignal(false)}`,
        `Current estimated context: ${tokens} tokens of ${contextWindow} (threshold: ${thresholdTokens}).`,
        "Write a complete handover report to a markdown file whose location you choose — the extension does not provide one.",
        "",
        "Do not inspect one more thing, do not debug, do not run more tests, and do not make more code changes in this session.",
        "Do these steps immediately, in order:",
        "1. Stop implementation work now.",
        "2. Write the complete handover report to that markdown file. The file must exist and must not be empty.",
        "3. Do not update task files, plan files, or any project files. Do not make any other change.",
        "4. Call `renew_from_handover` with `handoverPath` set to the exact path you just wrote.",
        "5. Do not call `renew_session` directly for this reminder-driven handoff.",
      ];
  return {
    role: "user",
    timestamp: Date.now(),
    content: lines.join("\n"),
  };
}

function collectStrings(value: unknown, strings: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (!value || typeof value !== "object") return strings;
  if (seen.has(value)) return strings;

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings, seen);
    return strings;
  }

  for (const nestedValue of Object.values(value)) {
    collectStrings(nestedValue, strings, seen);
  }

  return strings;
}

async function getSessionEntries(ctx: {
  sessionManager?: { getEntries?: () => unknown[] | Promise<unknown[]> };
}): Promise<unknown[]> {
  const entries = await ctx.sessionManager?.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}

function getPlanningTaskFiles(entries: unknown[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const text of collectStrings(entry)) {
      let match: RegExpExecArray | null;
      while ((match = PLANNING_TASK_PATH_PATTERN.exec(text)) !== null) {
        const filePath = match[1];
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        files.push(filePath);
      }
      PLANNING_TASK_PATH_PATTERN.lastIndex = 0;
    }
  }

  return files;
}

function appendLastTasksRead(summary: string, taskFiles: string[]): string {
  const tagLines =
    taskFiles.length === 0
      ? ["<last_tasks_read>", "</last_tasks_read>"]
      : ["<last_tasks_read>", ...taskFiles.map((file) => `- ${file}`), "</last_tasks_read>"];

  return `${summary.trim()}\n\n${tagLines.join("\n")}`;
}

/**
 * Resolves the live invocation name of this extension's own `/pi-renew` restart
 * command. `resolveRegisteredCommands` renames a colliding command to `pi-renew:2`,
 * `pi-renew:3`, … (F14, `runner.js:413-429`), so the literal string `"pi-renew"`
 * is not guaranteed to be dispatchable: the unsuffixed name is preferred when present,
 * otherwise the lowest numeric suffix. Returns null when nothing matches — decision 12's
 * third failure case reports that rather than falling back to the literal string, which
 * would reach the model as unexpanded prose (D-H11).
 */
export function resolveRestartCommandName(commands: SlashCommandInfo[]): string | null {
  const matches = commands.filter(
    (command) => command.source === "extension" && isPiRenewRestartCommandName(command.name)
  );

  const unsuffixed = matches.find((command) => command.name === "pi-renew");
  if (unsuffixed) return unsuffixed.name;

  let lowestSuffix: number | null = null;
  let lowestName: string | null = null;
  for (const command of matches) {
    const suffixMatch = /^pi-renew:(\d+)$/.exec(command.name);
    if (!suffixMatch) continue;
    const suffix = Number(suffixMatch[1]);
    if (lowestSuffix === null || suffix < lowestSuffix) {
      lowestSuffix = suffix;
      lowestName = command.name;
    }
  }
  return lowestName;
}

/**
 * The D-IN9 stand-down result for a blocked `new-session` restart request. A *distinct*
 * string — neither a success ("requested / pending") nor a bare "done" — so a re-reading
 * model does not mistake an in-flight restart for one it may safely re-fire (the D1
 * re-fire loop this guard exists to kill). `restartId` and `at` are taken verbatim from the
 * in-flight record that triggered the stand-down, so the message names the specific
 * restart the model is being told to wait for.
 */
function standDownText(record: RestartInflight): string {
  return `${renderRestartSignal(true)} (restartId ${record.restartId}, in-flight since ${record.at})`;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const highContextReminder = getHighContextReminderConfig(config);
  let pendingRenewal: PendingRenewal | null = null;
  let lastReminderMilestone: number | null = null;

  // Mirrors pendingRenewal exactly, for the new-session strategy: the tool sets this
  // immediately before dispatching the /pi-renew restart command, and the command
  // handler reads-and-clears it. A factory-closure variable is legitimate here (and is
  // not the in-memory state D-H4 forbids) because the tool and the handler run in the
  // *same* extension instance — this hop never crosses the session-replacement boundary.
  // What survives that boundary is the on-disk record (renewal-state.ts), read fresh by
  // the handler; this variable only carries what the tool alone knows (the raw summary
  // and next-steps strings) across the one hop that stays inside one process.
  let pendingRestart: { summary?: string; nextSteps?: string } | null = null;

  // Shared by the tool-side dispatch failure (decision 12's third case: the command could
  // not be resolved, so nothing was even sent) and the handler-side newSession failures
  // (its first two cases). All three land here because "the surviving session" is always
  // the CURRENT one: the tool runs inside it directly, and a failed restart by definition
  // never replaced it. sendPayload(pi, …) is the user-visible channel; ctx.ui.notify(…,
  // "error") is the second, independent one — visible even where the transcript is not.
  const reportRestartFailure = (
    ui: { notify: (message: string, type?: "info" | "warning" | "error") => void },
    reason: string
  ): void => {
    const message = `pi-renew restart FAILED: ${reason}. The session was NOT replaced and your context was NOT reset. Report this rather than continuing.`;
    sendPayload(pi, message);
    ui.notify(message, "error");
  };

  const executeRenewal = async (
    params: RenewSessionParams,
    ctx: {
      mode?: "tui" | "rpc" | "json" | "print";
      compact: (options: {
        onComplete: (result: unknown) => void | Promise<void>;
        onError: (error: Error) => void | Promise<void>;
      }) => void;
      modelRegistry: { getAll: () => Array<Model<any>> };
      // Only reached on the new-session path, when the restart command cannot be
      // resolved (decision 12's third failure case) — the tool itself must report it,
      // since nothing was ever dispatched for a command handler to report it from.
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
      // O25: only the `compact` branch needs these — it claims the restart ordinal and
      // reads the registered renewal context itself now, via claimRestartOrdinal, instead
      // of leaving that entirely to the `/pi-renew` command handler.
      cwd: string;
      sessionManager: { getSessionId: () => string };
    }
  ) => {
    // ctx.compact() is fire-and-forget and does not even start until the agent run has
    // settled; one-shot modes tear the process down at that point, so the compaction never
    // lands and the continuation message is never delivered. Refuse instead of no-op'ing.
    // "rpc" is headless but long-lived and works fine — do not guard on "non-interactive".
    if (ctx.mode === "print" || ctx.mode === "json") {
      throw new Error(
        `renew_session requires a long-lived pi session and cannot run in --mode ${ctx.mode}. ` +
          "Use interactive pi or --mode rpc. Nothing was compacted and no continuation was queued.\n\n" +
          // D-RO4: the fallback for a runner that never fired `tool_call` (so the D-RO3
          // block did not run). Without this the model gets a bare failure and retries;
          // with it, the same directive the reminder gave lands on the tool result too.
          renderReportOnlyDirective()
      );
    }

    // D-H12: a new optional tool parameter, not a config key (F37 — loadConfig() reads the
    // developer's real home config during unit tests) and not a /pi-renew flag (that
    // command has no compaction path of its own). Validated before any side effect below —
    // an unrecognised value must not trigger a partial compact or restart attempt.
    const strategy = params.strategy ?? "compact";
    if (strategy !== "new-session" && strategy !== "compact") {
      throw new Error(
        `renew_session: unrecognised strategy "${strategy}". Valid values are "new-session" and "compact".`
      );
    }

    const resolvedModelId = params.nextModel
      ? resolveModelId(params.nextModel, config)
      : undefined;
    const targetModel = resolvedModelId
      ? ctx.modelRegistry.getAll().find((m) => m.id === resolvedModelId)
      : undefined;

    // Spec "No workflow coupling": collapsed to one branch now that the persona-lookup
    // parameter is gone — the extension never names a prompt file for the next session
    // to load. A caller wanting a persona registers it in the renewal context instead.
    const nextStepsAction = `**Next Steps**: ${params.nextSteps}\n\nContinue with the next steps.`;

    const modelNote = resolvedModelId ? `\n**Model for next session**: ${resolvedModelId}` : "";

    const formattedSummary = `## 🤖 Session Renewal

**Reason**: ${params.reason}
**Timestamp**: ${new Date().toISOString()}${modelNote}

---

### Summary from the previous session

${params.summary}

---

### Instructions for Next Agent

${nextStepsAction}`;

    if (strategy === "new-session") {
      // D-IN6(a): the idempotent stand-down guard, consulted before any dispatch. A repeat
      // `new-session` request while a prior restart is still in flight for this session is a
      // no-op: it returns the stand-down result and never calls sendExtensionCommand. Only
      // the *first* request in a run reaches the dispatch below — this branch is what kills
      // the D1 re-fire loop: an unqualified "restart is pending" with no in-flight state, which
      // the model re-fired until the run aborted.
      //
      // The persisted in-flight store is keyed by the parent session id and lives under
      // `cwd`. Both are present on a live ExtensionContext (the `compact` branch relies on
      // exactly these two); a context lacking either has no persisted record to consult, so
      // the request is trivially not blocked and proceeds exactly as today. Never let this
      // precondition check itself throw out of the tool for a malformed context.
      // F144: call getSessionId() ON ctx.sessionManager. Extracting the method into a
      // local and invoking it bare loses `this`, and the real SessionManager's
      // getSessionId() is `return this.sessionId` — so the bare call threw
      // "Cannot read properties of undefined (reading 'sessionId')" on every LIVE restart.
      // The mocked ctx in the unit tests uses an arrow function, which ignores `this` and
      // therefore cannot see the difference; only a prototype-method mock can.
      const guard =
        typeof ctx.cwd === "string" && typeof ctx.sessionManager?.getSessionId === "function"
          ? checkRestartInFlight(ctx.cwd, ctx.sessionManager.getSessionId())
          : { blocked: false, record: null };
      if (guard.blocked && guard.record !== null) {
        return {
          content: [{ type: "text" as const, text: standDownText(guard.record) }],
          details: resultDetails("stand-down", { restartId: guard.record.restartId }),
        };
      }

      // Nothing is compacted on this path — pendingRenewal must stay untouched, or a
      // later, unrelated /compact the user runs would be hijacked by a summary that was
      // never meant for it (decision 17).
      pendingRestart = {
        summary: params.summary,
        nextSteps: params.nextSteps,
      };

      // D-H11 / F14: resolve the live invocation name through getCommands() rather than
      // hardcoding the literal "/pi-renew" — a colliding extension can rename ours to
      // pi-renew:2, pi-renew:3, …, and the literal string would otherwise reach the
      // model as unexpanded prose. The pre-dispatch check is now a pure function over a
      // DispatchRunner built from the only thing the extension can observe: pi.getCommands().
      const runner: DispatchRunner = {
        listCommands: () => pi.getCommands(),
        getCommand: (n: string) => pi.getCommands().find(c => c.name === n && c.source === "extension"),
      };
      const dispatch = resolveDispatchableRestart(runner);
      if (!dispatch.ok) {
        pendingRestart = null; // nothing will ever consume it now
        reportRestartFailure(ctx.ui, dispatch.reason);
      } else {
        // Immediately before dispatch, per decision 18 — O2 (whether this should persist)
        // stays open and is not this batch's job.
        if (targetModel) {
          await pi.setModel(targetModel);
        }
        sendExtensionCommand(pi, `/${dispatch.name} -- ${params.reason}`);
      }
    } else {
      // O25: claim the ordinal and assemble the payload BEFORE any side effect — before
      // pendingRenewal is set and before ctx.compact() is called below. A throw from
      // claimRestartOrdinal (a corrupt or unknown-version renewal-state record) therefore
      // propagates straight out of executeRenewal as an ordinary tool error: it is the
      // same shape as the mode guard and the strategy guard above (both throw before any
      // side effect). Do NOT catch it and do NOT route it through reportRestartFailure —
      // that sentence ("The session was NOT replaced and your context was NOT reset") is
      // written for a restart that was attempted; here nothing was, since no compaction was
      // requested and no message was queued.
      const { ordinal, record } = claimRestartOrdinal(
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        params.reason
      );

      // Identical inputs to the new-session path's assembleRestartPayload call in the
      // /pi-renew command handler, field for field — `summary` is the RAW params.summary,
      // not formattedSummary. formattedSummary keeps decorating the *compaction entry* below
      // (untouched, still what session_before_compact returns); the payload carries the raw
      // summary exactly as the new-session path does (O25). Accepted, deliberate
      // duplication: on the success path the raw summary reaches the model twice — once
      // inside the compaction entry, once in the payload's "## Summary" section — because
      // the spec's payload requirement is unconditional across strategies and includeSummary
      // must actually govern the payload, not be skipped here because it is "already in the
      // compaction entry" (O25).
      const payload = assembleRestartPayload({
        ordinal,
        timestamp: new Date().toISOString(),
        reason: params.reason,
        summary: params.summary,
        nextSteps: params.nextSteps,
        context: record?.context,
        includeSummary: record?.includeSummary ?? true,
        includeNextSteps: record?.includeNextSteps ?? true,
      });

      pendingRenewal = {
        summary: formattedSummary,
        nextSteps: params.nextSteps,
      };

      // The header states what actually happened to the context — the one thing the payload
      // itself cannot say. Both variants are frozen byte-for-byte: three toContain
      // assertions in test/compaction-handler.test.ts, one per degraded-error variant,
      // match on "WITHOUT a context reset". The degraded path delivers the payload too:
      // nothing was reset, but the renewal context still has to be replayed — that is the
      // whole point of the restart primitive (O25).
      const sendContinuationMessage = async (contextWasReset: boolean, note?: string) => {
        if (targetModel) {
          await pi.setModel(targetModel);
        }
        const header = contextWasReset
          ? "Session renewal completed; context was reset."
          : `Session renewal continued WITHOUT a context reset (${note}). Your previous context is still present — do not assume a clean slate.`;
        // Same send-shape split as the new-session path, and for the same reason (D-H7 /
        // F25): `pi` only expands a slash-command renewal context when it is the *entire*
        // message, so the header+prelude and the context must go out as two separate
        // messages rather than being joined into one string.
        if (payload.context !== null) {
          sendRestartPrelude(pi, `${header}\n\n${payload.prelude}`);
          sendPayload(pi, payload.context);
        } else {
          sendPayload(pi, `${header}\n\n${payload.prelude}`);
        }
      };

      ctx.compact({
        onComplete: async () => {
          await sendContinuationMessage(true);
        },
        onError: async (err) => {
          // pi refuses to compact when findCutPoint leaves nothing before the cut — which
          // happens whenever a session's token mass sits in its oldest entries, not only in
          // small sessions. Continue, but say so rather than implying a reset happened.
          if (
            err.message.includes("Nothing to compact") ||
            err.message.includes("session too small") ||
            err.message.includes("Already compacted")
          ) {
            pendingRenewal = null;
            await sendContinuationMessage(false, err.message);
            return;
          }
          pendingRenewal = null;
          sendPayload(
            pi,
            `Session renewal FAILED: compaction errored (${err.message}). Context was not reset and the next steps were not started. Report this rather than continuing.`
          );
        },
      });
    }

    const modelMsg = targetModel
      ? ` (switching to model: ${resolvedModelId})`
      : params.nextModel
        ? resolvedModelId
          ? ` (model '${resolvedModelId}' not found in Pi registry — keeping current model)`
          : ` (model '${params.nextModel}' not found in ~/.pi/agent/pi-renew.json — keeping current model)`
        : "";

    // Deliberately "requested … pending", never "completed", on BOTH paths: compaction is
    // fire-and-forget and does not run until this agent run settles, and a new-session
    // restart replaces this very tool call's session mid-turn — neither outcome is known
    // yet when this returns (decision 19; spec "Tool result is honest about pendingness").
    return {
      content: [
        {
          type: "text" as const,
          text: `🤖 **Session renewal requested**${modelMsg} — a session restart is pending; the next steps (${params.nextSteps}) start in the replacement session.\n\n${formattedSummary}`,
        },
      ],
      details: resultDetails("pending"),
    };
  };

  // Storage housekeeping only: adopts a predecessor's on-disk renewal-state
  // record (if any) onto this session's id, and reaps stale records. Never
  // sends a message or injects a prompt — a fresh session must start clean.
  // The restart flow (task 3.x) reads the record from disk itself; caching
  // resolveRenewalState's return value here would be exactly the in-memory
  // state this whole design exists to avoid, since a record written after
  // session start would silently lose to a stale cache.
  pi.on(
    "session_start",
    async (
      event,
      ctx: {
        cwd: string;
        sessionManager: { getSessionId: () => string };
        ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
      }
    ) => {
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        resolveRenewalState(ctx.cwd, sessionId, event.previousSessionFile);
        reapRenewalStates(ctx.cwd, sessionId);
        // D-IN8: the delivered handshake. The replacement session only began processing
        // because its predecessor's restart continuation landed, so the replacement
        // beginning to process IS the arrival proof (D3): adopt the predecessor's in-flight
        // record onto this session's key, then mark it delivered to lift the block so a
        // later, distinct restart in this session is not held by a stale flag. A missing
        // predecessor file is a no-op (adoptRestartInflight returns false and nothing is
        // marked delivered).
        if (event.previousSessionFile !== undefined) {
          const predecessorId = sessionIdFromSessionFile(event.previousSessionFile);
          if (predecessorId !== sessionId) {
            if (adoptRestartInflight(ctx.cwd, predecessorId, sessionId)) {
              markRestartInflightDelivered(ctx.cwd, sessionId);
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-renew: could not restore the renewal context — ${message}`, "warning");
      }
    }
  );

  pi.on("context", async (event, ctx) => {
    if (!highContextReminder.enabled) return;

    const contextUsage = ctx.getContextUsage();
    // Absent usage, or a non-positive window, cannot yield a meaningful threshold —
    // a zero/negative window would make Math.round(fraction * window) <= 0, which
    // would fire on every turn. Treat both the same as "no data": reset and bail.
    if (!contextUsage || contextUsage.contextWindow <= 0) {
      lastReminderMilestone = null;
      return;
    }

    // Recomputed from the live window on every evaluation, never cached — this is
    // what makes the threshold follow a model change with no config edit. Math.round,
    // NOT Math.floor: e.g. 0.575 * 200000 is 114999.99999999999 in IEEE-754, and
    // Math.floor would move the firing point one token below the intended threshold.
    const thresholdTokens = Math.round(
      highContextReminder.thresholdFraction * contextUsage.contextWindow
    );
    const reminderMilestone = getReminderMilestone(
      contextUsage.tokens,
      thresholdTokens,
      highContextReminder.repeatEveryTokens
    );

    if (reminderMilestone === null) {
      lastReminderMilestone = null;
      return;
    }

    if (lastReminderMilestone !== null && reminderMilestone <= lastReminderMilestone) {
      return;
    }

    lastReminderMilestone = reminderMilestone;

    // D-RO2: the report-only check comes before the in-flight read, and short-circuits
    // it. checkRestartInFlight touches the disk; in a session that cannot restart at all
    // the answer could not change the variant (report-only outranks stand-down, see
    // D-RO1), so the read is pure cost.
    let variant: ReminderVariant;
    if (isReportOnlySession(ctx.mode, process.env)) {
      variant = "report-only";
    } else {
      // F144: bound call — an unbound getSessionId() threw here and the throw was swallowed
      // by the runner's handler catch, so the high-context reminder was silently never
      // delivered on a live session.
      const inFlight =
        typeof ctx.cwd === "string" && typeof ctx.sessionManager?.getSessionId === "function"
          ? checkRestartInFlight(ctx.cwd, ctx.sessionManager.getSessionId()).blocked
          : false;
      variant = inFlight ? "stand-down" : "restart";
    }

    return {
      messages: [
        ...event.messages,
        createHighContextReminder(
          contextUsage.tokens ?? reminderMilestone,
          thresholdTokens,
          contextUsage.contextWindow,
          variant
        ),
      ],
    };
  });

  // D-RO3: the "don't give the tool" half of the report-only design. The extension
  // CANNOT withhold a tool from the model's surface: `registerTool` runs in the
  // activation function, which receives only `pi` (ExtensionAPI has no `mode`), and
  // there is no unregister and no per-call enable predicate on ToolDefinition. Blocking
  // the call is the closest reachable equivalent — and it is a better one than the
  // `executeRenewal` mode guard it sits in front of, because a `reason` STEERS the model
  // (stop, write the report) where a thrown tool error only tells it that something
  // failed, which invites a retry. The guard stays as the last line of defence for a
  // runner that does not fire `tool_call`.
  //
  // Deliberately NOT `terminate: true`: the model still has to emit the report, and
  // terminating the batch would end the run on whatever text preceded the blocked call —
  // which is exactly the empty-handed result this whole path exists to prevent.
  const RENEWAL_TOOL_NAMES = new Set(["renew_session", "renew_from_handover"]);
  pi.on("tool_call", async (event, ctx) => {
    if (!RENEWAL_TOOL_NAMES.has(event.toolName)) return;
    if (!isReportOnlySession(ctx.mode, process.env)) return;
    return {
      block: true,
      reason: `${event.toolName} is not available in this session. ${renderReportOnlyDirective()}`,
    };
  });

  pi.on("session_compact", async () => {
    lastReminderMilestone = null;
  });

  // Only intercept compaction when our tool triggered it
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!pendingRenewal) return; // normal /compact → let Pi handle it

    const renewal = pendingRenewal;
    pendingRenewal = null; // consume before returning

    // Use the last entry as cut point — drop everything except it.
    // preparation.firstKeptEntryId keeps ~20k tokens (too much for a clean reset).
    const lastEntry = event.branchEntries[event.branchEntries.length - 1];

    return {
      compaction: {
        summary: renewal.summary,
        firstKeptEntryId: lastEntry.id,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  const promptGuidelines = [
    'ALWAYS call renew_session when the user asks to "renew the session", "start fresh", "hand off to a fresh session", "clean context", or "delegate to another agent" (the older wording), unless the extension injected a high-context reminder — then use renew_from_handover instead.',
    'Proactively call renew_session to renew the session ONLY when running in AUTO mode and the current phase is fully complete.',
    "Your summary replaces all old context. Be thorough — this is the ONLY context the renewed session will have, and include the task, plan, or report file it should open first when one exists.",
    "To make the next session adopt a specific persona or workflow, register it with set_renewal_context (prose, '/skill:<name> <args>' or '/<template> <args>') — renew_session has no persona parameter of its own.",
    "Normal /compact is NOT affected by renew_session.",
  ];

  // F49: the runtime DOES validate tool arguments (agent-loop.js calls
  // validateToolArguments, which throws on a failed check), but TypeBox's Type.Object
  // permits unknown keys by default — {additionalProperties:false} is what makes a
  // removed, caller-workflow-named parameter get rejected rather than silently ignored,
  // per the spec's "No phase vocabulary on the surface" scenario. Scoped to this tool
  // only — renew_from_handover and set_renewal_context were not audited.
  const parameters = Type.Object({
    reason: Type.String({
      description: "Brief explanation of why the session is being renewed (e.g., 'completed analysis phase', 'context is full')",
    }),
    nextSteps: Type.String({
      description: "What the next session should do next (e.g. 'implement user authentication', 'create comprehensive test suite'). Free text — the extension never parses it.",
    }),
    summary: Type.String({
      description: `Structured handover summary for the renewed session. Use this exact format:

## Goal
[What is the user trying to accomplish — the overarching objective, not just this phase]

## Constraints & Preferences
- [Requirements, tech choices, or preferences the user stated]
- [Style, architecture, or workflow constraints]

## Progress
### Done
- [x] [Completed task with specific details]
- [x] [Files created/modified and what changed]

### In Progress
- [ ] [Partially completed work — describe current state]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Most important next task]
2. [Subsequent tasks in priority order]
3. [Acceptance criteria if applicable]

## Critical Context
- [Data, examples, code snippets, references needed to continue]
- [Environment setup, dependencies, API keys, or config details]
- [Edge cases discovered, error patterns observed]
- [Task file, plan file, or temp report path the renewed session should open first]

If a task file or plan file exists, update it before handing off and name it in the summary. If neither exists, create a temp \`.md\` report + plan, save it, and include that path in the summary.`,
    }),
    nextModel: Type.Optional(Type.String({
      description: "Model to switch to for the renewed session. Specify a model ID (e.g. 'Q3.5-27B') or a named alias (e.g. 'coding', 'reviewer') defined in ~/.pi/agent/pi-renew.json. Requires the config file to have models defined — see the pi-renew README for setup. If omitted, the current model is kept.",
    })),
    // D-H12 (O9): the restart-strategy selector, and it lives here rather than in config
    // (F37 — loadConfig() reads the developer's real ~/.pi/agent/pi-renew.json during
    // unit tests) or as a /pi-renew flag (that command has no compaction path of its
    // own to select between). Default is "compact", deliberately NOT yet the spec's
    // "new-session" default: design.md's migration plan keeps compact until batch 3C's
    // first green live newSession run. O15 tracks the flip — do not "fix" this default.
    strategy: Type.Optional(Type.String({
      description: "Restart strategy: 'new-session' replaces the session via ctx.newSession() (the spec's eventual default); 'compact' compacts the current session in place. Currently defaults to 'compact' until the new-session path has a proven live run (see O15 in the implementation handover).",
    })),
  }, { additionalProperties: false });

  type RenewSessionParams = Static<typeof parameters>;

  pi.registerTool({
    name: "renew_session",
    label: "Renew Session",
    description:
      "Renew this session — replace its accumulated context with your own handover summary and continue. " +
      "No LLM review, no compaction delay. Normal /compact is unaffected.",
    promptSnippet:
      'When the user says "renew the session", "start a fresh session", "hand off to a fresh session", "clean context", or "reset context", call renew_session. ' +
      "This is the ONLY tool for renewing a session and cleaning context — do not use any other tool or MCP for this.",
    promptGuidelines,
    parameters,
    async execute(_toolCallId, params: RenewSessionParams, _signal, _onUpdate, ctx) {
      return executeRenewal(params, ctx);
    },
  });

  // D-H24: no handoverPath default and no per-call minting — the caller writes the
  // report wherever it chooses and supplies that path back. Required (not
  // Type.Optional), so the runtime validator rejects an omitted one on its own; execute
  // additionally rejects an empty/whitespace-only value with its own message, since a
  // unit test calling execute() directly bypasses the runtime validator entirely (F49).
  const renewFromHandoverParameters = Type.Object({
    handoverPath: Type.String({
      description: "Path to the markdown handover report you just wrote. The extension never generates or defaults a handover location — supply the one you used.",
    }),
  });

  type RenewFromHandoverParams = Static<typeof renewFromHandoverParameters>;

  pi.registerTool({
    name: "renew_from_handover",
    label: "Renew From Handover",
    description:
      "Complete the reminder-driven high-context handoff. " +
      "Requires the path to the markdown handover report you wrote — the extension does not generate or default one. " +
      "Fails if that file is missing or empty.",
    promptSnippet:
      "When the extension injects a high-context reminder, write the handover report to a markdown file of your choosing, then call renew_from_handover with handoverPath set to that file's path.",
    promptGuidelines: [
      "Use renew_from_handover ONLY for the reminder-driven high-context handoff flow.",
      "Before calling it, write the handover report to a markdown file whose location you choose, then pass that path as handoverPath.",
      "Do not edit task files, plan files, or any project files before calling renew_from_handover.",
      "Do not call renew_session directly after a high-context reminder; renew_from_handover will do that internally.",
    ],
    parameters: renewFromHandoverParameters,
    async execute(_toolCallId, params: RenewFromHandoverParams, _signal, _onUpdate, ctx) {
      const handoverPath = params.handoverPath;
      if (!handoverPath || handoverPath.trim() === "") {
        throw new Error(
          "renew_from_handover requires handoverPath: the path to the markdown handover report you wrote. The extension does not generate or default a handover location — supply the one you used."
        );
      }

      if (!existsSync(handoverPath)) {
        throw new Error(
          `Write the handover report first, then call renew_from_handover again. No file exists at: ${handoverPath}`
        );
      }

      const handoverReport = readFileSync(handoverPath, "utf-8").trim();
      if (!handoverReport) {
        throw new Error(
          `The handover report file is empty. Write the handover report first, then call renew_from_handover again. Use this exact path: ${handoverPath}`
        );
      }

      const sessionEntries = await getSessionEntries(ctx);
      const summary = appendLastTasksRead(
        handoverReport,
        getPlanningTaskFiles(sessionEntries)
      );

      return executeRenewal(
        {
          reason: "context usage too high",
          nextSteps: `Continue from the handover report at ${handoverPath}`,
          summary,
          // O26: explicit, not the shipped "compact" default. Once O25 makes `compact`
          // deliver the payload too, both strategies replay the renewal context — so this
          // is a genuine strategy choice, not a repair. `new-session` additionally records
          // lineage via `parentSession` and produces a clean session file, which is the more
          // useful post-mortem artifact for the failure this path exists to handle: a
          // session that ran out of context window.
          strategy: "new-session",
        },
        ctx
      );
    },
  });

  const setRenewalContextParameters = Type.Object({
    context: Type.String({
      description:
        "The text replayed into each restarted session, stored verbatim. May be prose, a '/skill:<name> <args>' command, or a '/<template> <args>' command.",
    }),
    includeSummary: Type.Optional(
      Type.Boolean({
        description: "Whether the restart payload includes the agent-supplied summary. Defaults to true.",
      })
    ),
    includeNextSteps: Type.Optional(
      Type.Boolean({
        description: "Whether the restart payload includes the agent-supplied next steps. Defaults to true.",
      })
    ),
  });

  type SetRenewalContextParams = Static<typeof setRenewalContextParameters>;

  // Registered third, after both renew_session and renew_from_handover: several
  // existing tests reach the tool under test by registerTool.mock.calls index, not by
  // name, so registering this tool any earlier would silently break those assertions.
  pi.registerTool({
    name: "set_renewal_context",
    label: "Set Renewal Context",
    description:
      "Register the renewal context that is replayed into every session this one restarts into. " +
      "The context is stored verbatim and never parsed: it can be prose, a '/skill:<name> <args>' command, " +
      "or a '/<template> <args>' command, which the runtime expands when the payload is delivered. " +
      "Registering resets the restart counter to 0.",
    promptSnippet:
      "When the user asks to set, register or change the context that should be replayed after each restart, call set_renewal_context.",
    promptGuidelines: [
      "Register the renewal context before starting work, so the first restart is already covered.",
      "Pass the context exactly as the user gave it — do not summarise, reword or reformat it.",
      "Use includeSummary and includeNextSteps to control the restart payload; never encode that intent as words inside the context.",
    ],
    parameters: setRenewalContextParameters,
    async execute(
      _toolCallId,
      params: SetRenewalContextParams,
      _signal,
      _onUpdate,
      ctx: { cwd: string; sessionManager: { getSessionId: () => string } }
    ) {
      // getCommands() is read here, not at factory time: at factory time it would
      // snapshot the command list before skills and prompts finish loading.
      validateRenewalContext(params.context, pi.getCommands());

      const includeSummary = params.includeSummary ?? true;
      const includeNextSteps = params.includeNextSteps ?? true;

      // Verbatim: the context is never trimmed, normalised or inspected. Re-registering
      // overwrites the whole record, which is what resets restartCount to 0.
      writeRenewalState(ctx.cwd, ctx.sessionManager.getSessionId(), {
        version: RENEWAL_STATE_VERSION,
        context: params.context,
        includeSummary,
        includeNextSteps,
        restartCount: 0,
        registeredAt: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `🤖 **Renewal context registered** — ${params.context.length} characters, includeSummary=${includeSummary}, includeNextSteps=${includeNextSteps}, restart counter reset to 0.`,
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerCommand("pi-renew", {
    description: "Restart this session, replaying the registered renewal context.",
    // try/catch is not optional: AgentSession._tryExecuteExtensionCommand catches handler
    // throws into emitError and reports the command as "handled", so an uncaught error here
    // would be invisible to both the user and the model.
    handler: async (
      args,
      ctx: {
        cwd: string;
        ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
        sessionManager: { getSessionId: () => string; getSessionFile: () => string | undefined };
        waitForIdle: () => Promise<void>;
        newSession: (options?: {
          parentSession?: string;
          withSession?: (c2: CustomMessageSender & UserMessageSender) => Promise<void>;
        }) => Promise<{ cancelled: boolean }>;
      }
    ) => {
      // Consumed and cleared FIRST, before anything that can throw or await: a human
      // typing /pi-renew directly has no pending summary (restart is provenance +
      // context only, D-H9), and clearing up front means no failure path in this
      // invocation — a bad flag, a rejected waitForIdle, a corrupt record — can leave a
      // stale summary attached to the *next* restart attempt.
      const restart = pendingRestart;
      pendingRestart = null;

      try {
        const { afterTurn, rest: reason } = parseRenewCommandArgs(args);

        // Deferring lets the model's own post-tool turn complete (billed normally) instead
        // of being aborted by the replacement; default is NOT deferred, because that extra
        // turn would write into a context about to be discarded (task 3.5).
        //
        // Its own try/catch, not the outer one: a rejected waitForIdle means the restart
        // did not happen, and the outer catch reports only through ctx.ui.notify — which
        // the MODEL never sees (in rpc/headless there is no UI at all). The spec's
        // "Restart failures are reported" requirement forbids continuing silently when the
        // requested reset did not happen, so this has to reach the transcript too.
        if (afterTurn) {
          try {
            await ctx.waitForIdle();
          } catch (err) {
            reportRestartFailure(
              ctx.ui,
              `waitForIdle() threw while deferring the restart: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
          }
        }

        // D-IN6(b): the idempotent stand-down guard, consulted before the ordinal is
        // claimed and before newSession(). A repeat /pi-renew while a prior restart is
        // still in flight for this session is a no-op: a stand-down notify (NOT
        // reportRestartFailure — that string wrongly says "NOT replaced / do not
        // continue" for a restart that in fact *is* proceeding on its own) and no
        // newSession(). Only the first request in a run claims the ordinal and dispatches.
        // F144: bound call — see the note at the tool-path guard above.
        const guard =
          typeof ctx.cwd === "string" && typeof ctx.sessionManager?.getSessionId === "function"
            ? checkRestartInFlight(ctx.cwd, ctx.sessionManager.getSessionId())
            : { blocked: false, record: null };
        if (guard.blocked) {
          const rec = guard.record;
          if (rec !== null) {
            ctx.ui.notify(
              `pi-renew: a restart is already in progress (restartId ${rec.restartId}); standing down — not re-dispatching the restart for this run.`,
              "warning"
            );
          }
          return;
        }

        // D-H4: adoption already happened in the session_start handler that fired when
        // THIS session started — claimRestartOrdinal reads via readRenewalState, not
        // resolveRenewalState, because this handler only ever needs its own session's
        // already-adopted record. O25: the read-increment-persist sequence that used to
        // live inline here (readRenewalState, compute `ordinal`, writeRenewalState) is now
        // claimRestartOrdinal in renewal-state.ts, shared with the `compact` restart path
        // so both strategies claim the same counter — see that function's doc comment for
        // the D-H9/D-H15 rationale (never rolled back on a failed restart) it used to carry
        // here. This refactor is behaviour-preserving: same read, same write, same ordinal.
        let ordinal: number;
        let record: RenewalState | null;
        try {
          ({ ordinal, record } = claimRestartOrdinal(
            ctx.cwd,
            ctx.sessionManager.getSessionId(),
            reason
          ));
        } catch (err) {
          // D-H20: a corrupt or unknown-version record throws by design; report it through
          // the same failure channel as a failed newSession rather than letting it escape.
          reportRestartFailure(ctx.ui, err instanceof Error ? err.message : String(err));
          return;
        }

        // D-IN7: persist the in-flight flag now — after the ordinal is claimed, before the
        // (possibly aborting) newSession() — so a mid-write crash never leaves the ordinal
        // claimed but the flag absent, and the replacement's session_start can find it.
        beginRestart(ctx.cwd, ctx.sessionManager.getSessionId(), reason, ordinal);

        const payload = assembleRestartPayload({
          ordinal,
          timestamp: new Date().toISOString(),
          reason,
          summary: restart?.summary,
          nextSteps: restart?.nextSteps,
          context: record?.context,
          includeSummary: record?.includeSummary ?? true,
          includeNextSteps: record?.includeNextSteps ?? true,
        });

        // Without this, the replacement session's header records no link to its
        // predecessor (F34 / spec "Restart strategies").
        const parentSession = ctx.sessionManager.getSessionFile();

        let result: { cancelled: boolean };
        try {
          result = await ctx.newSession({
            parentSession,
            // D-H10: with a registered context, the prelude is a custom, triggerTurn:false
            // message and the context (delivered via sendPayload) is what starts the one
            // turn. With none, the prelude alone IS the payload — sent as an ordinary user
            // message so a turn still starts (D-H14 / F39: a triggerTurn:false message on
            // an idle fresh session would otherwise sit unread). Not awaited (decision 11 /
            // F34): the runtime awaits this whole callback before newSession resolves, and
            // on a ReplacedSessionContext the send promises settle only once the fresh
            // turn has fully settled.
            withSession: async (c2) => {
              if (payload.context !== null) {
                sendRestartPrelude(c2, payload.prelude);
                sendPayload(c2, payload.context);
              } else {
                sendPayload(c2, payload.prelude);
              }
            },
          });
        } catch (err) {
          reportRestartFailure(
            ctx.ui,
            `newSession() threw: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        if (result.cancelled) {
          // D-H16: newSession() opens with emitBeforeSwitch("new") and returns
          // {cancelled:true} WITHOUT throwing when a session_before_switch handler
          // declines it. A catch block alone misses this — nothing was thrown, but nothing
          // was replaced either.
          reportRestartFailure(
            ctx.ui,
            "the session replacement was cancelled by a session_before_switch handler"
          );
        }
      } catch (err) {
        ctx.ui.notify(`pi-renew: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
