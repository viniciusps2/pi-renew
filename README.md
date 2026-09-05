# pi-renew

**Give a `pi` session a fresh context without losing the thread.**

`pi-renew` is an extension for the [`pi` coding agent](https://pi.dev) that restarts a live session —
replacing it with a clean one — and carries a caller-supplied payload across the boundary. The agent
can trigger it deliberately ("we're done exploring, clean the context and keep going"), or it can fire
on its own when the context window fills up. Either way the replacement session opens with provenance,
your summary, your next steps, and — if you registered one — a **delegate context** replayed verbatim,
which can be an entire workflow.

That last part is what makes long work possible. This repo ships one workflow built on it:
**`/renew-loop`**, a prompt template that repeats a turn of work — do it, hand over, restart with a
clean context — until a stop condition is met or the turn budget runs out. Its state lives in a file
instead of a context window, so a run can be longer than any one session.

| Piece | What it is | What it does |
|---|---|---|
| [`pi-extensions/pi-renew`](pi-extensions/pi-renew) | an extension | the restart primitive: three tools and the `/pi-renew` command. Knows nothing about loops |
| [`prompts/renew-loop.md`](prompts/renew-loop.md) | a prompt template | the `/renew-loop` protocol: work → hand over → restart, until a stop condition or the turn budget |
| [`skills/subagent-brief`](skills/subagent-brief) | a skill | **brief-and-review only** — writes the delegation brief a cold-start executor can carry out without rework |
| [`skills/subagent-review`](skills/subagent-review) | a skill | **brief-and-review only** — reviews what came back: re-runs the gate, audits the diff, triages improvements |
| [`skills/pi-subagent`](skills/pi-subagent) | a skill | runs `pi` as a one-shot child — the runner brief-and-review falls back to when no `subagent` tool is installed |
| [`skills/pi-driver-common`](skills/pi-driver-common) | a library | the shared driver discipline (model pinning, idle watchdog, exit codes, session folding). No `SKILL.md` — `pi` does not load it as a skill |

The first two rows are the whole default. The three skills belong to **brief-and-review**, an opt-in
mode you turn on by asking for it; the plain loop never loads them.

The layering is the contract: `/renew-loop` calls the pieces below it, and none of them knows anything
about loops, turns or reasons. That ignorance is what lets the same extension and the same child runner
serve callers with nothing to do with this protocol. In the other direction the loop asks nothing of its
environment: [what it uses when it is there](#works-best-with) is optional, every piece of it.

---

## Install

One command, no symlinks:

```bash
pi install git:github.com/viniciusps2/pi-renew
```

That writes a single entry into `~/.pi/agent/settings.json`, and the `pi` manifest in
[`package.json`](package.json) registers all three resource kinds from it:

| Manifest field | What it registers |
|---|---|
| `extensions` | the restart tools and the `/pi-renew` command |
| `prompts` | `/renew-loop` |
| `skills` | `subagent-brief`, `subagent-review`, `pi-subagent` — as one tree, so their relative references keep resolving |

Nothing needs linking into `~/.pi/agent/prompts/` or `~/.pi/agent/skills/` by hand. Confirm with
`/help` in a `pi` session: `/renew-loop`, `/pi-renew` and the three `skill:` entries should all be
there.

Add `-l` to install project-locally (`.pi/settings.json`) instead. To pin a ref:
`pi install git:github.com/viniciusps2/pi-renew@v1.0.0`. To try it for a single run without
installing: `pi -e git:github.com/viniciusps2/pi-renew`.

**From a checkout** — do this if you intend to change anything, since `pi install` from a path tracks
your working tree. Install the **repo root**, not `pi-extensions/pi-renew`: the inner directory is
only the extension, and installing it gets you the tools without `/renew-loop` or the skills.

```bash
git clone https://github.com/viniciusps2/pi-renew
pi install ./pi-renew
```

**Or use the wrapper**, [`install.mjs`](install.mjs), which picks the source for you, reports what is
registered, and cleans up an older setup. Run it from a checkout:

```bash
./install.mjs            # install (this checkout, since it is one)
./install.mjs --check    # report what is registered, change nothing
./install.mjs --migrate  # install, then remove the pre-manifest symlink setup
./install.mjs --remove   # uninstall
```

The wrapper only wraps `pi install`/`pi remove` — there is nothing it does that you cannot do by hand.

**Upgrading from the manual setup.** Earlier versions of these docs had you install
`pi-extensions/pi-renew` and then symlink `prompts/loop.md` and `skills/` into `~/.pi/agent/` — back
when the prompt was `loop.md` and the command `/loop`; both are now `renew-loop`. That still works, but
combined with a root install it registers everything twice — and a duplicate extension breaks this
repo's own live tests. `./install.mjs --check` lists any leftovers;
`./install.mjs --migrate` removes them. By hand:

```bash
pi remove <path>/pi-extensions/pi-renew
rm ~/.pi/agent/prompts/loop.md ~/.pi/agent/skills/dev   # only if they are symlinks you made
pi install <path>
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

Project trust — which `/renew-loop` does not need, but this repo's own live tests do — is covered in
[`docs/renew-loop.md`](docs/renew-loop.md#setup).

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
{ "name": "delegate_context_high", "arguments": { "handoverPath": ".pi/renew-loop/add-auth/handover-add-auth.md" } }
```

The extension refuses if that file is missing or empty — the handover is the payload, so there is no
point restarting without it. On success it reads the file as the delegation summary and restarts with
`new-session`. This works in any flow, with no loop and no registration; it is the safety net under
everything else here.

### 3. Register a workflow the restart replays

The interesting one. Register a **delegate context** once, and every restart replays it verbatim into
the fresh session:

```json
{ "name": "set_delegate_context", "arguments": { "context": "/renew-loop implement tasks.md" } }
```

| Registered context | What the fresh session receives |
|---|---|
| `/renew-loop implement tasks.md` | the whole loop protocol, with your request inside it |
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

## The `/renew-loop` protocol

`/renew-loop` is the workflow that registration makes possible: **one turn per session**, repeated
until something says stop.

```
TURN n  (fresh context)
├─ read the handover — and only what it points at
├─ do ONE turn's work · run its check · tick the list · commit
├─ rewrite the handover: what happened, what's next, turn n of N
└─ stop, or RESTART into turn n+1
     stop when: the stop condition is met · the list is empty · a decision is due
                · nothing changed this turn · the turn budget is spent (default 10)
```

That is the whole default. No sub-agents, no skills, no spec tool, no phases — just a bounded loop
whose state lives in a file instead of in a context window. Everything after `/renew-loop` is free
text; there are no flags:

| What you want | How you say it |
|---|---|
| What to work on | `implement openspec/changes/add-x/tasks.md`, or the directory holding it, or just the goal |
| When to stop | `until the e2e suite is green` — optional; an empty task list and the budget also end a run |
| How long to run | `max 20 turns` — optional; **the default budget is 10** |
| Where state lives | `handover <path>` — optional; otherwise it finds this work's own, or creates `.pi/renew-loop/<slug>/handover-<slug>.md` |
| Check in between turns | `ask me between turns` |
| One turn only | `do one unit and stop` |
| Don't restart at all | `do everything in this session, no context restart` |
| Apply the change at the end | `archive the change when the list is empty` (OpenSpec) |
| A report at the end | `summarize the results` |

```
$ cd <repo> && pi
> /renew-loop work through openspec/changes/add-x/tasks.md, commit each unit, max 20 turns
```

A run ends on the first of: the stop condition, an empty task list, a **hard stop** (a decision is
due, a commit failed, the same step failed twice), the **no-progress guard** (nothing changed this
turn), or the **turn budget**. Running out of budget is not a failure — the loop says so, names the
next step, and hands you `/renew-loop continue from <handover>`.

Being blocked is not by itself a decision. A turn stopped by a defect it did not introduce is
repaired and the loop carries on — as its own commit, once the defect is proven pre-existing — so
long as the shortest correct repair changes no design. Where it would, the loop stops and asks. The
line is the design, never the file.

### Opt-in: brief-and-review

Ask for it — *"apply and review"*, *"apply with review"*, *"apply with subagent review"*, *"brief and
review each unit"*, *"delegate each unit"* — and a unit takes **two** turns instead of one:

```
ANALYSE turn                                     EXECUTE turn (fresh context)
├─ pick ONE unit, size it (T0–T3)                ├─ read ONLY handover + brief
├─ write the brief · write reviewer notes        ├─ run the unit in the runner it found
├─ handover: Next = execute <unit>               ├─ THEN read reviewer notes, review the diff
└─ RESTART ─────────────────────────────────────▶├─ minor → fix here · major → re-brief
                                                 ├─ blocked? → 🔧 repair, or stop
                                                 └─ tick · commit · next turn
```

The analysing session's context is thrown away before the unit is executed, so the executor works
from the brief alone — which is the point, and also why the brief has to be good. Reach for it when
the work has acceptance criteria you want verified, when each unit should land as its own reviewable
commit, or when the run is unattended and nothing else will check the result. It costs a restart and
two turns per unit, which is why it is not the default.

**It looks for a runner first**, and says which it found: the `subagent` tool from
[`pi-subagents`](#works-best-with), else this repo's `pi-subagent` skill, else **this same session** —
the mode still writes the brief and the reviewer notes and still splits the turn; what it loses
without a child runner is the executor's context isolation, not the review.

> **Start with `ask me between turns`** until you have seen the no-progress guard fire at least once.
> It is the one guard with nothing behind it.

Full documentation — setup, writing the request, worked examples, what happens under the hood,
troubleshooting, and the design rationale — is in [`docs/renew-loop.md`](docs/renew-loop.md).

---

## Works best with

Two third-party tools make `/renew-loop` markedly better, and neither is required. Install them for
your whole environment or just for one project — the loop probes for whatever is reachable from the
session it is running in, and picks it up with no configuration of its own:

```bash
# environment-wide
pi install npm:pi-subagents             # https://github.com/nicobailon/pi-subagents
npm install -g @fission-ai/openspec     # https://github.com/Fission-AI/OpenSpec

# or per project, from the project root
pi install npm:pi-subagents -l          # writes .pi/settings.json
npm install -D @fission-ai/openspec && npx openspec init
```

- **[`pi-subagents`](https://github.com/nicobailon/pi-subagents)** — child agents (`worker`, `reviewer`,
  `scout`, `oracle`, …) behind a `subagent` tool. This is the runner **brief-and-review** looks for
  first: each unit runs as a real child session, with a `reviewer` available for a second opinion on
  the diff. The plain loop uses it only when you ask for the work to be delegated.
- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** — spec-driven changes: one
  `openspec/changes/<change>/` directory with a spec delta and a `tasks.md` already written as
  checkboxes, which is exactly the shape this loop consumes. The loop reads the change through
  `openspec show`/`status`, gates spec-touching units with `openspec validate --strict`, and — when your
  request asks for it — **applies the change** with `openspec archive` once the list is empty.

**Without them, the loop still runs, and it says so.** Every dependency is a lane with a floor
underneath it:

| Lane | With the companion | Without it |
|---|---|---|
| running a unit (brief-and-review) | `subagent` → `worker`, then a `reviewer` pass | this repo's `pi-subagent` skill; and with no child runner at all, the unit runs **in this session**, from the brief |
| the task list | an OpenSpec `tasks.md`, used as it comes | any markdown checklist — and if the file has units but no checkboxes, the loop **adds `- [ ]` to each unit line** in its own commit, because the exit test and the no-progress guard both need something to tick. Prose with no list at all is transcribed into `.pi/renew-loop/<slug>/tasks-<slug>.md`, one box per step the document names |
| brief and review | `subagent-brief`, `subagent-review` | the loop writes the brief and the reviewer notes itself, to the outlines in the protocol |
| the restart | `pi-renew` | no-restart mode — the turns run in one session, still bounded by the budget |

What it found is recorded in the handover (`Runner:`, and a note for the rest) and named in the turn's
report, so a run that fell back is visible rather than mysterious. The loop never installs anything,
and never stops because something is missing.

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/renew-loop.md`](docs/renew-loop.md) | **The loop, end to end** — setup, quick start, how to phrase a request, the two restart triggers, automatic continuation and its guards, troubleshooting, design notes |
| [`pi-extensions/pi-renew/README.md`](pi-extensions/pi-renew/README.md) | **The extension reference** — the three tools, the `/pi-renew` command, restart strategies, payload assembly and the two send shapes, delegate-state persistence, failure reporting, high-context reminders, model switching |
| [`docs/STATUS.md`](docs/STATUS.md) | **What is actually proven** — the verification run, what is still outstanding, and the open decisions (including the `strategy` default and the runtime-version question) |
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
testing this tooling. They sit outside `skills/` deliberately, so `pi` never loads them and
`/renew-loop` can never reach them.

## License

MIT
