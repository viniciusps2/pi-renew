/**
 * The two send shapes task 3.7 exists to enforce, and the helpers every
 * outbound message must funnel through instead of calling
 * `sendUserMessage` / `sendMessage` directly, so the rule cannot be gotten
 * wrong per call site:
 *
 *   - command mode (`sendExtensionCommand`) — `{ expandPromptTemplates: true }`,
 *     never `deliverAs`. Extension commands are dispatched before
 *     `prompt()` reaches its streaming branch.
 *   - payload mode (`sendPayload`) — `{ expandPromptTemplates: true, deliverAs: "followUp" }`,
 *     unconditionally, on every string, command-shaped or not.
 *
 * Measured consequences of swapping or dropping either option:
 *   - omitting `expandPromptTemplates` delivers the raw `/command` string
 *     to the model as literal user text — never dispatched, never expanded.
 *   - omitting `deliverAs` on a non-command payload sent while the agent is
 *     streaming delivers the message nowhere at all, while the caller still
 *     observes success; the only trace is an `extension_error` event.
 *
 * `sendRestartPrelude` is not one of the spec's two send shapes above — it
 * delivers the D-H7 prelude (provenance + summary + next steps) as a custom
 * message with `triggerTurn: false`, so it lands in the transcript and the
 * session file without starting its own turn. The turn is the one
 * `sendPayload` triggers for the delegate context delivered right after it.
 */

export const RESTART_PRELUDE_CUSTOM_TYPE = "pi-renew-restart";

export interface UserMessageSender {
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): unknown;
}

export interface CustomMessageSender {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): unknown;
}

/**
 * Dispatches `command` as an extension command: `{ expandPromptTemplates: true }`,
 * no `deliverAs`. Throws if `command` does not start with `/` — a loud
 * failure at the one call site that would otherwise silently drop a
 * non-command message sent without `deliverAs` while the agent is
 * streaming (see file header).
 */
export function sendExtensionCommand(
  sender: UserMessageSender,
  command: string,
  onError?: (error: unknown) => void,
): void {
  if (!command.startsWith("/")) {
    throw new Error(
      "sendExtensionCommand requires a leading slash: an extension command must start with '/'.",
    );
  }
  settle(sender.sendUserMessage(command, { expandPromptTemplates: true }), onError);
}

/**
 * Sends `payload` as ordinary content: `{ expandPromptTemplates: true,
 * deliverAs: "followUp" }`, always, with no inspection of the string.
 *
 * Deliberately not guarded: a payload that happens to start with `/skill:`
 * or `/` is still content, not a command, and is dispatched exactly the
 * same way (`tasks.md` 3.7 names this case explicitly). Unguarded hazard,
 * out of this batch's scope: a payload that happens to also be a
 * registered extension command *will* be dispatched by `prompt()` before
 * expansion — reported here, not defended against.
 */
export function sendPayload(
  sender: UserMessageSender,
  payload: string,
  onError?: (error: unknown) => void,
): void {
  settle(
    sender.sendUserMessage(payload, { expandPromptTemplates: true, deliverAs: "followUp" }),
    onError,
  );
}

/**
 * Sends `prelude` as the D-H7 custom message: `customType:
 * "pi-renew-restart"`, `display: true`, `triggerTurn: false`. Does not
 * start a turn — the delegate context sent right after it (via
 * `sendPayload`) is what triggers the fresh session's one turn.
 */
export function sendRestartPrelude(
  sender: CustomMessageSender,
  prelude: string,
  onError?: (error: unknown) => void,
): void {
  settle(
    sender.sendMessage(
      { customType: RESTART_PRELUDE_CUSTOM_TYPE, content: prelude, display: true },
      { triggerTurn: false },
    ),
    onError,
  );
}

/**
 * Shared thenable handling for all three helpers above. `ExtensionAPI`'s
 * send methods return `undefined`; `ReplacedSessionContext`'s return a
 * `Promise` that settles only when the new turn has fully settled (§F29).
 * Never `await` here — capture the return value, and if it is a thenable,
 * attach a `.catch` without returning it, so the helper's own return type
 * stays `void` in both cases.
 *
 * Defaulting `onError` to a no-op rather than rethrowing is deliberate: an
 * unhandled rejection here would take the whole `pi` process down, and
 * `pi`'s own binding already reports send failures as an `extension_error`
 * event (`agent-session.js:1855-1859`). Turning a restart failure into a
 * user-visible message is task 3.6's job; `onError` is the seam it uses.
 */
function settle(result: unknown, onError?: (error: unknown) => void): void {
  const thenable = result as { then?: unknown } | null | undefined;
  if (typeof thenable?.then === "function") {
    (result as Promise<unknown>).catch(onError ?? (() => {}));
  }
}
