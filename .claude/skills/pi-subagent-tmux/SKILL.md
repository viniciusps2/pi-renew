---
name: pi-subagent-tmux
description: >-
  Drive a long-lived `pi` TUI session inside a tmux pane from the shell: start it, send it
  text, poll whether it has settled or died, read what it produced, and stop it. Use when a
  task needs to exercise the interactive terminal surface itself — the one production
  actually uses — rather than the scripted RPC surface (see `pi-subagent-rpc`), for example
  testing or developing against the real TUI. Triggers: "start a pi tmux session", "drive pi
  in a tmux pane", "test the interactive pi TUI", "run pi under tmux".
---

# pi as a long-lived tmux session

Drive `pi`'s interactive TUI inside a detached tmux pane: a `start` call creates the pane and
returns immediately; `send`, `settled`, `dead`, `read` and `stop` are separate, stateless
invocations that can run minutes apart, from different shells, and still agree on the
session's state. This is the **driver contract** — start · send · settled? · dead? · read,
plus `stop` — described in full, with the rules and the measured evidence behind them, in
[`../pi-driver-common/CONTRACT.md`](../pi-driver-common/CONTRACT.md). Read that document for
*why*; this one is the *how* for this specific backend.

```bash
PI_TMUX=.claude/skills/pi-subagent-tmux/pi-tmux.js
```

## Quickstart

```bash
RUN_DIR=$(node $PI_TMUX start --run-dir /tmp/my-tmux-session)   # creates the tmux pane, exits immediately
node $PI_TMUX send --run-dir "$RUN_DIR" "Reply with exactly: OK"
node $PI_TMUX settled --run-dir "$RUN_DIR" --wait 120            # blocks until settled, dead, or 120s
node $PI_TMUX read --run-dir "$RUN_DIR"                           # prints the model's last answer
node $PI_TMUX stop --run-dir "$RUN_DIR"                           # closes the session; kills the pane
```

A cheap, tool-free probe (what this skill's own `smoke.sh` uses) adds raw `pi` flags after a
literal `--`, passed through verbatim after this driver's own flags, exactly as
`pi-subagent-rpc` does:

```bash
node $PI_TMUX start --run-dir /tmp/probe -- --no-tools
```

## Verbs

| Verb | Flags | Behaviour |
|---|---|---|
| `start` | `--run-dir <dir>` (required) `--model <id>` `--cwd <dir>` `--approve` `--idle <s>` `[-- <extra pi flags>]` | Validates the model, creates the run directory, creates the tmux session, prints the run dir, exits 0 immediately. |
| `send` | `--run-dir <dir>` `<text>` | Delivers text to the TUI's composer and submits it. |
| `settled` | `--run-dir <dir>` `[--wait <s>]` | Exit 0 if settled, 1 if not. `--wait` polls until settled, dead, or the wait elapses — see *Idle floor* below for what happens when `--wait` is omitted. |
| `dead` | `--run-dir <dir>` | Exit 0 if the pane is dead (or no longer exists at all), 1 if alive. |
| `read` | `--run-dir <dir>` `[--all]` | Prints the last assistant text (or every assistant text seen, with `--all`) to stdout. Exits 0/4/3 per the outcome (see below). |
| `stop` | `--run-dir <dir>` `[--kill]` | Shuts the tmux session down; reports the result. |

`--model` defaults to the shared pin in `../pi-driver-common/model.js`
(`llm-1/qwen3.8-27b`) and is validated against `pi --list-models` before anything is created —
see the contract doc for why a bare or uncatalogued id is rejected rather than silently
substituted.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | (`read`) settled, and the session produced assistant text. (`send`/`start`/`stop`) succeeded. (`settled`/`dead`) true. |
| `1` | (`settled`/`dead`) false. (`read`) the session is still actively running — call `settled --wait` or `dead` first, same as `pi-subagent-rpc`. |
| `2` | Usage error — bad flags, an unqualified or uncatalogued model id, the tmux session already exists, or a missing run directory. No tmux session is created. |
| `3` | (`read`) the session died: the tmux pane exited with no settled turn boundary recorded. |
| `4` | (`read`) settled, but the session produced no assistant text. |

**`124` never occurs in this backend.** There is no `--timeout` flag and no absolute
wall-clock ceiling here, because there is no supervisor process to enforce one — see *There is
no supervisor* below. A caller that needs a hard ceiling on a tmux-driven session has to
enforce it itself, from outside.

## There is no supervisor

Unlike `pi-subagent-rpc`, this backend spawns **no** detached supervisor and runs **no**
separate watchdog process. tmux itself is the supervisor: `remain-on-exit on` (set in the same
tmux invocation that creates the session, so a process that dies in the gap between two
separate tmux calls never leaves an uninspectable pane) keeps the pane around after `pi` exits,
and `#{pane_dead}` reports death almost instantly (measured: within 7ms of a `SIGKILL`, far
faster than the ~2s a stale estimate elsewhere in this project's planning documents suggests —
do not design around that older number). Every verb here is a short-lived, stateless process
that shells out to `tmux` and reads/writes the run directory's files; nothing stays running
after a verb returns.

One consequence beyond `124` never firing: `send` has **no `--follow-up` flag**. The RPC
backend's `--follow-up` queues a follow-up prompt onto an active run through its own queue;
there is no such queue here — a TUI submission delivered while a run is still streaming is
whatever the TUI itself does with it, which is not this driver's business to arbitrate.

## Reading state, never the screen

There is a real screen here — a tmux pane, not just JSONL over stdio — but the discipline
still holds: every verb above derives `settled`, `died`, the last (or every) assistant text,
and any errored `stopReason` from `pi`'s own **persisted session file**
(`<run-dir>/sessions/*_<sessionId>.jsonl`), through
`../pi-driver-common/session.js`'s `foldSessionEntries` — never by reading the pane's rendered
content. Screen text carries a systematic false-positive class a settle heuristic only partly
mitigates, which is exactly why state comes from the file instead.

**`settled` reads a turn boundary, not an `agent_settled` event** — there is no such event in
a persisted session file (that concept is specific to the RPC event stream). Instead, the
session is settled exactly when the file's **last** message is an assistant message whose
`stopReason` is `"stop"`, `"length"`, or `"aborted"`. See CONTRACT.md's `foldSessionEntries`
section for the complete rule, including why `"toolUse"` and `"error"` are both **not**
settled. The one-line consequence worth knowing up front: **a session `pi` auto-retries after
an error is reported as not-settled until the retry lands** — `pi` can emit an assistant
message with `stopReason: "error"` and then continue on its own with another attempt, and this
driver correctly keeps reporting "not settled" through that whole window rather than stopping
early at the error. `read` surfaces every such error to stderr (prefixed `pi-tmux:
stopReason=error`) without changing the exit code, so a caller polling `settled --wait` isn't
left guessing why it's taking longer than expected.

**An absent session file means "nothing back yet" — never an error, never a death.** Measured
in `pi`'s own source: its session persistence writes nothing at all until the session holds at
least one assistant message, so a pane that has submitted a prompt and is still sitting at
"Working…" has, correctly, no file on disk yet. `settled` reports "not settled" (exit 1) for
this, exactly as it would for any other in-progress turn — not a special case.

**`capture-pane` is used for exactly one thing.** `read` on a **dead** pane additionally
prints the last on-screen content to stderr — the spec's own requirement that a dead pane's
last screen be preserved and exposed. It is never consulted for `settled`, for `dead`, or for
the answer text; state always comes from the session file. Verify this yourself:

```bash
grep -n "capture-pane" .claude/skills/pi-subagent-tmux/pi-tmux.js
```

should return only the one line inside `read`'s dead-pane branch.

## Idle floor

**A deliberate, bounded difference from the RPC backend.** There is no supervisor here
(above), so there is no background process independently enforcing an idle ceiling the way
`pi-subagent-rpc`'s supervisor does — this driver's only participation in the shared idle
discipline is in `settled --wait` itself. When `--wait <seconds>` is given explicitly, that
value is used verbatim, exactly like the RPC backend. When it is **omitted**, the default is
**not** "check once" the way the RPC backend's `settled` is — it is
`computeIdleSeconds({ surfaceBytes, explicitIdle })` from
`../pi-driver-common/idle.js`, using the `surfaceBytes` estimate `start` recorded in
`meta.json` (the same binary 0-or-full-anchor rule the one-shot driver's `--idle` wiring
uses: 0 when the extra pass-through flags disable tools, the measured ~96KB full-surface
anchor otherwise — see `pi-agent.sh`'s own comment on this rule for the full reasoning) and
the `--idle` value `start` was (or wasn't) given. `start --idle N` therefore still governs a
later bare `settled` call's default, verbatim, including `0`.

## Project trust

`--approve` maps to `pi -a`, off by default, for the same reason as `pi-subagent-rpc`:
starting a session non-interactively skips the trust prompt even though the surface itself is
interactive, so a project-local `.pi/skills/` or `.pi/prompts/` resource silently does not
exist without it.

## Live proof

`smoke.sh` is not part of `node --test` — it needs a real model endpoint and a real tmux
session, so a unit-test run must never depend on it:

```bash
.claude/skills/pi-subagent-tmux/smoke.sh /tmp/pi-tmux-smoke
```

It runs two scripted scenarios against `--no-tools` sessions (so they finish in seconds, not
minutes): a normal settle-and-read round trip, and a `stop --kill` reported as a death. Exits
non-zero on the first mismatch, and best-effort cleans up any tmux session it leaves behind.
