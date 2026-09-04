---
name: pi-subagent-rpc
description: >-
  Drive a long-lived `pi --mode rpc` session from the shell: start it, send it text, poll
  whether it has settled or died, read what it produced, and stop it. Use when a task needs
  a session that stays up across several separate shell invocations — polling for
  completion, sending a follow-up after the model finishes, or asserting on the session's
  structured event stream — which a one-shot sub-agent (see `pi-subagent`) cannot do because
  it exits the moment its single turn ends. Triggers: "start a pi rpc session", "drive pi
  over rpc", "keep a pi session running across calls", "send a follow-up to the running
  agent", "poll whether the session has settled".
---

# pi as a long-lived RPC session

Drive `pi --mode rpc` as a detached, long-lived session: a `start` call launches it and
returns immediately; `send`, `settled`, `dead`, `read` and `stop` are separate, stateless
invocations that can run minutes apart, from different shells, and still agree on the
session's state. This is the **driver contract** — start · send · settled? · dead? · read,
plus `stop` — described in full, with the rules and the measured evidence behind them, in
[`../pi-driver-common/CONTRACT.md`](../pi-driver-common/CONTRACT.md). Read that document for
*why*; this one is the *how* for this specific backend.

```bash
PI_RPC=.claude/skills/pi-subagent-rpc/pi-rpc.js
```

## Quickstart

```bash
RUN_DIR=$($PI_RPC start --run-dir /tmp/my-session)     # prints the run dir, exits immediately
$PI_RPC send --run-dir "$RUN_DIR" "Reply with exactly: OK"
$PI_RPC settled --run-dir "$RUN_DIR" --wait 120         # blocks until settled, dead, or 120s
$PI_RPC read --run-dir "$RUN_DIR"                        # prints the model's last answer
$PI_RPC stop --run-dir "$RUN_DIR"                        # closes stdin; pi exits cleanly
```

A cheap, tool-free probe (what this skill's own `smoke.sh` uses) adds raw `pi` flags after a
literal `--`, passed through verbatim after this driver's own flags:

```bash
$PI_RPC start --run-dir /tmp/probe -- -nt -ne -nc
```

## Verbs

| Verb | Flags | Behaviour |
|---|---|---|
| `start` | `--run-dir <dir>` (required) `--model <id>` `--cwd <dir>` `--approve` `--idle <s>` `--timeout <s>` `[-- <extra pi flags>]` | Validates the model, creates the run directory, spawns a detached supervisor, prints the run dir, exits 0 immediately. |
| `send` | `--run-dir <dir>` `[--follow-up]` `<text>` | Appends one `prompt` command to `in.jsonl`; the running supervisor forwards it to `pi`'s stdin. `--follow-up` adds `"streamingBehavior":"followUp"`, queuing the text for once the current run finishes (rejected by `pi` if nothing is streaming — send a plain prompt in that case). |
| `settled` | `--run-dir <dir>` `[--wait <s>]` | Exit 0 if settled, 1 if not. `--wait` polls (every 200ms) until settled, the session dies, or the wait elapses. |
| `dead` | `--run-dir <dir>` | Exit 0 if the `pi` process has exited, 1 if it is still running. |
| `read` | `--run-dir <dir>` `[--all]` | Prints the last assistant text (or every assistant text seen, with `--all`) to stdout; prints any `extension_error` events to stderr first. Exits 0/4/3 per the outcome (see below). |
| `stop` | `--run-dir <dir>` `[--kill]` | Closes the session's stdin (or sends SIGKILL with `--kill`), waits for it to exit, reports the result. The one verb beyond the five-operation contract — a long-lived session with no shutdown path leaks a process that pins the model it loaded. |

`--model` defaults to the shared pin in `../pi-driver-common/model.js`
(`llm-1/qwen3.8-27b`) and is validated against `pi --list-models` before anything is created —
see the contract doc for why a bare or uncatalogued id is rejected rather than silently
substituted.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | (`read`) settled, and the session produced assistant text. (`send`/`start`/`stop`) succeeded. (`settled`/`dead`) true. |
| `1` | (`settled`/`dead`) false. (`read`) the session is still actively running — call `settled --wait` or `dead` first; this exit falls outside the three-outcome table below by design (see "Reading a still-running session"). |
| `2` | Usage error — bad flags, an unqualified or uncatalogued model id, or a missing run directory. No `pi` process is spawned. |
| `3` | (`read`) the session died: the stream ended, or the process exited, with no `agent_settled`. |
| `4` | (`read`) settled, but the session produced no assistant text. |

## Idle floor

`--idle <seconds>` still wins verbatim when given, including `0` to disable the watchdog. When
it is **omitted**, the supervisor no longer sits at the bare 60s floor for every session: right
after `pi` spawns, it sends one `get_commands` request over the RPC pipe (no model call, ~1.5s,
harmless even while a model endpoint is down) and, once the response arrives, recomputes the
idle floor from the size of the **actually loaded** tool/extension surface — via the same shared
`computeIdleSeconds`/`surfaceBytesFromCatalogue` formula in `../pi-driver-common/idle.js` every
driver skill uses — and rewrites `meta.json` so a later reader sees the number actually in
force. This is skipped entirely when `--idle` was given explicitly: an explicit choice always
wins over a computed guess. `get_state` was considered as the size probe and rejected: measured
flat at 892 bytes regardless of how large the surface is, which makes it useless here (see
`../pi-driver-common/CONTRACT.md`, Rule 4).

## Project trust

`--approve` maps to `pi -a`. It is **off by default**. Non-interactive modes never prompt for
trust, so without `--approve` a project-local `.pi/skills/` or `.pi/prompts/` resource
**silently does not exist** for the session — not an error, just absence. A flow that uses
only globally installed resources needs no approval and should leave this off.

## Reading state, never the screen

There is no screen here — RPC mode is pure JSONL over stdio — but the discipline still
matters: every verb above reads `<run-dir>/events.jsonl` (and, once the session has exited,
`<run-dir>/status.json`) through `../pi-driver-common/session.js`'s `foldEvents`, never by
re-deriving "settled" or "died" ad hoc. If a future change to this skill needs a new piece of
session state, it belongs in `session.js`, not duplicated here.

`pi`'s own session file is kept too, under `<run-dir>/sessions/`. That is a deliberate
difference from the one-shot `pi-subagent`, which runs `--no-session` because a single turn
has nothing worth persisting: a long-lived session's file is the only artifact carrying its
id and its lineage, and it is the source of truth the sibling tmux backend reads state from,
so the two backends would otherwise disagree about what "read state from the session" means.
Append `-- --no-session` to `start` for an ephemeral run.

## Reading a still-running session

`read`'s 0/3/4 exit codes describe a *finished* session (decision 4 in the contract doc — see
there for the full table). Calling `read` before the session has settled or died is a
legitimate thing to do (all five stateless verbs must work independently, at any time), but
it has no place in that three-way table: nothing has happened yet to classify. `read` in that
case prints whatever partial text has arrived and exits `1` — the same "not yet" signal
`settled` and `dead` already use — rather than forcing a guess into 0/3/4. The intended
pattern is `settled --wait` (or `dead`) before `read`, exactly as the quickstart above does.

## Extension errors

A throwing `pi` extension emits `{"type":"extension_error",...}` mid-run, and the run then
**settles successfully anyway** — nothing about the exit code or the model's own answer
records the failure. `read` prints every such event to stderr, prefixed
`pi-rpc: extension_error:`, before printing the answer to stdout, without changing the exit
code. Check stderr, not just the exit code, if a flow depends on an extension having actually
worked.

## Live proof

`smoke.sh` is not part of `node --test` — it needs a real model endpoint and costs real
seconds, so a unit-test run must never depend on it:

```bash
.claude/skills/pi-subagent-rpc/smoke.sh /tmp/pi-rpc-smoke
```

It runs two scripted scenarios against `--no-tools` sessions (so they finish in seconds, not
minutes): a normal settle-and-read round trip, and a `stop --kill` mid-stream that must be
reported as a death. Exits non-zero on the first mismatch, and best-effort stops any session
it leaves running on the way out.
