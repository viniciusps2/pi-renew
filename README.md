# pi-renew

**Give a `pi` session a fresh context without losing the thread.**

`pi-renew` is an extension for the [`pi` coding agent](https://pi.dev) that restarts a live session —
replacing it with a clean one — and carries a caller-supplied payload across the boundary. The agent
can trigger it deliberately ("we're done exploring, clean the context and keep going"), or it can fire
on its own when the context window fills up. Either way the replacement session opens with provenance,
your summary, your next steps, and — if you registered one — a **delegate context** replayed verbatim,
which can be an entire workflow.

That last part is what makes long work possible. This repo ships one workflow built on it: **`/loop`**,
a prompt template that drives a task list to completion one unit at a time, restarting its own context
between *analysing* a unit and *executing* it, so the executing agent never inherits the analysing
agent's clutter.

| Piece | What it is | What it does |
|---|---|---|
| [`pi-extensions/pi-renew`](pi-extensions/pi-renew) | an extension | the restart primitive: three tools and the `/pi-renew` command. Knows nothing about loops |
| [`prompts/loop.md`](prompts/loop.md) | a prompt template | the `/loop` protocol: analyse → restart → execute → review → commit |
| [`skills/subagent-brief`](skills/subagent-brief) | a skill | writes the delegation brief a cold-start sub-agent can execute without rework |
| [`skills/subagent-review`](skills/subagent-review) | a skill | reviews what came back — re-runs the gate, audits the diff, triages improvements |
| [`skills/pi-subagent`](skills/pi-subagent) | a skill | runs `pi` as a one-shot child; `/loop`'s execute phase launches it every unit |
| [`skills/pi-driver-common`](skills/pi-driver-common) | a library | the shared driver discipline (model pinning, idle watchdog, exit codes, session folding). No `SKILL.md` — `pi` does not load it as a skill |

The layering is the contract: `/loop` calls the pieces below it, and none of them knows anything about
loops, phases or reasons. That ignorance is what lets the same extension and the same child runner
serve callers with nothing to do with this protocol.

---

## Install

**From GitHub — extension, skills and the `/loop` template, in one command:**

```bash
pi install git:github.com/viniciusps2/pi-renew
```

That writes one entry into `~/.pi/agent/settings.json`. Add `-l` to install project-locally
(`.pi/settings.json`) instead. To pin a ref: `pi install git:github.com/viniciusps2/pi-renew@v1.0.0`.
To try it for a single run without installing: `pi -e git:github.com/viniciusps2/pi-renew`.

**From a checkout** — do this if you intend to change anything, since `pi install` from a path tracks
your working tree:

```bash
git clone https://github.com/viniciusps2/pi-renew
pi install ./pi-renew
```

**Turn on the automatic high-context restart** (off unless configured), in
`~/.pi/agent/pi-renew.json`:

```json
{
  "highContextReminder": {
    "enabled": true,
    "thresholdFraction": 0.85,
    "repeatEveryTokens": 1000
  },
  "models": [
    { "id": "Q3.5-27B", "names": ["coding"] },
    { "id": "G4-31B", "names": ["reviewer"] }
  ]
}
```

`thresholdFraction` is a fraction of the *model's* context window, re-read on every evaluation, so it
follows a model switch with no config change. Keep it well clear of `1` — `pi` runs its own
compaction at `contextWindow - reserveTokens`, and a reminder that fires too late has no room left to
write a handover. `models` is optional and only powers `nextModel` aliases.

Developing on this repo instead of installing it — symlinks, project trust, and why the skills tree is
linked whole — is in [`docs/pi-loop.md`](docs/pi-loop.md#setup).

---

## Using `pi-renew`

Three ways it gets used, in increasing order of ambition.

### 1. Ask for a fresh session

The plain case. No configuration, no registration — just ask, in the middle of a session:

```
> we're done exploring; clean the context and keep going with the migration
```

The agent calls `delegate_to_agent` with a reason, a structured summary and its next steps. The
session is replaced, and the fresh one opens with exactly that — not the 200 messages of exploration
behind it.

```json
{
  "name": "delegate_to_agent",
  "arguments": {
    "reason": "completed authentication analysis",
    "summary": "## Goal\n…\n## Key Decisions\n…\n## Critical Context\n…",
    "nextSteps": "implement unit tests for the auth module",
    "strategy": "new-session"
  }
}
```

Pass `strategy: "new-session"` explicitly — see the note on the current default in
[`docs/STATUS.md`](docs/STATUS.md#open-decisions). `nextModel` optionally switches model before the
replacement starts, so a review phase can run on a different model than the coding phase.

### 2. Let a full context restart itself

With `highContextReminder.enabled`, crossing the threshold injects a reminder telling the agent to stop
work, write a complete handover to a markdown file **of its own choosing**, and call
`delegate_context_high` with that path:

```json
{ "name": "delegate_context_high", "arguments": { "handoverPath": ".pi/loop/handover.md" } }
```

The extension refuses if that file is missing or empty — the handover is the payload, so there is no
point restarting without it. On success it reads the file as the delegation summary and restarts with
`new-session`. This works in any flow, with no loop and no registration; it is the safety net under
everything else here.

### 3. Register a workflow the restart replays

The interesting one. Register a **delegate context** once, and every restart replays it verbatim into
the fresh session:

```json
{ "name": "set_delegate_context", "arguments": { "context": "/loop implement tasks.md" } }
```

| Registered context | What the fresh session receives |
|---|---|
| `/loop implement tasks.md` | the whole loop protocol, with your request inside it |
| `/skill:my-workflow arg` | the entire `SKILL.md` body, with `arg` appended |
| plain prose | the prose |

A leading slash command is resolved **at registration time**, not at delivery — a context that could
never expand is rejected immediately instead of being replayed as literal prose on every future
restart. This is what turns a restart from "keep going with less context" into "run this workflow
again, in a clean session, indefinitely."

The extension's full reference — all three tools, the `/pi-renew` command and its flags, both restart
strategies, how the payload is assembled and delivered as two messages, where the registered context
is persisted, and what happens when a restart fails — is in
[`pi-extensions/pi-renew/README.md`](pi-extensions/pi-renew/README.md).

---

## The `/loop` protocol

`/loop` is the workflow that registration makes possible. Point it at a task list; it works **one unit
at a time**:

```
TURN 1  (fresh session)                          TURN 2  (fresh context)
├─ register "/loop <your request>" verbatim      ├─ read ONLY handover + brief
├─ adopt this task list's handover, or create    ├─ launch the implementation child, wait
├─ exit test · no-progress guard                 ├─ THEN read reviewer notes, review the diff
├─ pick ONE unit, size it (T0–T3)                ├─ minor → fix here · major → re-brief
├─ write brief · reviewer notes · handover       ├─ blocked? → 🔧 repair, or stop
└─ RESTART ─────────────────────────────────────▶├─ tick the task list · commit
   (or earlier, if context crosses the           └─ stop · ask · or restart into the next unit
    high-context threshold)
```

Everything after `/loop` is free text — there are no flags. You say what you want and the protocol
maps it onto its parameters:

| What you want | How you say it |
|---|---|
| Where the work is listed | `implement openspec/changes/add-x/tasks.md`, or the directory holding it |
| Where state lives | `handover .pi/loop/handover.md` — optional; it finds or creates one otherwise |
| Keep going by itself | `continue automatically until all tasks are done` |
| Check in between units | `ask me before each next unit` |
| Don't restart at all | `do everything in this session, no context restart` |
| Bound an automatic run | `max 12 restarts` |
| A report at the end | `summarize the results` |

```
$ cd <repo> && pi
> /loop implement openspec/changes/add-x/tasks.md, handover .pi/loop/handover.md, review each unit, commit
```

Two independent checks run at the top of every analyse phase: the **exit test** (no open unit left →
stop, the intended ending) and the **no-progress guard** (the task list is unchanged since the last
cycle → stop and say so). The loop also stops rather than guessing whenever a decision is due, when a
unit escalates in review twice, when a child run fails, and when a commit or push fails.

Being blocked is not by itself a decision. A unit stopped by a defect it did not introduce is
repaired and the loop carries on — outside the unit's allowed files if that is where the defect
lives, as its own commit — so long as the repair changes no design the spec fixed. Where it would,
the loop stops and asks. The line is the design, never the file.

> **Start with `ask me before each next unit`** until you have seen the no-progress guard fire at
> least once. It is the one guard with nothing behind it.

Full documentation — setup, writing the request, worked examples, what happens under the hood,
troubleshooting, and the design rationale — is in [`docs/pi-loop.md`](docs/pi-loop.md).

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/pi-loop.md`](docs/pi-loop.md) | **The loop, end to end** — setup, quick start, how to phrase a request, the two restart triggers, automatic continuation and its guards, troubleshooting, design notes |
| [`pi-extensions/pi-renew/README.md`](pi-extensions/pi-renew/README.md) | **The extension reference** — the three tools, the `/pi-renew` command, restart strategies, payload assembly and the two send shapes, delegate-state persistence, failure reporting, high-context reminders, model switching |
| [`docs/STATUS.md`](docs/STATUS.md) | **What is actually proven** — the verification run, what is still outstanding, and the open decisions (including the `strategy` default and the runtime-version question) |
| [`docs/delegate-restart-streaming-throw.md`](docs/delegate-restart-streaming-throw.md) | **Research** — why a restart could fail silently with "Agent is already processing", the two defects that came out of it, and the evidence. A dated record, not current documentation |
| [`skills/subagent-brief/VERIFICATION-MENU.md`](skills/subagent-brief/VERIFICATION-MENU.md) | Which check earns its cost on which change — the T0–T3 tiers, and the command for each in TypeScript, Java, Python and shell |
| [`skills/subagent-brief/IMPROVEMENT-BUDGET.md`](skills/subagent-brief/IMPROVEMENT-BUDGET.md) | What an agent may improve on its own authority (🟢), what it must propose (🟡), what it must escalate (🔴), and what it may repair outside its allowed files to unblock a unit (🔧) |
| [`skills/pi-driver-common/CONTRACT.md`](skills/pi-driver-common/CONTRACT.md) | The shared driver contract: *start · send · settled? · dead? · read* |

---

## Development

```bash
cd pi-extensions/pi-renew
npm install
npx vitest run          # unit suite
npx tsc --noEmit        # typecheck

cd ../../skills/pi-driver-common && node --test
```

Two of the extension's test files (`restart-e2e`, `delegate-state-live`) drive a **real** `pi` process
and need a live model endpoint, a trusted checkout, and no second copy of this extension installed —
see [`docs/STATUS.md`](docs/STATUS.md#verified-here), which also records what is currently green.

`.claude/skills/` holds two development-only drivers — `pi-subagent-rpc` (headless, structured events)
and `pi-subagent-tmux` (a real TUI in a tmux pane) — for driving a long-lived `pi` from outside while
testing this tooling. They sit outside `skills/` deliberately, so `pi` never loads them and `/loop`
can never reach them.

## License

MIT
