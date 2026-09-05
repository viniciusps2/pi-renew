# pi-renew

**Renew a `pi` session instead of compacting it: hand the work over to a fresh context and keep
going, unattended, until the task list is actually finished.**

---

## Why this exists

Running a coding agent on a **local model with a small context window** is a different job from
running one on a hosted model with 200k tokens to spare. You hit the ceiling constantly, and what
happens at the ceiling decides whether the work gets done.

`pi`'s built-in auto-compaction is the default answer, and on a local model it has three problems:

- **It is slow.** Compaction is another full model call over the whole transcript, on the same
  hardware that is already the bottleneck.
- **It loses the things that matter.** A generic summarizer keeps the shape of the conversation and
  drops the specifics — the constraint you stated forty messages ago, the file that must not be
  touched, the convention the last three commits followed.
- **It stops.** Compaction finishes and the turn ends. Nobody continues the work. You come back
  hours later to an idle session that summarized itself and waited.

What I wanted instead was a **handover**: the agent, which knows what it is doing, writes down what
the next session needs — the goal, the decisions, the constraints, the next step — and then a fresh
session opens with exactly that and **carries on by itself**. No summarizer, no human in the loop,
no stopping until the work is genuinely done.

That is what `pi-renew` does. Two things:

| | |
|---|---|
| **The extension** | replaces a live session with a clean one and carries a payload across the boundary — a handover the agent wrote, and optionally a whole workflow to replay. It can fire on the agent's request, or on its own when the context fills up. |
| **`/renew-loop`** | a prompt template built on it: one turn of work per session, repeated — do the work, write the handover, restart clean — until a stop condition is met or the turn budget runs out. State lives in a file, so a run can be much longer than any one context window. |

---

## Install

```bash
pi install git:github.com/viniciusps2/pi-renew
```

One entry in `~/.pi/agent/settings.json`; the `pi` manifest in [`package.json`](package.json)
registers the extension, the `/renew-loop` prompt and the skills tree from it. Check with `/help` in
a `pi` session — `/renew-loop`, `/pi-renew` and two `skill:` entries (`subagent-brief`,
`subagent-review`) should be listed.

Then turn on the automatic high-context renewal, which is **off unless configured**, in
`~/.pi/agent/pi-renew.json`:

```json
{ "highContextReminder": { "enabled": true, "thresholdFraction": 0.85 } }
```

`thresholdFraction` is a fraction of the *model's own* context window, re-read on every evaluation,
so it follows a model switch with no config change. Keep it well clear of `1`: `pi` runs its own
compaction at `contextWindow - reserveTokens`, and a reminder that fires too late has no room left
to write a handover.

<details>
<summary>Other ways to install</summary>

```bash
pi install git:github.com/viniciusps2/pi-renew -l         # this project only (.pi/settings.json)
pi install git:github.com/viniciusps2/pi-renew@v1.0.0     # pin a ref
pi -e git:github.com/viniciusps2/pi-renew                 # one run, no install

git clone https://github.com/viniciusps2/pi-renew && pi install ./pi-renew   # from a checkout
```

Install the **repo root**, not `pi-extensions/pi-renew` — the inner directory is the extension
alone, without `/renew-loop` or the skills. A path install tracks your working tree, so edits are
live with no reinstall.

[`./install.mjs`](install.mjs) wraps `pi install` and adds nothing you cannot do by hand:
`--check` reports what is registered, `--remove` uninstalls, and `--migrate` cleans up the
pre-manifest symlink setup (a root install plus leftover symlinks registers everything twice).

Model aliases for `nextModel` are optional and go in the same config file:

```json
{ "models": [ { "id": "Q3.5-27B", "names": ["coding"] },
              { "id": "G4-31B",   "names": ["reviewer"] } ] }
```
</details>

---

## Four ways to use it

In increasing order of ambition. Each one adds exactly one thing to the one before it.

### 1. Let a full context renew itself

**Nothing to learn. Install, enable the reminder above, and work normally.**

When the session crosses the threshold, the extension injects a reminder into the conversation:
stop implementation work, write a complete handover to a markdown file of your own choosing, then
call `renew_from_handover` with that path. The agent does exactly that, and:

```
> …47 messages of work…
  ⚠ context usage too high (168,412 of 200,000)
  → agent writes handover-refactor.md
  → renew_from_handover { handoverPath: "handover-refactor.md" }
  ─────────────────────────  session replaced  ─────────────────────────
  [pi-renew restart #1 at 2026-09-05T18:04:11Z] reason: context usage too high
  → fresh session opens with the handover as its context, and continues
```

**Involved:** the extension only — no prompt template, no skills.
**What it does:** the reminder repeats every `repeatEveryTokens` tokens past the threshold until
the session is renewed or compacted.
`renew_from_handover` refuses if the file is missing or empty — the handover *is* the payload, so
there is no point restarting without one. On success it reads the file as the handover summary and
restarts with a real new session, recording the outgoing one as `parentSession`.

This is the safety net under everything below, and it works in any flow, with no configuration
beyond that one JSON line.

**In a session that cannot restart, the reminder asks for a report instead.** A one-shot run
(`pi -p`, `--mode json`) is torn down the moment the turn settles, so the restart could never land
— and a sub-agent's caller is waiting on an answer, not on a renewed child. There the extension
sends a different reminder: stop, and end the turn with a report saying what is done, what is
still missing, what to do next, and that the stop was caused by a full context window. Both
renewal tools are blocked in that session, so the sub-agent cannot be dragged into a restart
loop by the reminder it just received. The caller reads the report off the final answer and
spawns a fresh session to carry on.

One-shot modes are detected automatically. A worker driven over `--mode rpc` is long-lived and
looks like an ordinary session, so its launcher declares it explicitly:

```bash
PI_RENEW_REPORT_ONLY=1 pi --mode rpc …     # report, never restart
PI_RENEW_REPORT_ONLY=0 pi -p …             # opt back out; the mode no longer decides
```

### 2. Ask for a renewal

**One sentence, mid-session, whenever the context has served its purpose:**

```
> we're done exploring; clean the context and keep going with the migration
```

The agent calls `renew_session` with a reason, a structured summary and its next steps:

```json
{
  "name": "renew_session",
  "arguments": {
    "reason": "completed authentication analysis",
    "summary": "## Goal\n…\n## Key Decisions\n…\n## Critical Context\n…",
    "nextSteps": "implement unit tests for the auth module",
    "strategy": "new-session"
  }
}
```

The session is replaced, and the fresh one opens with that — not the 200 messages behind it.

**Involved:** the extension's `renew_session` tool.
**Pass `strategy: "new-session"` explicitly** — the current default is still `compact`, see
[`docs/STATUS.md`](docs/STATUS.md#open-decisions). `nextModel` optionally switches model first, so a
review phase can run on a different model than the coding phase.

**This is the piece you build your own workflow on.** A renewal is just a tool call, so it can be
the last line of any prompt or skill — a phase boundary that resets the context on its way out:

```markdown
---
name: explore-then-implement
---
Explore the codebase and produce a plan for <task>. Do not write code.

When the plan is complete, call `renew_session` with the plan as `summary`,
`nextSteps: "implement the plan"` and `strategy: "new-session"` — the
implementation runs in the fresh session, on the plan alone.
```

And to make a workflow survive *every* restart, register it once with `set_renewal_context`; the
extension replays it verbatim into every session it restarts into:

```json
{ "name": "set_renewal_context", "arguments": { "context": "/renew-loop implement tasks.md" } }
```

| Registered context | What each fresh session receives |
|---|---|
| `/renew-loop implement tasks.md` | the whole loop protocol, with your request inside it |
| `/skill:my-workflow arg` | the entire `SKILL.md` body, with `arg` appended |
| plain prose | the prose |

A leading slash command is resolved **at registration time**, so a context that could never expand
is rejected immediately rather than replayed as literal prose on every future restart. This is what
turns a restart from "keep going with less context" into "run this workflow again, in a clean
session, indefinitely" — which is exactly what the next two sections are.

### 3. Work through a list of tasks, unattended

**The first real loop.** Point it at a checklist and let it run:

```
$ cd <repo> && pi
> /renew-loop work through tasks.md, commit each unit
```

```
TURN n  (fresh context)
├─ read the handover — and only what it points at
├─ do ONE unit of work · run its check · tick the list · commit
├─ rewrite the handover: what happened, what's next, turn n of N
└─ stop, or RESTART into turn n+1
```

**Involved:** the `/renew-loop` prompt template, plus `set_renewal_context` and `renew_session` from
the extension. **No skills, no sub-agents, no spec tool** — this is the plain default.

**What it does, step by step.** Turn 1 registers `/renew-loop <your request, verbatim>` as the
renewal context, before reading anything, so a session lost before the first restart resumes by
replaying that string. Then every turn: resolve the task list and the handover, do one unit, check
it, tick it, commit it, rewrite the handover, and call `renew_session` with reason `renew-loop-turn`
and `strategy: "new-session"`. The fresh session receives the whole protocol again with your request
inside it, reads the restart ordinal off the provenance line to know which turn it is in, reads the
handover, and does the next unit. The conversation is thrown away every turn; the handover file is
the only thing that survives.

**Everything after `/renew-loop` is free text — there are no flags:**

| What you want | How you say it |
|---|---|
| What to work on | `implement tasks.md`, the directory holding it, or just the goal |
| When to stop | `until the e2e suite is green` — optional |
| How long to run | `max 20 turns` — optional, **the default budget is 10** |
| Check in between turns | `ask me between turns` |
| One turn only | `do one unit and stop` |
| No restarts at all | `do everything in this session, no context restart` |
| Resume later | `/renew-loop continue from .pi/renew-loop/<slug>/handover-<slug>.md` |

A run ends on the first of: your stop condition, an empty task list, a **hard stop** (a decision is
due, a commit failed, the same step failed twice), the **no-progress guard** (nothing changed this
turn), or the **turn budget**. Running out of budget is not a failure — the loop says so, names the
next step, and hands you the command to continue.

> **Start with `ask me between turns`** on your first run, until you have seen the no-progress guard
> fire once. It is the one guard with nothing behind it.

If the task list has no checkboxes, the loop adds `- [ ]` to each unit line in its own commit — the
exit test and the no-progress guard both need something to tick. Prose with no list at all is
transcribed into a checklist first.

### 4. Apply an OpenSpec change that is already written

**The full setup.** An [OpenSpec](https://github.com/Fission-AI/OpenSpec) change directory is
already the shape this loop consumes: a spec delta and a `tasks.md` written as checkboxes. Add
`apply with subagent review` and each unit gets briefed, executed cold, and reviewed:

```
> /renew-loop implement openspec/changes/add-auth/tasks.md, apply with subagent review,
      commit each unit, archive the change when the list is empty, max 20 turns
```

```
ANALYSE turn                                     EXECUTE turn (fresh context)
├─ pick ONE unit, size it (T0–T3)                ├─ read ONLY handover + brief
├─ write the brief · write reviewer notes        ├─ run the unit in the runner it found
├─ handover: Next = execute <unit>               ├─ THEN read reviewer notes, review the diff
└─ RESTART ─────────────────────────────────────▶├─ minor → fix here · major → re-brief
                                                 ├─ tick · commit · next turn
```

**Involved, and what each piece does:**

| Piece | What it does here |
|---|---|
| `/renew-loop` | the protocol: two turns per unit instead of one, both counted against the same budget |
| the extension | the restart between the two halves — which is the point: the analysing session's context is **thrown away before the unit is executed** |
| [`skills/subagent-brief`](skills/subagent-brief) | writes the brief a cold-start executor can carry out without rework — the preflight sweeps, the T0–T3 tier that sizes how much verification the unit earns, the decisions to settle up front, the nine-section structure, the improvement budget |
| [`skills/subagent-review`](skills/subagent-review) | writes the reviewer notes *before the diff exists*, then reviews against them: re-runs the gate, audits the diff for what a green suite cannot catch, triages what is merely worth improving |
| the runner | where the unit actually executes: the `subagent` tool from [`pi-subagents`](https://github.com/nicobailon/pi-subagents) if installed, else **this same session**, from the brief |
| OpenSpec | `openspec show`/`status` to read the change, `openspec validate --strict` to gate spec-touching units, and `openspec archive` to **apply the change** once the list is empty |

The executor works from the brief alone — which is the point, and also why the brief has to be
good. Reach for this mode when the work has acceptance criteria you want verified, when each unit
should land as its own reviewable commit, or when the run is unattended and nothing else will check
the result. It costs a restart and two turns per unit, which is why it is not the default.

**Turn it on by asking:** *"apply and review"*, *"apply with review"*, *"apply with subagent
review"*, *"brief and review each unit"*, *"delegate each unit"*.

---

## Works best with

Neither is required. The loop probes for whatever is reachable, picks it up with no configuration,
records what it found in the handover, and **says in its report when it fell back**. It never
installs anything and never stops because something is missing.

```bash
pi install npm:pi-subagents             # child agents: worker, reviewer, scout, oracle …
npm install -g @fission-ai/openspec     # spec-driven changes
```

| Lane | With the companion | Without it |
|---|---|---|
| running a unit | `subagent` → `worker`, then a `reviewer` pass | the unit runs **in this session**, from the brief |
| the task list | an OpenSpec `tasks.md`, used as it comes | any markdown checklist — the loop adds checkboxes if there are none |
| brief and review | `subagent-brief`, `subagent-review` | the loop writes both itself, to the outlines in the protocol |
| the restart | `pi-renew` | No-restart mode — the turns run in one session, still bounded by the budget |

---

## What is in the box

| Piece | What it is |
|---|---|
| [`pi-extensions/pi-renew`](pi-extensions/pi-renew) | **the extension** — three tools (`renew_session`, `renew_from_handover`, `set_renewal_context`) and the `/pi-renew` command. Knows nothing about loops |
| [`prompts/renew-loop.md`](prompts/renew-loop.md) | **the `/renew-loop` protocol** — work → hand over → restart, until a stop condition or the turn budget |
| [`skills/subagent-brief`](skills/subagent-brief) | brief-and-review only — writes the delegation brief |
| [`skills/subagent-review`](skills/subagent-review) | brief-and-review only — reviews what came back |

The first two rows are the whole default. The layering is the contract: `/renew-loop` calls the
pieces below it, and none of them knows anything about loops, turns or reasons — which is what lets
the same extension serve callers with nothing to do with this protocol.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/renew-loop.md`](docs/renew-loop.md) | **The loop, end to end** — setup, how to phrase a request, both restart triggers, the guards, troubleshooting, design notes |
| [`pi-extensions/pi-renew/README.md`](pi-extensions/pi-renew/README.md) | **The extension reference** — the three tools, `/pi-renew`, restart strategies, payload assembly, state persistence, failure reporting, high-context reminders, model switching |
| [`docs/STATUS.md`](docs/STATUS.md) | **What is actually proven** — the verification run, what is outstanding, the open decisions |
| [`skills/subagent-brief/VERIFICATION-MENU.md`](skills/subagent-brief/VERIFICATION-MENU.md) | Which check earns its cost on which change — the T0–T3 tiers, per language |
| [`skills/subagent-brief/IMPROVEMENT-BUDGET.md`](skills/subagent-brief/IMPROVEMENT-BUDGET.md) | What an agent may improve on its own authority (🟢), propose (🟡), escalate (🔴), or repair to unblock a unit (🔧) |
| [`.claude/skills/pi-driver-common/CONTRACT.md`](.claude/skills/pi-driver-common/CONTRACT.md) | The shared driver contract: *start · send · settled? · dead? · read* — development-only |

## Development

```bash
cd pi-extensions/pi-renew && npm install
npx vitest run          # unit suite
npx tsc --noEmit        # typecheck

cd ../../.claude/skills/pi-driver-common && node --test
```

Two of the extension's test files (`restart-e2e`, `renewal-state-live`) drive a **real** `pi`
process and need a live model endpoint, a trusted checkout, and no second copy of this extension
installed — see [`docs/STATUS.md`](docs/STATUS.md#verified-here).

`.claude/skills/` holds the development-only tooling — `pi-subagent` (a one-shot `pi` child),
`pi-subagent-rpc` (headless, structured events), `pi-subagent-tmux` (a real TUI in a tmux pane),
and `pi-driver-common`, the library the three share. They sit outside `skills/` deliberately, so
`pi` never loads them and `/renew-loop` can never reach them. None of them pins a model: given no
`--model` they pass none, and `pi` uses the default from its own settings.

## License

MIT
