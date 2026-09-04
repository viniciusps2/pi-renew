# The driver contract

This is the discipline every long-lived `pi` driver skill (`pi-subagent-rpc`,
`pi-subagent-tmux`, and the existing one-shot `pi-subagent`) shares. It exists because three
skills differing only in *how* they talk to `pi` (one-shot process exit, RPC over stdio,
tmux over a pty) will drift into three different notions of "done", "dead" and "which model"
unless that discipline lives in one place. If you are building a fourth driver, or changing
one of the three, this is the document to read and the document to keep matching — not the
individual skills, which link here rather than restate any of this.

A driver implements five operations and nothing else: **start** a `pi` session, **send** it
text, report whether it has **settled**, report whether it has **died**, and **read** what it
produced. A driver does not know what its caller is doing with those five operations — no
vocabulary about restarts, handovers, briefs, review steps, or any other workflow phase
belongs here or in a driver built against this contract.

## The five operations, plus one

| Operation | What it means |
|---|---|
| start | Launch a `pi` session against a validated, fully-qualified model id. |
| send | Deliver text to the running session. |
| settled? | Has the session's current run fully finished — no retry, no compaction retry, no queued continuation left? |
| dead? | Has the underlying process exited? |
| read | Return what the session produced (and any extension errors it hit along the way). |

A driver MAY add exactly one more verb, **stop**, to close a session down cleanly — closing
stdin, or escalating to a hard kill. That is a lifecycle concern, not a workflow one, and a
long-lived driver with no way to shut down leaks a process that pins the model it loaded.
Nothing beyond these six verbs belongs in a driver built against this contract: no `status`
verb distinct from `dead`/`settled`, no sentinel-marker protocol, no restart or handover
awareness.

## Exit codes

Every driver reports one of these. They are not new: they are the numbering the existing
one-shot driver (`skills/pi-subagent/pi-agent.sh`) already uses, extended by nothing — a
later cross-verification of every driver skill is only meaningful if all of them share one
table rather than each inventing its own.

| Code | Meaning |
|---|---|
| `0` | Settled, and the session produced assistant text. |
| `2` | Usage error — bad flags, an unqualified or unknown model id, a missing run directory. |
| `3` | The session died: the stream ended, or the process exited, with no `agent_settled`. |
| `4` | Settled, but the session produced no assistant text. |
| `124` | The absolute wall-clock ceiling was exceeded. |

`exit-codes.js` exports these as named constants (`EXIT_SETTLED_WITH_TEXT`, `EXIT_USAGE`,
`EXIT_DIED`, `EXIT_SETTLED_NO_TEXT`, `EXIT_TIMEOUT`) plus `exitCodeForOutcome(outcome)`,
mapping `"settled-with-text" | "settled-no-text" | "died"` to `0 | 4 | 3`.

## Rule 1 — Settle source: `agent_settled`, and nothing else

A session is settled when the runtime emits a single `agent_settled` event for the whole
session-level run, including any queued follow-up. It is **not** settled when:

- **a new assistant message arrives.** A tool call *is* an assistant message (thinking +
  toolCall content, no text block) — a detector keyed on "a new assistant message" fires
  while the model is mid-turn, before the tool has even run.
- **`turn_end` fires.** Measured on a live one-tool run (milliseconds from spawn):

  ```
  response(prompt)@510  agent_start@510  turn_start@510  message_end[user]@510
  message_end[assistant: thinking+toolCall]@1912     <- a tool call IS an assistant message
  tool_execution_start[bash]@1913 ... tool_execution_end@1938
  message_end[toolResult]@1939   turn_end@1939       <- turn_end fires HERE, mid-run
  turn_start@1939  message_end[assistant: thinking+text]@3139  turn_end@3139
  agent_end@3140   agent_settled@3141
  ```

  `turn_end` fires 1.2 seconds before the run is actually done.
- **`agent_end` fires.** The protocol allows an automatic retry, a compaction retry, or a
  queued continuation to follow it — `agent_end` is "one low-level agent run completed", not
  "the session is done with this prompt".
- **screen text changes.** There is no screen in RPC mode, and even where there is one (the
  tmux backend) it carries a systematic false-positive class a settle heuristic only partly
  mitigates.

A queued follow-up (`{"type":"prompt","streamingBehavior":"followUp",...}` — the field is
camelCase; `"follow_up"` is a different, unrelated command type) continues the **same** agent
run. Measured: one `agent_settled`, at the very end, after the continuation's own turn
completed. So waiting on `agent_settled` already waits through a queued continuation for
free — a driver must not add any queue bookkeeping to make that work, and must not treat a
follow-up as a second run.

`session.js`'s `foldEvents` is the one place this is implemented: it treats `agent_start` as
resetting "settled" to false and `agent_settled` as setting it to true, so folding is correct
across a long-lived session's second and later turns, not just its first.

## Rule 2 — Death detection: EOF or process exit with no preceding `agent_settled`

Measured: a `SIGKILL` sent mid-run gives `exit code=null, signal="SIGKILL"` and a stream
truncated after a `message_start` — no `agent_settled` anywhere in it. That is the *only*
distinction between "died" (exit `3`) and "settled but produced no text" (exit `4`), and it
is decidable from the event stream once the caller can say whether the stream has actually
ended. `foldEvents(events, { ended })` takes that as an explicit input rather than guessing it
from the events themselves — "no `agent_settled` yet" means something different while a
session is still running (it just hasn't finished) than it does once the process is
confirmed gone (it died).

## Rule 3 — Model validation: fully-qualified, catalogued, no silent fallback

`pi` does **not** fail on an unknown model id. Measured:

```
$ pi -p --mode json -ne -nt --model "llm-1/definitely-not-a-model" --no-session "hi"
Warning: Model "definitely-not-a-model" not found for provider "llm-1". Using custom model id.
{"type":"session",...}          <- the run proceeds
EXIT=0
```

So "no silent fallback" cannot be delegated to `pi` — a driver validates the model itself,
before launch, and only accepts fully-qualified ids (`provider/model`, e.g.
`llm-1/qwen3.8-27b` — never a bare id, never a glob).

- The catalogue is `pi --list-models`, read with no search term (offline, ~1.5s here). Its
  output is a header line plus whitespace-aligned columns:
  `provider  model  context  max-out  thinking  images`. `pi --list-models <search>` prints
  `No models matching "..."` and still **exits 0** — never branch on that command's exit
  status; reading the whole catalogue once and searching it in-process sidesteps the trap
  rather than working around it.
- **A model column can itself contain a `/`.** This catalogue really does contain the row
  `openrouter  qwen/qwen3.8-27b`. A candidate id therefore splits on the **first** `/` only:
  provider is everything before it, model is everything after.
  `"openrouter/qwen/qwen3.8-27b"` → provider `"openrouter"`, model `"qwen/qwen3.8-27b"` →
  **found**. A `candidate.split("/")[1]` implementation would instead compute model `"qwen"`
  — and because a catalogue can also contain a bare `openrouter qwen` row, that wrong
  implementation can still find *something* and report success against the wrong id.
- There is **no** fuzzy matching, no glob, and no discovery-and-pick-the-first. An id that
  has no `/` at all is rejected as unqualified **before** the catalogue is even read.

`model.js` exports `resolveModelId(candidate, { listModels })`, with the catalogue reader
injected so callers (and tests) never have to shell out to get a rejection decision.

## Rule 4 — Idle floor: rises with the loaded surface, never below 60s, event-aware

```js
computeIdleSeconds({ promptBytes = 0, surfaceBytes = 0, explicitIdle })
// explicitIdle !== undefined  -> return explicitIdle verbatim (including 0 = disabled)
// otherwise                   -> max(60, ceil((promptBytes + surfaceBytes) / 1024) + 30)
```

Measured anchor: with the full extension surface loaded and project trust granted, a cold
start reported `usage.input = 23974` tokens and its first `message_update` arrived at
**13,274 ms**; the same model with no tools and no extensions produced its first event at
**499 ms**. ~24K tokens is ~96KB, which the formula turns into **124s** — comfortably past
the 90s that has been observed to kill a real run — while a trivial prompt stays at the 60s
floor. The constants are fixed; the tests assert the formula's *shape* (rises with size,
never below the floor, an explicit override wins verbatim), not the constants, so re-tuning
the numbers later invalidates no test.

`idle.js`'s `IdleWatchdog` additionally owns one rule inherited unchanged from the one-shot
driver: while a tool call is in flight (`tool_execution_start` seen with no matching
`tool_execution_end` yet), the idle clock is **suspended**, because a legitimately long silent
tool (a ten-minute test run that prints nothing) is not a stall. Feed it every event; ask it
`timedOut()`.

**Correction — catalogue bytes are not prompt bytes.** The formula above is written against
*prompt* bytes, but the quantity a driver can measure without a model call is the size of a
`get_commands` catalogue response, and the two are not the same number: feeding the raw
catalogue size straight into `computeIdleSeconds` produces no rise at all (measured: a
full-surface `get_commands` response is 26,710 bytes, and `ceil(26710/1024)+30 = 57`, which the
60s floor swallows). `idle.js` exports `surfaceBytesFromCatalogue(catalogueBytes)` for this —
the measured anchor is `CATALOGUE_TO_PROMPT_BYTES = 3.6` (95,896 prompt bytes / 26,710 catalogue
bytes for the same full surface, both measured in this repo with `-a`). `get_state` was
considered as the size probe instead of `get_commands` and rejected: measured **flat at 892
bytes** regardless of whether the surface loaded is bare or full, which makes it useless as a
proxy for anything.

## Reading state, not the screen

A driver reads what a session is doing from its persisted event stream — never from rendered
screen output, even where a screen exists. `session.js`'s `foldEvents` is the one place a
driver should derive `settled`, `died`, the last (or every) assistant text, and any
`extension_error` events; a driver should not re-derive any of these against the raw stream
itself.

Extension errors are reported, not swallowed: a throwing extension emits
`{"type":"extension_error","extensionPath":"...","event":"...","error":"..."}` mid-run, and
measured, the run then **settles successfully anyway** — nothing in the answer, the exit
code, or the model's own view of the conversation records the failure. So `foldEvents`
collects every `extension_error` it sees, separately from — and without changing — the settle
outcome; a caller surfaces them (e.g. to stderr) alongside, not instead of, the answer.

### `foldSessionEntries` — the tmux backend's counterpart

The tmux backend has no RPC event stream to read; it reads `pi`'s own **persisted session
file** (JSONL under `--session-dir`) instead, through `session.js`'s `foldSessionEntries`,
which returns the same shape `foldEvents` does so `outcomeForFold`/`exitCodeForOutcome` are
reused unchanged by both backends. Record types, measured across 60 real session files:
`message` (4014), `thinking_level_change` (65), `model_change` (61), `session` (60),
`custom_message` (10), `session_info` (3), `compaction` (1) — there is **no `agent_settled`**
anywhere in a session file, so the turn boundary is read off the **last** `type:"message"`
entry's `stopReason` instead.

The complete `StopReason` union, from the installed type declarations
(`@mariozechner/pi-ai/dist/types.d.ts:130`), is `"stop" | "length" | "toolUse" | "error" |
"aborted"`. Settled is exactly `"stop"`, `"length"`, `"aborted"`. `"toolUse"` is not settled —
a tool result is still to come. `"error"` is deliberately **not** a settle either, and this is
the non-obvious call: `pi` auto-retries, so another assistant message can follow an errored
one, and reporting settled at the error would report a settle in the middle of a retry — the
error is instead surfaced separately (`erroredStopReasons`) without changing the outcome, the
same shape the extension-error rule above already uses. Any **unrecognised** `stopReason` is
treated as not settled, on the same principle `foldEvents`'s own `default: break` follows: a
new value must never silently read as "done".

An **absent session file** means "no assistant message yet", never death and never an error:
measured in `pi`'s own source, `dist/core/session-manager.js`'s `_persist` returns early while
the session holds no assistant message, so a TUI that submitted a prompt and is still waiting
for the first token has written **no file at all**. `foldSessionEntries` handles `ENOENT`
explicitly rather than letting it throw; an empty entry list folds to "not settled, not died",
exactly like a session that has barely started.

## Restart supervision (a verdict, not a seventh verb)

A driver MAY add one *decision-only* module for restart supervision (`supervision.js`). It
folds a **post-restart event slice** into a single **verdict** — a pure "feed events → verdict"
function (`superviseRestart`), mirroring how `idle.js` injects its clock and `session.js` owns the
settle rule (the settle source is `agent_settled`, nothing else, so a tool-call assistant message is
not a settled turn).

- **The verdict set is four named tokens** (`SUPERVISION_VERDICTS`, frozen): `"success"` (a settled
  continuation turn within the window), `"no-continuation"` (the window elapsed with none),
  `"already-processing"` (an "already processing / `streamingBehavior`" `extension_error`, decided
  immediately — see `classifyRestartExtensionError`), and `"pending"` (not yet decidable).
- **It is distinct from, and additive to, the five-code exit table above — which is unchanged.**
  There is **no** seventh exit code; the "distinct, stable signal" is the named verdict / signal name
  (`supervisionSignalName` → `restart-supervision:<token>`), which a later driver emits as a named
  event or status field. `exit-codes.js` and its 0/2/3/4/124 table are not touched.
- **The "already processing" class is folded into supervision, not the extension (design D5):** the
  throw is an *event* (fire-and-forget, swallowed by the SDK), so only the event-observing driver can
  catch it. It is therefore reported by the driver as a restart failure and is *not* something the
  extension reports.
- **The *live* wiring that watches a real restart is a separate, later batch.** This module is the
  pure decision core only — it does not detect that a restart happened, does not add a verb, and does
  not touch `pi-rpc.js`/`pi-tmux.js`.

## Framing

RPC mode's event stream uses strict JSONL: split records on `\n` only, strip one optional
trailing `\r`, and never use a generic line reader — `node:readline` also splits on the
Unicode LINE SEPARATOR and PARAGRAPH SEPARATOR code points, both of which are legal unescaped
inside a JSON string. `jsonl.js`'s `JsonlDecoder` implements exactly the three framing rules
and nothing else.
