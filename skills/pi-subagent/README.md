# pi-subagent internals

Reference for [SKILL.md](SKILL.md) — the details you need when something goes wrong, when you edit
the wrapper, or when you want to bypass it.

## How it works

Per call the wrapper runs:

```bash
pi -p --mode json --model llm-1/qwen3.8-27b --thinking low \
   --no-extensions --no-session --no-context-files [tool flags] "PROMPT"
```

- `--mode json` streams typed JSONL events; the **last `agent_end`** carries every message of the
  run. The final answer is the last assistant message's text blocks:
  ```bash
  jq -r 'select(.type=="agent_end") | .messages | map(select(.role=="assistant")) | last
         | (.content // []) | map(select(.type=="text") | .text) | join("")'
  ```
- Tools (read/bash/edit/write) run **headlessly with no approval prompt**. Restrict with `--tools`,
  or `--no-tools` for reasoning only.
- Model/server failures appear as events (`auto_retry_end {success:false}`, a `502`, or a `not found`
  on stderr); the wrapper detects the missing `agent_end` and exits `3`.
- The defaults isolate the run — `--no-extensions` (no `pi-continue`/`pi-renew`/LSP noise),
  `--no-session` (ephemeral), `--no-context-files` (ignore repo `AGENTS.md`/`CLAUDE.md`). Opt back in
  with `--with-ext` / `--session` / `--keep-context`.

Text mode (`pi -p "…"` with no `--mode json`) is worth using only for trivial reasoning where you
take stdout verbatim: it has no structured error signal and mixes tool rendering into stdout.

## How the watchdog knows a tool is running

It reads pi's JSONL stream: a `tool_execution_start` with no matching `tool_execution_end` yet means
a call is in flight, and the idle timer is suspended until the end event arrives. That is why a
10-minute silent build survives `--idle 180` while a model that stalls between tool calls does not.

## Why the idle default is computed, not a flat 60s

With extensions and MCP tools loaded the prompt reaches ~23.5K input tokens, and the first token can
take longer than a small run's idle timeout — observed above 90s, which used to kill runs before they
produced anything.

The wrapper derives the default from the same shared formula every driver skill uses
(`computeIdleSeconds` in `../pi-driver-common/idle.js`, reached through `../pi-driver-common/idle-cli.js`
since this wrapper is bash). It feeds in the byte size of the prompt about to be sent, plus `0` when
the run has **neither** tools nor extensions (`--no-tools` with no `--with-ext`) or a fixed
full-surface estimate (~96KB, the measured anchor behind the formula) otherwise. A trivial
`--no-tools` run still gets the 60s floor; a real `--with-ext` run gets a proportionally longer
default. If the helper call fails, the wrapper falls back to the 60s floor with a warning on stderr
rather than refusing to start.

## The two JSONL shapes

`pi-follow` renders both — this is the thing to get right:

| Shape | Written by | Granularity |
|---|---|---|
| **event stream** — `message_update`, `tool_execution_*`, `agent_end` | `pi --mode json`, i.e. every `pi-agent` run | token deltas, so text appears **as it is generated** |
| **session transcript** — `type:"message"` records | only `pi --session-id`, i.e. `--session <id>` | whole messages, appended as each completes |

## Recovering an answer from a dead wrapper

The sub-agent runs in its own process group and outlives the wrapper. A wrapper that dies late —
killed, disk full, or its own file edited underfoot — leaves a run that *completed successfully* with
nothing on stdout, and in the worst case **exit 0**, which looks like an empty answer rather than a
failure.

If you ran with `--log`, replay the same extraction: `$PI --extract run.jsonl` (add `-v` for the
model/token/cost line). Exit codes match a live run: `3` if the stream has no `agent_end`, `4` if it
finished but produced no text.

## Editing `pi-agent.sh`

Bash reads a script **incrementally from a file offset**, so replacing one while it runs makes the
running shell resume mid-token — it then dies, or silently hits EOF early and exits 0. The script
therefore wraps its whole body in `main()` and calls it on the last line: a function definition is
parsed as one unit *before* any of it executes, so the running copy cannot change underfoot. Keep
that shape. `shopt -s extglob` must stay at the top level above `main()`, because the whitespace-trim
uses an extglob pattern bash resolves at **parse** time.

## The kill-your-own-session incident

A live loop run opened with `pgrep -x pi | while read p; do kill -9 "$p"; done` as a "clean any stale
child" preamble and killed its own session mid-turn. The shell it ran in survived long enough to
launch the child, so the transcript simply stopped with no `agent_end` and the wrapper reported exit
`137` — a failure that looks like a model error and is not. Hence the rule in SKILL.md: check start
times, only ever kill a pid you can match to your own launch, and never kill `pi` processes *before*
starting a run.

## Not this wrapper

For an unattended, long-running, resumable, steerable agent loop, the pattern is a persistent
`pi --mode rpc` worker — in this repo that is `.claude/skills/pi-subagent-rpc` (development driver).
This wrapper is one-shot and bounded by design.
