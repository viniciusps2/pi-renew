---
name: pi-subagent
description: >-
  Scoped to `/renew-loop`: its opt-in **brief-and-review** mode runs a unit through this when no
  `subagent` tool (from `pi-subagents`) is installed, and the plain loop uses it only when the request
  asks for the work to be delegated. Load it only in those cases, or when the user names it outright
  ("use the pi-subagent skill", "/skill:pi-subagent") — never on your own initiative when someone asks
  to delegate, fan out or spawn an agent, which is what keeps it out of the way of the user's own
  delegation tooling. What it does: runs `pi` as a one-shot LLM sub-agent from the shell and returns
  just its final answer, for a self-contained task in a separate agent process.
---

# pi as a sub-agent

Drive `pi` non-interactively (`pi -p --mode json`) as a child agent and capture only its final
answer. `-p` runs one turn and **exits** — process exit is the stop signal. A bundled wrapper
handles invocation, extraction and error surfacing; treat it as a blocking call returning a string.

```bash
PI=<this skill's directory>/pi-agent.sh       # run a sub-agent
PIF=<this skill's directory>/pi-follow.sh     # watch one live
```

That directory is wherever the installed package lives: `skills/pi-subagent/` inside a checkout, or
under `~/.pi/agent/git/github.com/viniciusps2/pi-renew/skills/pi-subagent/` for a `git:` install.

Internals, recovery details and the reasoning behind the defaults: [README.md](README.md).

## Quickstart

```bash
# pure reasoning (no tools = fastest/safest)
$PI --no-tools "Summarize the trade-offs of WAL vs. rollback journals in one paragraph."

# tool-using sub-agent, scoped to a repo (read-only tools)
$PI --cwd /path/to/repo --tools read,grep,find,ls \
    "Which files import the deprecated `LegacyClient`? List paths only."

# structured output you can parse
$PI --no-tools 'Return {"risk":"low|med|high","reason":"..."} for: <text>. JSON only.' | jq .

# see cost/latency while iterating
$PI --no-tools -v "…"          # model / stopReason / tokens / duration → stderr
```

Only the sub-agent's final text goes to stdout; diagnostics to stderr; non-zero exit on failure.

## Options (`$PI --help`)

**No model is pinned.** Without `-m`/`--model` the wrapper passes no `--model` to `pi` at all,
so `pi` uses the default model from its own settings (`defaultProvider`/`defaultModel` in
`~/.pi/agent/settings.json`). `-m`/`--model` overrides that for one run. Thinking defaults to
**`low`**.

| Option | Purpose |
|---|---|
| `--no-tools` | Disable all tools — pure reasoning, fastest |
| `--tools <list>` | Allowlist built-in tools, e.g. `read,grep,find,ls` for a read-only agent |
| `-C, --cwd <dir>` | Working directory for the sub-agent (where its tools operate) |
| `--idle <s>` | Stop after N s of no output **while no tool is running** (default: computed, floor 60) — the primary stop control |
| `--tool-timeout <s>` | Cap on a single silent tool call (default `0` = unlimited); backstop for a hung tool |
| `-t, --timeout <s>` | Absolute wall-clock ceiling; `0` = disabled (default) |
| `--session <id>` | Persist to a named, resumable session (default: ephemeral) — for multi-turn |
| `--session-dir <dir>` | Where named sessions are stored (default: `~/.pi/agent/sessions`) |
| `--log <file>` | Keep the raw JSONL event stream so it survives the run |
| `--extract <file>` | Print the final answer from an existing event stream and exit (recovery) |
| `--thinking <lvl>` | `off…xhigh` — **default `low`** |
| `--system <text>` | Append to the system prompt (text or `@file`) |
| `--with-ext` | Keep the user's pi extensions loaded (incl. `pi-continue`) |
| `--keep-context` | Load `AGENTS.md`/`CLAUDE.md` from the cwd |
| `--report` | Require a structured report at the end of the answer (composes with `--system`) |
| `--raw` | Emit pi's raw JSONL event stream instead of just the answer |
| `-v, --verbose` | model / stopReason / tokens / duration → stderr |

Prompt input: positional `"..."`, `@file`, or `-` for stdin.

Exit codes: `0` ok · `2` usage · `3` no completion (server/model error) · `4` completed but empty ·
`124` ceiling exceeded.

**The watchdog is event-aware.** While a tool call is in flight it **suspends** the idle timer, so a
legitimately long *silent* tool (a 10-minute build) is never killed. `--idle` means "how long the
**model** may sit silent **between** tool calls". A tool that hangs forever is caught by
`--tool-timeout`; `-t` is an optional absolute ceiling. The default idle is **computed from the
prompt size and whether tools/extensions are loaded**, floor 60s — an explicit `--idle N` always
wins, including `--idle 0` to disable it.

## Running one from a harness with a command timeout

Claude Code's Bash tool caps a foreground command at **10 minutes**; a full-task delegation routinely
runs longer, and the ceiling kills the wrapper leaving a partial tree and no answer. Launch detached
and poll:

```bash
nohup $PI --report --log $SC/run.jsonl --cwd "$REPO" -t 5400 --idle 180 @$SC/brief.md \
      > $SC/report.md 2> $SC/run.err &
```

**Poll roughly every 15 seconds**, not in multi-minute sleeps — a long sleep overshoots the finish by
minutes and hides a run that died early.

```bash
for i in $(seq 1 40); do
  sleep 15
  pgrep -f "run.jsonl" >/dev/null || { echo "DONE $(date +%T)"; break; }
  echo "$(date +%T) alive log=$(stat -c%s $SC/run.jsonl) tree=$(git status --short | wc -l)"
done
```

Read the run's *shape*, not its clock: **transcript bytes growing with an empty working tree is the
normal opening phase** (it is reading); files landing then churning is the gate loop. A frozen byte
count is the only real hang signal.

### If you must kill the child

The sub-agent runs in its own process group and **outlives the wrapper**.
`pkill -f "<your log name>"` does not reach it — that pattern matches the *wrapper*; the child
appears in `ps` as a bare `pi` with no arguments. Use `pgrep -x pi`, check the start time against
your launch (`ps -o pid=,lstart=,cmd= -p <pid>`), and kill that pid.

> **Never kill a pid you did not start.** `pgrep -x pi` matches *every* `pi` on the machine —
> including the session you are running inside. Piping it into `kill` is a self-destruct, not a
> tidy-up: a live loop run did exactly that as a "clean any stale child" preamble and killed its own
> session mid-turn. The start-time check is not optional, and there is no case in which killing `pi`
> processes *before* starting a run is correct.

This matters beyond tidiness: **an orphaned `pi` pins the model it loaded**, so the next run can hang
before its first token and die `stopReason=error` with no useful message. A hang right after changing
the model pin is this until proven otherwise — `pgrep -x pi` to *check*, not to kill.

Recover a finished answer with `$PI --extract $SC/run.jsonl`. Exit `3` there means it genuinely never
reached `agent_end`: **discard the partial tree** (`git checkout -- <files>`, delete new ones) and
re-run from clean rather than resuming it.

## Following a run live

`pi-agent` prints its JSONL event-stream path to stderr *before* the sub-agent starts. Point
`pi-follow.sh` at it from another terminal for token-by-token text, one line per tool call, and a
token/cost meter. Ctrl-C stops watching; the sub-agent keeps running.

```bash
$PIF /var/folders/.../pi-agent.AbC123.jsonl       # the path pi-agent printed
$PI --log run.jsonl --session my-task --session-dir ./.pi-runs --report --cwd "$REPO" @brief.md
$PIF run.jsonl                                    # live, with token deltas
$PIF --session my-task --session-dir ./.pi-runs   # same run, message-granular, resumable by pi
$PIF -n --thinking run.jsonl                      # after the fact, reasoning included
```

Default runs are ephemeral and their event stream is a temp file **deleted on exit** — followable
during the run, gone afterwards. Name `--log` and `--session` for anything you may want later.
Useful flags: `--wait` (default 60s, tolerates attaching before the file exists), `-n/--no-follow`,
`--thinking`, `--full`, `--no-color`.

## Delegating effectively (full-task mode)

The pinned model is a capable, sonnet-level coding agent. Prefer **full-task delegation** (goal +
acceptance criteria + constraints) over mechanical line-by-line edits — it can design, implement, run
tests and iterate to green. Give it `bash` + edit/read tools and a generous `-t`.

> For a substantial task use **`subagent-brief`** instead of the sketch below — it carries the
> preflight sweeps, the decisions to fix up front, the nine-section template and the report contract.
> This skill is *how to run one*; that one is *what to say*. **`subagent-review`** is the other half:
> the caller re-runs the gates and reviews the diff before committing, because the sub-agent's report
> is evidence, not proof.

A good prompt has five parts: **Context** · **Approach/design** · **Acceptance criteria** (explicit,
testable) · **Constraints** (files not to touch, no git, scope guardrails) · **Report-back** (use
`--report`).

```
## Task
<one-line summary of what to do>

## Context
- <relevant background: repo structure, key files, existing conventions>
- <any prior decisions or constraints from the broader plan>

## Approach
<steps or design the sub-agent should follow>

## Acceptance
- [ ] <criterion 1: testable condition>
- [ ] <criterion N>

## Constraints
- Do NOT modify: <files or directories to leave alone>
- Do NOT run git commands unless explicitly asked
- <any other scope guardrails>

## Report-back
Use the four-section report (Files changed / Commands run / Acceptance / Findings & gaps).
```

## Patterns

```bash
# Full-task implement & verify — hand a spec, let it design + code + test
$PI --report --log run.jsonl --cwd "$REPO" @brief.md
$PIF run.jsonl                     # in another terminal: watch it work
# then: review the diff, re-run your gates, commit

# Chore: commit & push
$PI --tools bash --cwd "$REPO" \
    "Stage <files>, commit with message '<msg>' plus this repo's standard commit trailers, then push. Report the commit hash and push result."

# Parallel fan-out — independent subtasks at once
$PI --no-tools "Draft a commit message for: <diff A>" > /tmp/a.txt &
$PI --no-tools "Draft a commit message for: <diff B>" > /tmp/b.txt &
wait

# Read-only code investigator — safe on a real repo
$PI --cwd "$REPO" --tools read,grep,find,ls -t 240 \
    "Trace how a request reaches the DB layer. Output: entrypoint file, 3-5 hop call chain, DB module."
```

**Structured extraction** — instruct "JSON only", then `jq`; the wrapper already exits non-zero on
empty/garbled output, so branch on `$?`. **Multi-turn** — reuse `--session <id>` across calls.
Small chores (running a gate, staging + committing) delegate well too.

## Caveats

- **Latency varies; hangs auto-stop, real work doesn't.** A cold remote model can take tens of
  seconds. The watchdog stops a stuck run but suspends while a tool runs, so you never have to guess
  a wall-clock timeout. Use `--tool-timeout` only to bound a tool you fear may hang forever.
- **One-shot, bounded.** For an unattended, resumable, steerable agent loop use a persistent
  `pi --mode rpc` worker (`.claude/skills/pi-subagent-rpc` in this repo), not this wrapper.
- **Tool trust.** Write/bash sub-agents act for real in their `--cwd`. Scope with `--cwd` and a
  minimal `--tools` allowlist; `--allow` only when it must trust project-local config/extensions.
- **Don't nest deeply.** Keep depth shallow and prompts self-contained — each call is a cold start
  with no memory of this conversation.
