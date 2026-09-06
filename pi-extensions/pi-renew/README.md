# The `pi-renew` extension

## What this is

`pi-renew` is a restart primitive for `pi` (`@earendil-works/pi-coding-agent`): a caller registers
an opaque payload once, and the extension replays it, verbatim, into every session it restarts into.
It has no opinion about what that payload means — no persona resolution, no artifact paths of its own,
and no parameter named after a caller's workflow phase. Everything about *what work happens* belongs to
the caller; the extension only carries it across the restart boundary.

Four terms recur throughout this document:

- **Renewal context** — the caller-registered text replayed into every restarted session. Stored
  verbatim; never parsed for directives, paths or phases.
- **Restart payload** — what the fresh session receives: a **prelude** (provenance, plus the summary
  and next steps when their toggles allow) and the **context**, delivered as two separate messages.
- **Provenance** — the one unconditional line every restart opens with, carrying the restart ordinal, a
  timestamp, and the caller's opaque reason.
- **Restart strategy** — `new-session` (replace the session via `ctx.newSession()`) or `compact`
  (compact the current session in place).

## Installation

`pi-renew` is installed as a `pi` **package**, not by copying a file. The extension is six modules
(`pi-renew.ts` plus `config.ts`, `renewal-state.ts`, `renewal-context.ts`, `restart-payload.ts` and
`send-shapes.ts`); copying `pi-renew.ts` alone no longer works, because it would leave behind the
five relative imports it needs.

### Normally: install the repository

Install the **repository root**, which carries the `pi` manifest and registers this extension
alongside the `/renew-loop` prompt and the skills it drives:

```bash
pi install git:github.com/viniciusps2/pi-renew
```

See the [repo README](../../README.md#install) for the checkout, project-local and `install.mjs`
variants. There is no git URL for this subdirectory on its own — `pi` reads
`git:github.com/<user>/<repo>` and treats anything after the repo name as part of the repository
path, so a subdirectory URL fails the clone.

### Extension only, from a checkout

Take this path when you want the restart primitive **without** `/renew-loop` and the skills. The paths are
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

### `set_renewal_context`

| Parameter | Type | Description |
|---|---|---|
| `context` | string, required | The text replayed into each restarted session, stored verbatim. May be prose, a `/skill:<name> <args>` command, or a `/<template> <args>` command. |
| `includeSummary` | boolean, optional | Whether the restart payload includes the agent-supplied summary. Defaults to `true`. |
| `includeNextSteps` | boolean, optional | Whether the restart payload includes the agent-supplied next steps. Defaults to `true`. |

Registering resets the restart counter to `0`. When `context` opens with a slash command, the extension
resolves it against the runtime's known commands **at registration time**, not at delivery time, and
rejects the registration if it does not resolve — so a renewal context that could never expand is
caught immediately, instead of being replayed as literal prose on every future restart.

A context that resolves to `pi-renew`'s own restart command is rejected outright, since replaying it
would restart forever:

> Renewal context not registered: /pi-renew is this extension's own restart command, so replaying
> it would restart forever. Register the work you want replayed, not the restart itself.

```json
{
  "name": "set_renewal_context",
  "arguments": {
    "context": "/renew-loop implement tasks.md",
    "includeSummary": true,
    "includeNextSteps": true
  }
}
```

### `renew_session`

The renewal tool. Restarts the session — via whichever `strategy` is selected — carrying a summary
and next steps to the replacement.

| Parameter | Type | Description |
|---|---|---|
| `reason` | string, required | Why the session is being renewed (e.g. "completed analysis phase"). Becomes part of provenance. |
| `nextSteps` | string, required | What the next session should do. Free text; never parsed. |
| `summary` | string, required | Structured handover summary — see below. |
| `nextModel` | string, optional | Model ID or alias to switch to before the next session starts. See [Model switching](#model-switching). |
| `strategy` | string, optional | `"new-session"` or `"compact"`. See [Restart strategies](#restart-strategies). |

`renew_session`'s parameter schema sets `additionalProperties: false`, so it rejects unknown
parameters — a caller (or a stale prompt) passing a removed parameter fails loudly instead of being
silently ignored. The other two tools do not set this.

The `summary` parameter asks for six top-level sections: Goal, Constraints & Preferences, Progress, Key
Decisions, Next Steps, and Critical Context.

**Mode guard.** `renew_session` throws in `--mode print` and `--mode json`:

> renew_session requires a long-lived pi session and cannot run in --mode json. Use interactive pi
> or --mode rpc. Nothing was compacted and no continuation was queued.
>
> *(followed by the report-only directive — see [Report-only sessions](#report-only-sessions))*

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
  "name": "renew_session",
  "arguments": {
    "reason": "completed authentication analysis",
    "nextSteps": "implement unit tests for the auth module",
    "summary": "## Goal\n...\n\n## Next Steps\n...",
    "nextModel": "reviewer",
    "strategy": "new-session"
  }
}
```

### `renew_from_handover`

Completes the reminder-driven high-context handoff (see [High-context reminders](#high-context-reminders)).

| Parameter | Type | Description |
|---|---|---|
| `handoverPath` | string, required | Path to the markdown handover report you just wrote. The extension never generates or defaults this location — you supply the one you used. |

It fails if no file exists at `handoverPath`:

> Write the handover report first, then call renew_from_handover again. No file exists at: \<path\>

or if the file is empty after trimming:

> The handover report file is empty. Write the handover report first, then call renew_from_handover
> again. Use this exact path: \<path\>

On success it reads the file as the handover summary, scans the session transcript for any
previously-mentioned `*/planning/**/*task*.md` paths, and appends them to the summary inside a
`<last_tasks_read>` tag. It then calls `renew_session` internally, with `reason` set to `"context
usage too high"`, `nextSteps` pointing back at the handover path, and the **`new-session`** strategy —
explicitly, regardless of `renew_session`'s own default — because the lineage `new-session` records
via `parentSession`, and the clean session file it produces, are the more useful post-mortem artifact for
a handoff caused by running out of context window. See
[What a restarted session receives](#what-a-restarted-session-receives) for what the fresh session gets.

```json
{
  "name": "renew_from_handover",
  "arguments": {
    "handoverPath": ".pi/renew-loop/add-auth/handover-add-auth.md"
  }
}
```

## The `/pi-renew` command

The restart entry point. A human, or the extension itself (via `renew_session`'s `new-session`
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

`renew_session`'s optional `strategy` parameter selects how the restart happens.

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
summary and next steps under their toggles, then the registered renewal context as its own message. On
success, a header sentence stating that the context was reset is **prepended to the prelude** — it is
not sent on its own — so the one message that opens the fresh turn says both what happened to the
context and what to do next. When `pi` reports there was nothing to compact, the continuation proceeds
**without** a reset and says so explicitly, naming the reported reason — this is not a failure, just an
honest continuation — and the degraded path delivers the payload too: nothing was reset, but the
registered renewal context still has to be replayed, which is the whole point of the restart primitive.
Note that this is not only a small-session case: `pi` refuses to compact whenever it can find no cut
point with anything before it, which happens for any session whose token mass sits in its oldest
entries, however large it is. Any other compaction error is a genuine failure and is reported on the
transcript.

**Current default.** `renew_session`'s `strategy` parameter currently defaults to `"compact"`. The
intended eventual default is `"new-session"` — the flip is deliberately held back until the
`new-session` path has had a verified live run, and is tracked as an open item in
[`../../docs/STATUS.md`](../../docs/STATUS.md). Do not assume `new-session` is the default; pass
`strategy: "new-session"` explicitly until it becomes one.

## What a restarted session receives

The restart payload is assembled, in order, from: provenance (always), the agent-supplied summary (when
`includeSummary`), the agent-supplied next steps (when `includeNextSteps`), and the registered renewal
context (when one is registered). When no context is registered, both toggles are forced to `true` — the
summary and next steps are then the only thing the fresh session gets.

Provenance is the one unconditional line: the restart ordinal, an ISO timestamp, and the reason string
given to `/pi-renew`, carried through verbatim and uninterpreted.

**Two messages, not one.** `pi` only expands a slash command when it is the *entire* message it
receives. A single string that puts provenance before a renewal context beginning with `/skill:` or
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

The prelude is the one message that uses neither shape, whenever a renewal context is registered: it
goes out as a custom message (`customType: "pi-renew-restart"`, `triggerTurn: false`) so that it
lands in the transcript and the session file without starting a turn of its own. When no context is
registered there is nothing else to deliver, so the prelude is sent as ordinary content instead — the
second send shape above — because a message that starts no turn would otherwise sit unread on an idle
fresh session.

## Where the registered context lives

Each session's registered renewal context is a JSON record at `.pi/renew/renewal-<sessionId>.json`,
under the project's working directory — not under `~/.pi/agent/`. It holds the context text, both
toggles, the restart counter, and the registration timestamp. `.pi/renew/` belongs to this extension
alone and is keyed by session id; a caller's own documents — a `/renew-loop` handover, say — live
wherever that caller puts them, and are never written here.

Records written by a version before the rename live at `.pi/loop/delegate-<sessionId>.json` and are
not read. Nothing carries over: the record only matters across a live restart, so a stale one is
simply ignored, and `.pi/loop/` can be deleted.

Because extensions are re-instantiated on every session start, nothing about the registered context can
live in memory across a restart. A `new-session` restart gives the replacement a *different* session id,
so on session start the extension looks for a record under the new id and, if none exists, adopts its
predecessor's record onto the new id by renaming the file — an atomic operation, so a crash mid-adoption
leaves exactly one of the two keys, never both, never neither. If the immediate predecessor's record is
also missing, it walks up the chain of `parentSession` references recorded in each session file's
header, up to 20 hops, looking for an ancestor's record to adopt.

Records are reaped on every session start: any `renewal-*.json` file whose mtime is older than 14 days
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
3. The stored renewal-state record is corrupt JSON, or its version field is missing or unrecognised.
4. `ctx.newSession()` threw.
5. `ctx.newSession()` returned `{ cancelled: true }` without throwing — a session-replacement handler
   declined it.

This list describes failures reported through the `/pi-renew` command handler — reached by every
`new-session` restart, and by a human typing `/pi-renew` directly. On the `compact` strategy a
corrupt renewal-state record instead fails the `renew_session` tool call itself, before anything is
compacted — an ordinary thrown tool error, not this channel — because at that point no compaction was
requested and no message was queued, so nothing was attempted yet.

## High-context reminders

When the current session's context usage crosses a configured **fraction** of the model's context
window, the extension injects a reminder message telling the agent to stop implementation work, write a
complete handover report to a markdown file **of its own choosing** — the extension names no path of its
own — and call `renew_from_handover` with that path. The reminder repeats every `repeatEveryTokens`
after the threshold, until the session is compacted, at which point it can fire again.

The threshold is recomputed from the model's live context window on every evaluation, never cached, so
switching to a model with a different window changes the effective threshold with no configuration
change needed. `renew_from_handover` is the tool that completes this flow — see
[The three tools](#the-three-tools) above.

### `/pi-renew-reminder-on` and `/pi-renew-reminder-off`

Two commands switch the reminder for **the session you are in**, without touching
`~/.pi/agent/pi-renew.json`:

```text
/pi-renew-reminder-off    # no reminder is injected, however high context goes
/pi-renew-reminder-on     # reminders resume, from the configured threshold
```

Neither takes arguments, and each confirms the new state, the threshold it implies, and the fact that
the config file was not written. Re-issuing the state you are already in is a no-op that says so.

The switch lives in memory, which is what makes it session-scoped: every other session — including the
**replacement** session a restart creates, which loads a fresh copy of the extension — starts from
`highContextReminder.enabled` again. Silencing the reminder for one long turn therefore cannot silence
it for tomorrow's work; to change the default, edit the config.

`/pi-renew-reminder-on` also re-arms the milestone tracker, so the next evaluation above the threshold
fires even if that same milestone already fired before the reminder was switched off. Without that, a
session switched off at 116k and back on at 118k would sit silent until 125k, which reads as the
command having done nothing.

Two commands rather than one toggle: a toggle is ambiguous when nothing on screen says which state you
are in, and `off` is a state you want to be able to re-assert without gambling that you switch it back
on.

### Report-only sessions

Some sessions can never be renewed, and telling one to restart produces the worst outcome available:
the agent stops implementing, writes a handover, calls a tool that cannot work, and — because the
reminder repeats every `repeatEveryTokens` — is told again next turn, burning its remaining turns
re-announcing a restart that will never happen. Its caller gets neither the work nor a report.

In those sessions the extension sends a **different reminder**: stop, and end the turn with a report
naming what is done, what is still missing, the single next action, the context to carry over, and
the fact that the work is incomplete because the context window filled. It names no tool to call and
no file to write — the report *is* the deliverable, read off the session's final answer by whoever
spawned it, who then starts a fresh session from it.

Both renewal tools are **blocked** in such a session, via a `tool_call` handler that returns
`{ block: true, reason }` carrying the same directive the reminder gave. A block rather than an
unregistration because the extension cannot withhold a tool: `registerTool` runs in the activation
function, which receives only `pi`, and `ExtensionAPI` exposes no run mode. A block is also better
than the mode guard it sits in front of — a `reason` steers the model, where a thrown tool error
only reports a failure and invites a retry. The guard remains as the fallback for a runner that
does not fire `tool_call`, and its message now carries the directive too. The block deliberately
does **not** set `terminate`: the model still has to emit the report, and ending the batch early
would hand the caller the empty result this path exists to prevent.

A session is report-only when **either**:

| Trigger | Why |
|---|---|
| `ctx.mode` is `print` or `json` | Automatic. A one-shot process is torn down when the run settles, which is exactly when `ctx.compact()` would begin — the same condition the `renew_session` mode guard enforces |
| `PI_RENEW_REPORT_ONLY` is set to anything but `""`, `"0"` or `"false"` | Explicit. A worker driven over `--mode rpc` **is** long-lived, so a restart would technically succeed and still be wrong: the parent is blocking on a report, not on a renewed child |

The falsy spellings are real opt-**outs** and override the mode, so a launcher can export the
variable unconditionally and flip it per child. An *unset* variable is not an opt-out — it leaves
the decision to the mode.

Report-only outranks the in-flight stand-down variant, and short-circuits the disk read that
detects it: nothing in such a session can dispatch a restart, so a stale in-flight record left in
the same `cwd` by an earlier run must not divert the agent into waiting for one that will never
arrive.

### Where this came from

An observed run, and the reason the design is shaped this way rather than as a config flag.

A worker sub-agent — its own `pi` session with this extension loaded **in-process**, running a
delegation brief that ended in a nine-section report contract — crossed the threshold 98 turns in.
It got the ordinary restart reminder and obeyed it to the letter: stopped implementing, wrote a
handover file, and went looking for `renew_from_handover`. It could not find a tool by that name it
was willing to call, tried a prefixed variant, and reported back:

> The complete, non-empty handover report is already on disk at `…/worker-4-5-handover.md`.
> Steps 1–3 are done (implementation stopped; report written; no other project files touched).
> Executing step 4 now by invoking the `renew_from_handover` tool directly with that exact path.

Every phrase there is a readback of the reminder's own numbered steps. Three things went wrong at
once, and all three are addressed above:

1. **The reminder outranked the brief.** A report contract is ordinary brief text, read once at the
   start. The reminder arrives mid-run as an injected user message phrased as *"do these steps
   immediately, in order"*. The model took the newer, louder instruction — so the report the caller
   was waiting on was never written.
2. **"Implementation stopped" was the reminder's wording, not a finding.** The parent read it as a
   blocker report and had to go read the tree to discover whether any code had landed. Hence the
   report-only directive's insistence on the word INCOMPLETE and on naming the files actually
   changed: a caller must be able to tell a stopped run from a finished one without a diff.
3. **It repeated.** With `repeatEveryTokens` at its 1000 default, every subsequent turn past the
   threshold re-issued the same instruction, so the worker kept re-announcing "steps 1–3 done,
   executing step 4 now" and groping for the tool, until the run ended. A restart that cannot be
   dispatched does not fail once — it fails every turn, and each failure costs the context that
   triggered it.

One loose end this change does **not** close: the worker groped for the tool name rather than
calling it cleanly, which means the reminder may have been pointing at a tool that was not on that
session's surface at all. A known cause is a duplicate extension install — `pi` refuses the losing
copy's registrations with `Tool "renew_session" conflicts with …` (see
[STATUS.md](../../docs/STATUS.md), precondition 2), while the `context` hook keeps firing and keeps
naming tools that are not there. Report-only mode does not detect that; it only ensures the reminder
stops naming a tool in the sessions where naming one is guaranteed to be wrong.

The parent's own reading of the transcript is worth recording, because it is the shape this
failure presents in:

> Interesting. The worker child wrote a handover file and is now trying to call
> `renew_from_handover` with that path. But wait — that's the child's tool. The child is trying to
> restart its own session? That's odd.

It was not odd, and it was not confusion on the child's part. It was the extension telling a
session to do the one thing that session could not do, and then telling it again.

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
`enabled` is the per-session *starting* state: `/pi-renew-reminder-off` and `/pi-renew-reminder-on`
override it for the session you are in, and never write this file.

Keep the fraction well clear of `1`. `pi` runs its own automatic compaction once usage passes
`contextWindow - reserveTokens` (`reserveTokens` defaults to `16384`), so a reminder set too close to
the top fires with too little room left to write a handover before that compaction pre-empts it — on a
200,000-token window, `0.9` leaves only 3,616 tokens.

## Model switching

`renew_session`'s optional `nextModel` parameter switches the model before the next session starts,
resolved against the same `models` array shown above: first as an exact model ID match, then as a
case-insensitive match against any entry's `names` aliases. If nothing resolves, the current model is
kept and the tool result says so.

The model switch happens **before** the restart is dispatched (or, on the `compact` path, before the
continuation message is sent), so the entire next phase — including the fresh session's first turn —
runs on the requested model.

## Technical details

Events subscribed:

- `session_start` — adopts a predecessor's on-disk renewal-state record (if any) onto the new session
  id, and reaps stale records. Never sends a message or injects a prompt.
- `context` — evaluates the high-context reminder threshold on every context evaluation, unless the
  session has switched the reminder off with `/pi-renew-reminder-off`.
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
