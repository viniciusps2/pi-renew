# The `/renew-loop` protocol

> **Status: implemented, not yet exercised end to end.** The mechanisms this document describes are
> shipped — both the `pi-renew` extension and the `/renew-loop` prompt template
> (`prompts/renew-loop.md`) exist in this repo today, with the extension's unit suite green and its
> two live restart tests passing against a real `pi`. What is still outstanding is a **live,
> end-to-end run**: a no-restart run, a bounded run that ends on its budget, and a run in
> brief-and-review mode. So this document describes shipped behaviour that has not yet been exercised
> in a full live loop. [`STATUS.md`](STATUS.md) records exactly what was verified, how, and what is
> left.

A bounded work loop for the `pi` CLI. Each **turn** is its own session: it reads a handover file, does
one piece of work, records what happened, and restarts with a clean context. The run ends when a stop
condition is met, when there is nothing left to do, or when the turn budget runs out — **10 turns**
unless you say otherwise.

The default is deliberately plain, and needs nothing but the extension. One opt-in mode,
**[brief-and-review](#opt-in-brief-and-review)**, splits a unit across two turns so the executing
session works from a written brief instead of the analysing session's context; you turn it on by
asking for it.

It is built from pieces that are layered, not peers: `/renew-loop` calls the ones below it, and none
of them knows anything about loops, turns or reasons. That ignorance is the contract: it is what lets
the same extension and the same child runner serve callers that have nothing to do with this protocol.

| Piece | What it is | What it does |
|---|---|---|
| `/renew-loop` | a prompt template | the protocol: work → hand over → restart, until a stop condition or the budget |
| `pi-renew` | an extension | a generic context-restart primitive; knows nothing about loops |
| `subagent-brief`, `subagent-review` | skills | **brief-and-review only** — the brief the executor works from, and the notes the diff is reviewed against |
| `pi-subagent`, `pi-subagent-rpc`, `pi-subagent-tmux` | skills, under `.claude/skills/` | drive a `pi` process from outside — for developing and testing this repo only, deliberately kept out of the `skills/` tree `pi` loads |
| `pi-subagents`, OpenSpec | third-party, optional | better lanes for the same jobs — see [Optional companions](#optional-companions) |

---

## Setup

If you only want to *use* `/renew-loop`, one command is the whole setup — see
[Install](../README.md#install). Nothing below is required for that.

```bash
pi install git:github.com/viniciusps2/pi-renew
```

The rest of this section is for developing **on** this repo, where you want the installed copy to be
your working tree. Assume you have cloned it and are standing in its root, so `$PWD` is that checkout.

```bash
# 0. Be in the checkout:   cd <this-repo>          # so $PWD is the repo root

# 1. Install the REPO ROOT — not pi-extensions/pi-renew. The root carries the `pi` manifest, so this
#    one entry registers the extension, the /renew-loop prompt and the whole skills/ tree together. A path
#    install tracks your working tree, so edits are live with no reinstall:
pi install "$PWD"
#    …which writes the entry into ~/.pi/agent/settings.json:
#    "packages": [ …, "<path to this checkout>" ]

# 2. (Once per machine) Turn on the automatic high-context renewal; add model aliases if you like:
#    cat ~/.pi/agent/pi-renew.json
#    { "highContextReminder": { "enabled": true, "thresholdFraction": 0.85 } }

# 3. Trust this checkout. /renew-loop itself does not need it, but this repo's own live tests do — they
#    load the extension by an explicit -e path inside the checkout, and an untrusted project's
#    resources are ignored silently. Run /trust once inside an interactive pi session here, or add
#    the path to ~/.pi/agent/trust.json.
```

**No symlinking into `~/.pi/agent/`.** An earlier version of this section had you install the inner
`pi-extensions/pi-renew` directory and then link `prompts/loop.md` and `skills/` into `~/.pi/agent/`
(back when the prompt was `loop.md` and the command was `/loop`) by hand. The manifest install replaces all of it. If you still have that setup, the two registrations
stack — and a duplicate extension is exactly what the live tests refuse to run against. From a checkout, run
`./install.mjs --check` to list the leftovers and `./install.mjs --migrate` to remove them.

The manifest points `skills` at the **whole tree**, not at individual skills, and that matters: the
skills are siblings of one another — `subagent-review` reads `../subagent-brief/…`. Registering skills
one by one would break those relative references. The development drivers are deliberately *not* in
this tree — they live under `.claude/skills/`, so `pi` never loads them.

`/renew-loop` installs globally, so it works in every repo with no trust gate — while the file itself stays
version-controlled in this repo. One loop serves every project; a project needing a different protocol adds
its own template under a **different name** rather than overriding `loop`.

> **Why trust still matters.** Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never prompt for
> trust and silently ignore project-local resources without it. That no longer affects `/renew-loop`, but it does
> affect any `.pi/skills/` or `.pi/settings.json` a flow depends on — and an unresolved slash command is
> delivered to the model as literal text rather than failing, so the failure is quiet.

---

## Quick start

```
$ cd <repo> && pi
> /renew-loop work through openspec/changes/add-x/tasks.md, commit each unit
```

The loop takes one unit, checks it, ticks it, commits, writes the handover and restarts into the next
one — up to **10 turns**, the default budget. When it stops it tells you why, and how to carry on:

```
> /renew-loop continue from .pi/renew-loop/add-x/handover-add-x.md
```

Neither line names a handover, and the first does not have to: the loop finds the one this change
already has — adopting its progress, its pending decisions and its notes — and creates one only if
there is none. It tells you which path it used. See
[Where the handover lives](#where-the-handover-lives).

A run does not need a task list at all. A goal and a stop condition are enough, and the handover holds
the plan:

```
> /renew-loop get the e2e suite green, one failure per turn, stop when it passes, max 15 turns
```

---

## Writing the request

Everything after `/renew-loop` is free text, interpolated into the protocol. There are no flags — you say what you
want, and the protocol translates it into its parameters.

| What you want | How you say it |
|---|---|
| What to work on | `implement openspec/changes/add-x/tasks.md` — the change or plan directory holding it, or just the goal in words |
| When to stop | `until the e2e suite is green`, `stop when the migration runs clean` — **optional** |
| How long to run | `max 20 turns` — **optional**; the default budget is **10** |
| Where state lives | `handover .pi/renew-loop/add-auth/handover-add-auth.md` — **optional**; say nothing and the loop finds or creates one |
| Check in between turns | `ask me between turns` |
| One turn only | `do one unit and stop` |
| Don't restart at all | `do everything in this session, no context restart` |
| Brief and review each unit | `apply and review`, `apply with review`, `apply with subagent review` — see [brief-and-review](#opt-in-brief-and-review) |
| Apply the change at the end | `archive the change when the list is empty` (OpenSpec) |
| Get a report at the end | `summarize the results` |

The final report is **opt-in**: say nothing about one and the loop ends with a short completion
statement instead. Its own last reply is the report — there is no separate file to go and read.

**A run needs at least one way to end**, and it always has one: the budget. A stop condition and a
task list that can empty are the two you can add, and a run with neither is bounded by the budget
alone — which the loop says in its first report line, so you are never surprised by where it stopped.

Hard stops are not something you request — the protocol always stops rather than continuing when a
decision is due, when the same step fails twice, or when a commit or push fails. There is no phrase
that turns that off; only the budget above is something you actively set.

Being **blocked** is not automatically one of them. A turn stopped by a defect it did not introduce —
a broken build, a duplicate registration, a fixture an earlier unit left wrong — gets repaired and the
loop carries on, even when the repair lives outside the work at hand, provided the shortest correct
repair changes no design. Where it would, that is a decision and the loop stops for it.

### Where the handover lives

The handover is the run: it holds the work, the slug, the mode, the turn count, the stop condition,
what the last turn did, what is still open, and the one thing the next turn does first. Everything else
about a turn is thrown away by the restart.

Naming one is optional. Point the loop at a task list and say nothing about state, and it looks for the
handover that task list already has before making a new one — so a second `/renew-loop` at the same openspec
change picks up the progress baseline, the pending decisions and the notes the first one left, instead
of starting a parallel history beside it.

**Every path it creates carries the work's name.** The handover for
`openspec/changes/add-auth/tasks.md` is `.pi/renew-loop/add-auth/handover-add-auth.md`; in
brief-and-review mode the current unit's brief and notes sit beside it:

```
.pi/renew-loop/add-auth/
├── handover-add-auth.md      # what just happened, and where the loop is
├── brief-3-2.md              # unit 3.2's brief          (brief-and-review only)
└── review-3-2.md             # unit 3.2's reviewer notes (brief-and-review only)
```

The slug is the task list's own directory where that names the work (`openspec/changes/add-auth/tasks.md`
→ `add-auth`), otherwise the file's stem (`docs/add-auth-plan.md` → `add-auth-plan`); a directory that
names no work — `tasks/`, `docs/`, `specs/`, the repo root — falls through to the stem. With no document
at all it comes from the goal (`get the e2e suite green` → `e2e-suite-green`), fixed on turn 1 and read
back from the handover afterwards rather than re-derived. If that path is already taken by a handover
for *different* work, the slug grows leftwards (`add-auth` → `changes-add-auth`) until it is free.

This is not cosmetic. A plain `.pi/loop/handover.md` is the same path for every change in the repo, so
the next run over different work finds a handover that validates on nothing, and either adopts a
stranger's state or writes over it — silently, since both are called "the handover". Carrying the work's
name in the path makes that collision impossible to have.

It searches the canonical path first, then `<task-list-dir>/handover-<slug>.md`, then the pre-rename
locations (`.pi/loop/<slug>/handover.md`, `.pi/loop/handover.md`, `<task-list-dir>/handover.md`), and
takes the candidate whose own `Work:` line names **this** task list or goal. A handover belonging to a
different run is skipped, never merged. Two live candidates for the same list is an ambiguity it will not guess at:
it stops and asks which. A handover found at one of the old paths is adopted and then **moved** to the
canonical one, with its brief and notes. Nothing found → it creates the canonical path. Either way it
tells you the path it resolved and whether it adopted, created or moved it, in its first report line.

The search is deliberately the same every turn, because a restart replays your request verbatim — a
discovery that could land somewhere else would hand the fresh session a different handover than the one
the previous turn just wrote.

Naming a path explicitly always wins and skips the search, which is what `/renew-loop continue from
.pi/renew-loop/add-auth/handover-add-auth.md` does.

### When the task list has no checkboxes

The exit test and the no-progress guard both read the task list, so the loop needs something in that
file it can tick. On the first turn of a run it checks, once:

- **already tickable** — `- [ ]` boxes, or whatever "done" is in that file's own format — it uses what is
  there and reformats nothing;
- **a list with no markers** — numbered or bulleted lines that each name a piece of work — it adds `- [ ]`
  to each unit line, changing nothing else, in its own commit before the first unit;
- **prose, not a list** — it transcribes the steps *the document itself names* into
  `.pi/renew-loop/<slug>/tasks-<slug>.md`, one `- [ ]` each, in the document's order, and works from that
  instead. A step the document does not name does not go in; a document that names no steps is not a
  task list at all — the loop works from the goal and keeps the plan in the handover.

So an OpenSpec `tasks.md` is used exactly as it comes, and a hand-written plan becomes trackable without
you having to prepare it first.

### Examples

**Work a task list to the end, with the default budget of 10 turns.**

```
/renew-loop work through openspec/changes/add-auth/tasks.md, commit each unit
```

**A goal, a stop condition, and a bigger budget.** No task list; the handover carries the plan.

```
/renew-loop get the e2e suite green, one failure per turn,
      stop when `npm run e2e` passes, max 15 turns
```

**One turn, then stop.** The cheapest way to see what a turn looks like.

```
/renew-loop do the first open unit in tasks.md and stop
```

**Checking in between turns.**

```
/renew-loop work through openspec/changes/add-auth/tasks.md,
      ask me between turns, commit after each one
```

**Brief and review each unit** — the opt-in mode: two turns per unit, a written brief across the
restart, and a review against notes written before the diff existed.

```
/renew-loop implement openspec/changes/add-auth/tasks.md, apply with subagent review,
      commit each unit, max 20 turns
```

**No restarts.** Needs no extension and no harness; the turns run in one session, still bounded.

```
/renew-loop implement the first open unit in tasks.md, do everything in this session,
      no context restart
```

**Resuming after a break, a crash, or a spent budget.**

```
/renew-loop continue from .pi/renew-loop/add-auth/handover-add-auth.md
```

---

## What happens under the hood

```
TURN 1  (fresh session)
├─ /renew-loop expands: protocol body + your request at $@
├─ STEP 1: register the renewal context = "/renew-loop <your request, verbatim>"
│          └─ validated now: does "/renew-loop" resolve?   — crash-safe from here on
├─ STEP 2: resolve the work · the handover · the stop condition · the budget (default 10)
├─ STEP 3: read the handover → do ONE turn's work → run its check → tick → commit
│          └─ rewrite the handover: Turn 1 of 10 · Progress · Open · Next
└─ STEP 4: stop?  condition met · nothing open · hard stop · no progress · budget spent
           └─ no → RESTART (or earlier, if context crosses 0.85 × the model's window)
                 │
                 ▼
     ┌────────────────────────────────────────────────────────────────┐
     │ provenance: restart #1 · <ts> · reason: renew-loop-turn        │  always
     │ summary: <what turn 1 did>                                     │  default on
     │ next steps: read the handover at <path>, do what Next says     │  default on
     │ /renew-loop <your request> → re-expands to the protocol        │  the registered context
     └────────────────────────────────────────────────────────────────┘
TURN 2  (fresh context)
├─ STEP 0: provenance says renew-loop-turn → a continuing run
├─ read the handover — and only what it points at
├─ do ONE turn's work · check · tick · commit · rewrite the handover
└─ stop, ask, or restart into turn 3
```

In brief-and-review mode the same skeleton carries two kinds of turn: an **analyse** turn that writes
the brief and the reviewer notes and restarts with `reason: renew-loop-analysis`, and an **execute**
turn that runs the unit and reviews it. Both count against the budget, so 10 turns is five units.

Two documents, two jobs — worth remembering when reading a stuck loop:

- **the task list** answers *"what is done"*
- **the handover** answers *"what just happened"*

---

## How a run ends

Every turn ends by checking these, in order, before anything else happens with its result:

1. **The stop condition is met** — the request's own condition, or a task list with no open unit left.
   The ordinary ending. Where the request asked for it and OpenSpec is installed, this is also where
   the change is archived.
2. **A hard stop** — continuing would mean guessing your intent; a commit or push failed; the same
   step failed twice; a check is red for something that cannot be repaired without a decision. The
   loop reports what it has and what blocks it.
3. **No progress** — nothing changed since what the last turn recorded, and the task list is
   unchanged. This catches the failure that actually happens: a unit believed finished but never
   ticked, and a turn that keeps re-doing the same step. Resuming an existing handover is the one
   exception, and only for one turn: a run that stopped *because* it closed nothing — a blocker, a
   decision you have since answered — is the case most worth resuming, so the loop records `Resumed:`
   and takes a turn. If that turn also closes nothing, the guard fires normally.
4. **The budget is spent** — the restart ordinal has reached `max N turns`, default 10. This is not a
   failure and the loop does not report it as one: it says the budget is spent, names the next step,
   and gives you the line to continue with. Nothing is lost — the handover holds the run.
5. **`ask me between turns`** was requested — report, name what the next turn would do, wait.

Being bounded by default is the point. An unbounded loop that misreads its own stop condition burns a
session's worth of tokens before anyone notices; a bounded one stops after ten turns and tells you
where it got to. Raise the budget when you have watched a run and trust it.

It draws the line at the **design**, not at the file. A turn blocked by a pre-existing defect is
repaired in place — outside the work at hand if that is where the defect lives, as its own `fix:`
commit before the turn's, recorded in the handover — once the loop has proved the defect is not its
own and that the shortest repair changes no fixed decision, no public surface, no dependency, no
protocol and no test's strength. If any of those *would* change, or the alternatives disagree about
the design, the loop stops and asks. It never takes the third route of calling the turn done against a
reduced bar. The rule at length, with its bounds, is the 🔧 lane in
[`IMPROVEMENT-BUDGET.md`](../skills/subagent-brief/IMPROVEMENT-BUDGET.md).

> **Recommendation:** use `ask me between turns` until you have seen the no-progress guard fire at
> least once. It is the one guard with nothing behind it.

---

## Opt-in: brief-and-review

Ask for it — *"apply and review"*, *"apply with review"*, *"apply with subagent review"*, *"brief and
review each unit"*, *"delegate each unit"*, *"review each unit before committing"* — and a unit takes
**two turns** instead of one. Anything that asks for the work to be *applied and reviewed*, rather
than just done, turns it on.

| | The plain loop | brief-and-review |
|---|---|---|
| a unit costs | one turn | two turns, both against the budget |
| the executor sees | the handover | the handover **and a brief written for it** |
| the review | the turn's own check | reviewer notes written *before* the diff existed, applied to the diff |
| what it needs | nothing but the extension | the same — a runner and the two skills are all optional |

**The analyse turn** picks one unit, sizes it (T0 mechanical → T3 stateful/protocol), writes the brief
and the reviewer notes beside the handover, points `Next:` at the unit, and restarts. **The execute
turn** reads only the handover and the brief, runs the unit, and *then* reads the notes and reviews the
diff against them — in that order, because notes read earlier bias how the work is framed instead of
judging the result, and because the defects are where the executor did not look.

**It finds its runner first**, in this order, and records what it found in the handover's `Runner:`
line:

1. a **`subagent` tool** (from [`pi-subagents`](#optional-companions)) — a real child session per
   unit, with a `reviewer` child available as a second opinion on the diff;
2. **this same session** — no child at all: the unit is implemented here, from the brief, under the
   same restricted reading.

The second is a fallback, not a cancellation. The brief, the reviewer notes and the two-turn split all
still happen; what is lost without a child runner is the executor's context isolation, not the review.
A brief written for a cold executor is worth writing even when you are the executor — it is what makes
the result checkable by someone who was not there, and after a restart, that is you.

Why it is opt-in: it costs a restart and two turns per unit, and most work does not need it. Reach for
it when the units carry acceptance criteria you want verified, when each unit should land as its own
reviewable commit, when a unit is big enough that analysing and executing it in one context degrades
both, or when the run is unattended and nothing else will check the result.

---

## Optional companions

The protocol assumes a shell, a repo and a model. Everything else is a lane it takes when it is there,
and does without when it is not — it never asks you to install anything mid-run, and it says which lane
it took.

| Lane | Best | Then | Floor |
|---|---|---|---|
| running a unit (brief-and-review) | [`pi-subagents`](https://github.com/nicobailon/pi-subagents) — `subagent` with `agent: "worker"`, and a `reviewer` child for a second opinion | — | the unit runs in this session, from the brief, under the same restricted reading |
| the work's shape | [OpenSpec](https://github.com/Fission-AI/OpenSpec) — `openspec show/status/validate`, and `openspec archive` to apply the change when you ask for it | — | a markdown checklist, and the loop adds the checkboxes if the file has none |
| brief and review | `subagent-brief`, `subagent-review` (this repo, installed with it) | — | the loop writes the brief and the notes itself, to the outlines in the protocol |
| the restart | `pi-renew` (this repo) | — | No-restart mode: the turns run in one session, still bounded |

Two of those are worth installing if you are going to live in this loop:

```bash
pi install npm:pi-subagents          # child agents: worker, reviewer, scout, oracle …
npm install -g @fission-ai/openspec  # spec-driven changes: openspec/changes/<change>/tasks.md
```

`pi-subagents` gives brief-and-review a real child session per unit, which is the difference between
the loop's context staying clean for twenty units and staying clean for three. OpenSpec gives the loop a
task list that was written to be executed — one change directory, a spec delta, and a `tasks.md` already
in checkbox form — and a defined way to apply the change at the end (`openspec archive`, when your
request asks for it).

Neither is required, and the plain loop uses neither. The loop also does not degrade *quietly*: the
handover records what it found — `Runner:` for the executor, notes for the rest — and a turn that fell
back to a lower lane says so in its report.

---

## Using `pi-renew` on its own

`pi-renew` is not part of the loop — the loop is just one caller. Register nothing and it does what it has
always done: reset the context and carry your summary and next steps forward.

```
> we're done exploring; clean the context and keep going with the migration
   → the agent calls `renew_session` with a summary and next steps
   → the session restarts carrying just those
```

The same happens automatically when the high-context trigger fires, in any flow, with no loop present.

If you *do* register a renewal context, it is replayed on every restart, and it can be anything the runtime
can expand:

| Registered context | What the fresh session receives |
|---|---|
| `/renew-loop implement tasks.md` | the loop protocol, with your request in it |
| `/skill:my-workflow arg` | the whole `SKILL.md` body, with `arg` appended |
| plain prose | the prose |

---

## Driving `pi` from outside

Three skills run a `pi` process from the shell. **None of them is reachable from the loop** — they all
live under `.claude/skills/`, outside the `skills/` tree the `pi` manifest registers, and they exist so
this tooling can be tested without a human in it.

| Skill | Mode | Use it for |
|---|---|---|
| `pi-subagent` | one-shot | a self-contained question or task in a separate `pi` process. Cannot exercise restarts at all |
| `pi-subagent-rpc` | long-lived, headless | scripted runs, asserting on structured events |
| `pi-subagent-tmux` | long-lived, real TUI | the surface you actually use; dead-pane post-mortems |

They sit under `.claude/skills/` on purpose: they exist to test this repo's own tooling, and nothing
`/renew-loop` does should be able to reach them. `pi-driver-common` — the shared library the three
resolve as `../pi-driver-common/…` — is a fourth directory alongside them, so there is exactly one copy.

**None of them pins a model.** Given no `--model` they pass none, and `pi` resolves the default from
its own settings (`defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`); an explicit
`--model` is validated against the catalogue before anything is spawned.

The RPC driver sees things the model and the tools cannot — notably runtime errors from messages an extension
tried to send. When a run "succeeds" but nothing happened, look there first.

Where `pi-subagents` is installed, brief-and-review runs each unit through its `subagent` tool — a real
child session, with a `reviewer` available for a second pass on the diff. It is not required: with no
child runner the unit runs in the session that briefed it. Both runners produce the same artefacts, so a
run that changes runner mid-way is still one coherent history.

---

## Troubleshooting

**The fresh session ignored my loop and answered something else.**
The renewal context was delivered but not expanded — the model received the literal text `/renew-loop …`. Usually
`/renew-loop` is not registered at all, or the template was renamed after registration. Check that `/help` lists
`/renew-loop`, and that `pi list` shows the pi-renew package; `./install.mjs --check` in a checkout reports the same thing plus
any stale symlinks from the pre-manifest setup. Registration-time validation is meant to catch this at session
start; if it fired, you will have seen an explicit rejection.

**The loop restarted but repeated turn 1.**
Check the provenance line at the top of the fresh session. If the reason is missing, the restart lost its
state file. If it is present but the handover's `Next:` line is vague or absent, the next turn could not
tell where it was — the handover is the source of truth for what happened.

**It restarted forever.**
It cannot: the budget stops it after 10 turns unless you raised it. If it ran longer than you meant it to,
check the `max N turns` in your request — and check that the task list is actually being updated when a
unit closes, since a checkbox that never changes means the exit test can never become true and the loop
spends its whole budget.

**Nothing was reset, but the loop continued.**
This only applies if you (or another caller) used the `compact` strategy directly — `/renew-loop` itself always
passes `new-session` explicitly and never selects `compact`. Under `compact`, `pi` can refuse to compact —
not only for a small session, but for **any** session whose token mass sits in its oldest entries, however
large the session is overall — and the continuation says so explicitly rather than pretending a reset
happened: it states that it is continuing *without* a reset, naming the reported reason. The `new-session`
strategy has no such floor.

**It stopped after ten turns with work left.**
That is the default budget doing its job. The handover holds the run: continue with
`/renew-loop continue from <handover>`, or re-run the same request with `max 25 turns`.

**It implemented the unit in my own session instead of a child.**
In brief-and-review mode, no runner was installed — there was no `subagent` tool from `pi-subagents`.
That is the documented floor, not a fault, and the handover's `Runner:` line records it. Install `pi-subagents` if you want a real child session per unit. (In the plain loop
this is simply how it works: the turn does its own work unless you asked for it to be delegated.)

**It wrote no brief, and reviewed nothing.**
The plain loop is the default. Add "apply and review" — or "apply with subagent review" — to the
request for the two-turn brief-and-review mode.

**It added checkboxes to my task file.**
The file listed units but had nothing to tick, and the exit test and the no-progress guard both read that
file. The change is `- [ ]` on each unit line and nothing else, in its own commit before the first unit.
Give it a list that already has checkboxes — an OpenSpec `tasks.md`, say — and it changes nothing.

**It created a second handover for what I thought was the same work.**
The `Work:` line of the existing handover names something different from what this run resolved.
Handovers are per piece of work by design, and each one carries the work's name in the path
(`.pi/renew-loop/<slug>/handover-<slug>.md`) so two runs can never write over each other. Point both runs
at the same task list, or name the handover explicitly.

**The context filled up before the handover was written.**
The threshold fraction is too close to the runtime's own auto-compaction trigger, which fires at the model's
window minus its reserve. Lower `thresholdFraction`.

---

## Design notes

Rationale that used to sit in `prompts/renew-loop.md` itself. The template is now instructions only; the
reasoning behind them lives here.

**Why a prompt template and not a skill.** A skill is discoverable — the model can decide to invoke
it. The loop must only ever run because a human typed `/renew-loop`, so its body is delivered as a prompt
template and is invisible to the model on its own initiative.

**Why the vocabulary is private to the protocol.** The reason values, the turn count, the handover
shape and the modes are the template's own invention. `pi-renew` never interprets any of them — it only
replays a registered string. That ignorance is what lets the same extension serve callers with
nothing to do with this protocol.

**Why `new-session` is always passed explicitly, and `compact` never.** The registered renewal
context is assembled only inside the `/pi-renew` command handler, and only the `new-session`
branch dispatches that command. Under `compact` the fresh context receives a short continuation
notice and nothing else — no protocol body, no request — so the loop dies after one turn.

**Why registration is verbatim and comes first.** A paraphrased or tidied request drifts a little on
every restart, and the loop ends up chasing a task nobody asked for. Registering before any read
also makes turn 1 crash-safe: a session lost before the first restart resumes from the replayed
string.

**Why every path the loop writes carries the work's name.** A handover is adopted by whichever session
finds it, and the only thing that makes adoption safe is being sure it is *this* run's handover. The
`Work:` line proves that after the fact; the path prevents the question. A generic
`.pi/loop/handover.md` is one path shared by every change in the repo, so two runs collide on it silently
and the second one reports the first one's progress. `.pi/renew-loop/<slug>/handover-<slug>.md` cannot
collide, and it reads as what it is in a diff, an editor tab and a `git log`.

**Why the plain loop is the default, and the two-turn split is not.** The restart is what this repo
exists for, and it is worth having on its own: a bounded loop whose state lives in a file already
outlasts any single session, with nothing installed and nothing to learn. Briefs and reviews are a
second thing — real value, real cost, and the wrong default for a loop whose first job is to be
reachable. Making them a mode you ask for keeps the entry price at one command, and keeps the three
skills out of every session that did not want them.

**Why every companion is optional.** The protocol's value is the *shape* — one unit per turn, state in a
file, a bound you set, and a stop rather than a guess. None of that needs a particular child runner or a
particular spec tool. So each of them is a lane the loop takes when it is installed, with a floor
underneath it that does the same job with less: the turn does its own work, writes its own brief, ticks
its own checkboxes. A protocol that stops when a dependency is missing gets installed once and used
never.

**Why the budget defaults to 10 rather than to unbounded.** A loop that misreads its own stop condition
is not rare, and an unbounded one discovers that by spending everything. Ten turns is enough to see
whether a run is working and cheap enough to throw away if it is not; the handover means stopping costs
you nothing but the word to continue.

**Why an unrecognised provenance reason means "start a fresh turn".** Failing toward re-reading the
handover and repeating a turn's planning costs one turn. Failing toward executing a unit nobody analysed
is not recoverable.

**Why the execute turn reads in that order.** Reviewer notes read before the unit runs bias how its task
is framed instead of judging its result afterwards; reading anything beyond the handover and brief before
running it re-derives exactly the context the brief exists to carry.

---

## See also

- [`../README.md`](../README.md) — what this repo is, and how to install the extension
- [`../pi-extensions/pi-renew/README.md`](../pi-extensions/pi-renew/README.md) — the extension's own
  reference: the three tools, the `/pi-renew` command, restart strategies, payload assembly, config
- [`STATUS.md`](STATUS.md) — what is proven, what is outstanding, and the open runtime-version decision
- `skills/subagent-brief`, `skills/subagent-review` — the briefing and review skills, used only in brief-and-review mode
- `skills/subagent-brief/VERIFICATION-MENU.md` — which check earns its cost on which change (the
  T0–T3 tiers), and the command for it in each ecosystem
- `skills/subagent-brief/IMPROVEMENT-BUDGET.md` — what an agent may improve on its own authority, what
  it may repair to unblock a turn, and where a red opportunity goes on an unattended run
