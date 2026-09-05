# Pi Delegate Extension

## What this is

`pi-renew` is a restart primitive for `pi` (`@earendil-works/pi-coding-agent`): a caller registers
an opaque payload once, and the extension replays it, verbatim, into every session it restarts into.
It has no opinion about what that payload means — no persona resolution, no artifact paths of its own,
and no parameter named after a caller's workflow phase. Everything about *what work happens* belongs to
the caller; the extension only carries it across the restart boundary.

Four terms recur throughout this document:

- **Delegate context** — the caller-registered text replayed into every restarted session. Stored
  verbatim; never parsed for directives, paths or phases.
- **Restart payload** — what the fresh session receives: a **prelude** (provenance, plus the summary
  and next steps when their toggles allow) and the **context**, delivered as two separate messages.
- **Provenance** — the one unconditional line every restart opens with, carrying the restart ordinal, a
  timestamp, and the caller's opaque reason.
- **Restart strategy** — `new-session` (replace the session via `ctx.newSession()`) or `compact`
  (compact the current session in place).

## Installation

`pi-renew` is installed as a `pi` **package**, not by copying a file. The extension is six modules
(`pi-renew.ts` plus `config.ts`, `delegate-state.ts`, `delegate-context.ts`, `restart-payload.ts` and
`send-shapes.ts`); copying `pi-renew.ts` alone no longer works, because it would leave behind the
five relative imports it needs.

### Normally: install the repository

Install the **repository root**, which carries the `pi` manifest and registers this extension
alongside the `/loop` prompt and the skills it drives:

```bash
pi install git:github.com/viniciusps2/pi-renew
```

See the [repo README](../../README.md#install) for the checkout, project-local and `install.mjs`
variants. There is no git URL for this subdirectory on its own — `pi` reads
`git:github.com/<user>/<repo>` and treats anything after the repo name as part of the repository
path, so a subdirectory URL fails the clone.

### Extension only, from a checkout

Take this path when you want the restart primitive **without** `/loop` and the skills. The paths are
written relative to the repository root; run them from there, or substitute the path to this
directory.

```bash
pi install ./pi-extensions/pi-renew        # all projects (~/.pi/agent/settings.json)
pi install ./pi-extensions/pi-renew -l     # project-local (.pi/settings.json)
```

This directory has its own `pi` manifest listing only `extensions`, so nothing else is registered.
Do not combine it with a root install — the extension would load twice.

### Without installing

```bash
pi -e ./pi-renew.ts -ne
```

Run this from inside the package directory (`pi-extensions/pi-renew`). `-ne` disables extension
discovery — `pi --help` documents it as "Disable extension discovery (explicit -e paths still work)" —
so only this explicit `-e` path loads, nothing else configured on the machine.

## The three tools

### `set_delegate_context`

| Parameter | Type | Description |
|---|---|---|
| `context` | string, required | The text replayed into each restarted session, stored verbatim. May be prose, a `/skill:<name> <args>` command, or a `/<template> <args>` command. |
| `includeSummary` | boolean, optional | Whether the restart payload includes the agent-supplied summary. Defaults to `true`. |
| `includeNextSteps` | boolean, optional | Whether the restart payload includes the agent-supplied next steps. Defaults to `true`. |

Registering resets the restart counter to `0`. When `context` opens with a slash command, the extension
resolves it against the runtime's known commands **at registration time**, not at delivery time, and
rejects the registration if it does not resolve — so a delegate context that could never expand is
caught immediately, instead of being replayed as literal prose on every future restart.

A context that resolves to `pi-renew`'s own restart command is rejected outright, since replaying it
would restart forever:

> Delegate context not registered: /pi-renew is this extension's own restart command, so replaying
> it would restart forever. Register the work you want replayed, not the restart itself.

```json
{
  "name": "set_delegate_context",
  "arguments": {
    "context": "/loop implement tasks.md",
    "includeSummary": true,
    "includeNextSteps": true
  }
}
```

### `delegate_to_agent`

The delegation tool. Restarts the session — via whichever `strategy` is selected — carrying a summary
and next steps to the replacement.

| Parameter | Type | Description |
|---|---|---|
| `reason` | string, required | Why delegating (e.g. "completed analysis phase"). Becomes part of provenance. |
| `nextSteps` | string, required | What the next session should do. Free text; never parsed. |
| `summary` | string, required | Structured delegation summary — see below. |
| `nextModel` | string, optional | Model ID or alias to switch to before the next session starts. See [Model switching](#model-switching). |
| `strategy` | string, optional | `"new-session"` or `"compact"`. See [Restart strategies](#restart-strategies). |

`delegate_to_agent`'s parameter schema sets `additionalProperties: false`, so it rejects unknown
parameters — a caller (or a stale prompt) passing a removed parameter fails loudly instead of being
silently ignored. The other two tools do not set this.

The `summary` parameter asks for six top-level sections: Goal, Constraints & Preferences, Progress, Key
Decisions, Next Steps, and Critical Context.

**Mode guard.** `delegate_to_agent` throws in `--mode print` and `--mode json`:

> delegate_to_agent requires a long-lived pi session and cannot run in --mode json. Use interactive pi
> or --mode rpc. Nothing was compacted and no continuation was queued.

The reason is timing, not a blanket restriction on non-interactive use: `ctx.compact()` is
fire-and-forget and does not even begin until the current agent run settles, and a `new-session` restart
replaces the session mid-turn — a one-shot process tears down at exactly that point, so the continuation
would never be delivered. Interactive `pi` and `--mode rpc` both stay long-lived after the tool returns,
so both work fine — `rpc` is headless, but it is not one-shot.

**The tool result is deliberately "pending", never "completed".** Neither restart strategy's outcome is
known when the tool returns: `compact` has not started yet (it is fire-and-forget), and `new-session`
replaces the very session this tool call is running in, mid-turn. The result text says a restart was
**requested** and is **pending**, and that the next steps start in the replacement session — never that
anything has completed. This is intentional, not a bug: no code path can know the outcome any earlier.

```json
{
  "name": "delegate_to_agent",
  "arguments": {
    "reason": "completed authentication analysis",
    "nextSteps": "implement unit tests for the auth module",
    "summary": "## Goal\n...\n\n## Next Steps\n...",
    "nextModel": "reviewer",
    "strategy": "new-session"
  }
}
```

### `delegate_context_high`

Completes the reminder-driven high-context handoff (see [High-context reminders](#high-context-reminders)).

| Parameter | Type | Description |
|---|---|---|
| `handoverPath` | string, required | Path to the markdown handover report you just wrote. The extension never generates or defaults this location — you supply the one you used. |

It fails if no file exists at `handoverPath`:

> Write the handover report first, then call delegate_context_high again. No file exists at: \<path\>

or if the file is empty after trimming:

> The handover report file is empty. Write the handover report first, then call delegate_context_high
> again. Use this exact path: \<path\>

On success it reads the file as the delegation summary, scans the session transcript for any
previously-mentioned `*/planning/**/*task*.md` paths, and appends them to the summary inside a
`<last_tasks_read>` tag. It then calls `delegate_to_agent` internally, with `reason` set to `"context
usage too high"`, `nextSteps` pointing back at the handover path, and the **`new-session`** strategy —
explicitly, regardless of `delegate_to_agent`'s own default — because the lineage `new-session` records
via `parentSession`, and the clean session file it produces, are the more useful post-mortem artifact for
a handoff caused by running out of context window. See
[What a restarted session receives](#what-a-restarted-session-receives) for what the fresh session gets.

```json
{
  "name": "delegate_context_high",
  "arguments": {
    "handoverPath": ".pi/loop/handover-2026-08-24.md"
  }
}
```

## The `/pi-renew` command

The restart entry point. A human, or the extension itself (via `delegate_to_agent`'s `new-session`
strategy), invokes it to replace the current session with a fresh one that receives the assembled
restart payload.

```text
/pi-renew [--after-turn] [--] <reason>
```

- `--after-turn` — defer the restart until the current agent run is idle, so the model's own in-progress
  turn completes (and is billed normally) before the session is replaced, rather than being cut off.
  Repeating the flag is harmless.
- `--` — end-of-flags marker. Everything after it becomes the reason, verbatim, even if it starts with
  `--`. The extension always emits this marker itself when dispatching a restart (`/pi-renew --
  <reason>`, or `/pi-renew --after-turn -- <reason>`); a human typing the command directly may omit
  it.
- Any other `--`-prefixed leading token is rejected:

> /pi-renew: unknown flag --bogus. The only supported flag is --after-turn.

If another loaded extension also registers a command named `pi-renew`, `pi` suffixes **every**
colliding copy rather than just the newcomer: they become `pi-renew:1`, `pi-renew:2`, and so on in
registration order, and no copy keeps the bare name. The extension resolves its own live invocation name
at dispatch time, so `new-session` restarts keep working through a rename; a human typing `/pi-renew`
after such a collision gets nothing and has to use the suffixed name.

## Restart strategies

`delegate_to_agent`'s optional `strategy` parameter selects how the restart happens.

### `new-session`

Replaces the session via `ctx.newSession()`, passing the outgoing session as `parentSession` so the
replacement records its lineage. The extension dispatches `/pi-renew` internally (see above) to carry
out the restart, after switching the model first when `nextModel` resolved.

### `compact`

Compacts the current session in place via `ctx.compact()`, supplying the caller's own `summary` as the
compaction entry — unlike a plain `/compact`, which always runs `pi`'s own LLM summarizer, this skips
that call entirely.

The continuation is the same assembled payload the `new-session` strategy delivers (see
[What a restarted session receives](#what-a-restarted-session-receives) below): provenance, then the
summary and next steps under their toggles, then the registered delegate context as its own message. On
success, a header sentence stating that the context was reset is **prepended to the prelude** — it is
not sent on its own — so the one message that opens the fresh turn says both what happened to the
context and what to do next. When `pi` reports there was nothing to compact, the continuation proceeds
**without** a reset and says so explicitly, naming the reported reason — this is not a failure, just an
honest continuation — and the degraded path delivers the payload too: nothing was reset, but the
registered delegate context still has to be replayed, which is the whole point of the restart primitive.
Note that this is not only a small-session case: `pi` refuses to compact whenever it can find no cut
point with anything before it, which happens for any session whose token mass sits in its oldest
entries, however large it is. Any other compaction error is a genuine failure and is reported on the
transcript.

**Current default.** `delegate_to_agent`'s `strategy` parameter currently defaults to `"compact"`. The
intended eventual default is `"new-session"` — the flip is deliberately held back until the
`new-session` path has had a verified live run, and is tracked as an open item in
[`../../docs/STATUS.md`](../../docs/STATUS.md). Do not assume `new-session` is the default; pass
`strategy: "new-session"` explicitly until it becomes one.

## What a restarted session receives

The restart payload is assembled, in order, from: provenance (always), the agent-supplied summary (when
`includeSummary`), the agent-supplied next steps (when `includeNextSteps`), and the registered delegate
context (when one is registered). When no context is registered, both toggles are forced to `true` — the
summary and next steps are then the only thing the fresh session gets.

Provenance is the one unconditional line: the restart ordinal, an ISO timestamp, and the reason string
given to `/pi-renew`, carried through verbatim and uninterpreted.

**Two messages, not one.** `pi` only expands a slash command when it is the *entire* message it
receives. A single string that puts provenance before a delegate context beginning with `/skill:` or
`/<template>` could never expand — the runtime would see one long message, not a leading slash command,
and deliver it as literal prose. So the payload is delivered as two separate messages: a **prelude**
(provenance, plus summary and next steps) sent first without starting a turn, and the **context** sent
second, which is what triggers the fresh session's one turn. When no context is registered, the prelude
alone is sent as an ordinary message, and that starts the turn instead.

**The two send shapes.** Dispatching the `/pi-renew` restart command uses `{ expandPromptTemplates:
true }`, with no `deliverAs` — extension commands are dispatched before the runtime reaches its
streaming logic. Ordinary content — the context, the continuation messages, and restart-failure
reports — is sent with `{ expandPromptTemplates: true, deliverAs: "followUp" }`, unconditionally, on
every string, whether or not it looks like a command. Dropping `expandPromptTemplates` delivers a raw
`/command` string to the model as literal text instead of dispatching or expanding it. Dropping
`deliverAs` on a payload sent while the agent is still streaming delivers the message nowhere at all —
the caller still observes success, and the only trace is an `extension_error` event.

The prelude is the one message that uses neither shape, whenever a delegate context is registered: it
goes out as a custom message (`customType: "pi-renew-restart"`, `triggerTurn: false`) so that it
lands in the transcript and the session file without starting a turn of its own. When no context is
registered there is nothing else to deliver, so the prelude is sent as ordinary content instead — the
second send shape above — because a message that starts no turn would otherwise sit unread on an idle
fresh session.

## Where the registered context lives

Each session's registered delegate context is a JSON record at `.pi/loop/delegate-<sessionId>.json`,
under the project's working directory — not under `~/.pi/agent/`. It holds the context text, both
toggles, the restart counter, and the registration timestamp.

Because extensions are re-instantiated on every session start, nothing about the registered context can
live in memory across a restart. A `new-session` restart gives the replacement a *different* session id,
so on session start the extension looks for a record under the new id and, if none exists, adopts its
predecessor's record onto the new id by renaming the file — an atomic operation, so a crash mid-adoption
leaves exactly one of the two keys, never both, never neither. If the immediate predecessor's record is
also missing, it walks up the chain of `parentSession` references recorded in each session file's
header, up to 20 hops, looking for an ancestor's record to adopt.

Records are reaped on every session start: any `delegate-*.json` file whose mtime is older than 14 days
is deleted, except the current session's own record, which the sweep never touches regardless of age.

## When a restart fails

A restart that fails is reported on the session that is still live — the one running the failed
restart, since a failed restart by definition never replaced it — through two independent channels: an
ordinary message posted into the transcript (so the model sees it) and `ctx.ui.notify(message, "error")`
(so a human sees it even where the transcript is not visible, such as under `--mode rpc`). Both channels
carry the same sentence:

> pi-renew restart FAILED: \<reason\>. The session was NOT replaced and your context was NOT reset.
> Report this rather than continuing.

The source handles exactly five ways a restart can fail this way:

1. The `/pi-renew` restart command could not be resolved — nothing was ever dispatched.
2. `--after-turn` deferred the restart, and waiting for the run to go idle threw.
3. The stored delegate-state record is corrupt JSON, or its version field is missing or unrecognised.
4. `ctx.newSession()` threw.
5. `ctx.newSession()` returned `{ cancelled: true }` without throwing — a session-replacement handler
   declined it.

This list describes failures reported through the `/pi-renew` command handler — reached by every
`new-session` restart, and by a human typing `/pi-renew` directly. On the `compact` strategy a
corrupt delegate-state record instead fails the `delegate_to_agent` tool call itself, before anything is
compacted — an ordinary thrown tool error, not this channel — because at that point no compaction was
requested and no message was queued, so nothing was attempted yet.

## High-context reminders

When the current session's context usage crosses a configured **fraction** of the model's context
window, the extension injects a reminder message telling the agent to stop implementation work, write a
complete handover report to a markdown file **of its own choosing** — the extension names no path of its
own — and call `delegate_context_high` with that path. The reminder repeats every `repeatEveryTokens`
after the threshold, until the session is compacted, at which point it can fire again.

The threshold is recomputed from the model's live context window on every evaluation, never cached, so
switching to a model with a different window changes the effective threshold with no configuration
change needed. `delegate_context_high` is the tool that completes this flow — see
[The three tools](#the-three-tools) above.

### Configuration

Configure both model aliases and the reminder in `~/.pi/agent/pi-renew.json`:

```json
{
  "models": [
    {
      "id": "Q3.5-27B",
      "names": ["coding"]
    }
  ],
  "highContextReminder": {
    "enabled": true,
    "thresholdFraction": 0.75,
    "repeatEveryTokens": 10000
  }
}
```

If the file does not exist, the extension creates it automatically with an empty `models` list; model
switching is disabled while the list stays empty.

`highContextReminder.thresholdFraction` defaults to `0.85` — a fraction of the model's context window,
read at evaluation time so it follows a model change — and `repeatEveryTokens` defaults to `1000`.

Keep the fraction well clear of `1`. `pi` runs its own automatic compaction once usage passes
`contextWindow - reserveTokens` (`reserveTokens` defaults to `16384`), so a reminder set too close to
the top fires with too little room left to write a handover before that compaction pre-empts it — on a
200,000-token window, `0.9` leaves only 3,616 tokens.

## Model switching

`delegate_to_agent`'s optional `nextModel` parameter switches the model before the next session starts,
resolved against the same `models` array shown above: first as an exact model ID match, then as a
case-insensitive match against any entry's `names` aliases. If nothing resolves, the current model is
kept and the tool result says so.

The model switch happens **before** the restart is dispatched (or, on the `compact` path, before the
continuation message is sent), so the entire next phase — including the fresh session's first turn —
runs on the requested model.

## Technical details

Events subscribed:

- `session_start` — adopts a predecessor's on-disk delegate-state record (if any) onto the new session
  id, and reaps stale records. Never sends a message or injects a prompt.
- `context` — evaluates the high-context reminder threshold on every context evaluation.
- `session_compact` — resets the reminder milestone tracker, so the reminder can fire again after a
  compaction.
- `session_before_compact` — when a `compact`-strategy restart is pending, supplies the caller's own
  summary as the compaction entry, skipping `pi`'s default LLM summarizer; otherwise returns nothing and
  `pi` runs its normal compaction.

Runtime APIs used:

- `pi.registerTool` — registers the three tools.
- `pi.registerCommand` — registers `/pi-renew`.
- `pi.getCommands` — resolves the live invocation name of `/pi-renew` (which can be renamed on a
  collision) and validates a registered context's leading slash command.
- `pi.setModel` — switches the model before dispatching a restart, when `nextModel` resolves.
- `ctx.compact` — triggers the `compact` strategy.
- `ctx.newSession` — triggers the `new-session` strategy.
- `ctx.waitForIdle` — awaited when `--after-turn` defers a restart.

## License

MIT
