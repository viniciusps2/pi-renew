# The `/renew-loop` implementation protocol

> **Status: implemented, not yet exercised end to end.** The mechanisms this document describes are
> shipped — both the `pi-renew` extension and the `/renew-loop` prompt template
> (`prompts/renew-loop.md`) exist in
> this repo today, with the extension's unit suite green and its two live restart tests passing
> against a real `pi`. What is still outstanding is a **live, end-to-end loop run**: a `restart: none`
> run, and full loops with restarts under `continuation: ask` and `continuation: auto`. So this
> document describes shipped behaviour that has not yet been exercised in a full live loop.
> [`STATUS.md`](STATUS.md) records exactly what was verified, how, and what is left.

A checklist-driven implementation loop for the `pi` CLI. You point it at a task list; it works one unit at a
time, restarting its own context between analysing a unit and executing it, so the executing agent never
inherits the analysing agent's clutter.

It is built from pieces that are layered, not peers: `/renew-loop` calls the two below it — `pi-renew` for the
restart, `pi-subagent` for each unit's implementation child — and neither of them knows anything about
loops, phases or reasons. That ignorance is the contract: it is what lets the same extension and the same
child runner serve callers that have nothing to do with this protocol.

| Piece | What it is | What it does |
|---|---|---|
| `/renew-loop` | a prompt template | the protocol: analyse → restart → execute → review → commit |
| `pi-renew` | an extension | a generic context-restart primitive; knows nothing about loops |
| `pi-subagent` | a skill | runs the implementation child the execute phase launches, where nothing better is installed |
| `pi-subagent-rpc`, `pi-subagent-tmux` | skills, under `.claude/skills/` | drive a `pi` process from outside — for developing and testing this repo only, deliberately kept out of the `skills/` tree `pi` loads |
| `pi-subagents`, OpenSpec | third-party, optional | better lanes for the same two jobs — see [Optional companions](#optional-companions) |

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

# 2. (Once per machine) Turn on the high-context auto-restart; add model aliases if you like:
#    cat ~/.pi/agent/pi-renew.json
#    { "highContextReminder": { "enabled": true, "thresholdFraction": 0.85 } }

# 3. Trust this checkout. /renew-loop itself does not need it, but this repo's own live tests do — they
#    load the extension by an explicit -e path inside the checkout, and an untrusted project's
#    resources are ignored silently. Run /trust once inside an interactive pi session here, or add
#    the path to ~/.pi/agent/trust.json.
```

**No symlinking into `~/.pi/agent/`.** An earlier version of this section had you install the inner
`pi-extensions/pi-renew` directory and then link `prompts/loop.md` and `skills/` into `~/.pi/agent/`
(back when the prompt was `loop.md` and the command was `/renew-loop`)
by hand. The manifest install replaces all of it. If you still have that setup, the two registrations
stack — and a duplicate extension is exactly what the live tests refuse to run against. From a checkout, run
`./install.mjs --check` to list the leftovers and `./install.mjs --migrate` to remove them.

The manifest points `skills` at the **whole tree**, not at individual skills, and that matters: the
skills are siblings of one another — `subagent-review` reads `../subagent-brief/…`, and `pi-subagent`
reads `../pi-driver-common/…`, a shared library with no `SKILL.md` of its own. Registering skills one
by one would break those relative references. The two development drivers are deliberately *not* in
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
> /renew-loop implement openspec/changes/add-x/tasks.md, review each unit, commit
```

The loop analyses one unit, restarts itself, executes and reviews it, commits, and stops. To do the next
unit, ask again:

```
> /renew-loop continue from .pi/renew-loop/add-x/handover-add-x.md
```

Neither line names a handover, and neither has to: the loop finds the one this change already has —
adopting its progress, tier, pending decisions and repairs — and creates one only if there is none. It
tells you which path it used. See [Where the handover lives](#where-the-handover-lives).

---

## Writing the request

Everything after `/renew-loop` is free text, interpolated into the protocol. There are no flags — you say what you
want, and the protocol translates it into its parameters.

| What you want | How you say it |
|---|---|
| Where the work is listed | `implement openspec/changes/add-x/tasks.md` — or the change or plan directory holding it |
| Where state lives | `handover .pi/renew-loop/add-auth/handover-add-auth.md` — **optional**; say nothing and the loop finds or creates one |
| Keep going by yourself | `continue automatically until all tasks are done` |
| Check in between units | `ask me before each next unit` |
| Don't restart at all | `do everything in this session, no context restart` |
| Bound an automatic run | `max 12 restarts` |
| Get a report at the end | `summarize the results` |

The final report is **opt-in**: say nothing about one and the loop ends with a short completion
statement instead. Its own last reply is the report — there is no separate file to go and read.

Hard stops are not something you request — the protocol always stops rather than continuing when a unit
escalates in review a second time, a child run fails, or a commit or push fails (see Automatic continuation
below). There is no phrase that turns that off; only the restart budget above is something you actively set.

Being **blocked** is not automatically one of them. A unit stopped by a defect it did not introduce —
a broken build, a duplicate registration, a fixture an earlier unit left wrong — gets repaired and the
loop carries on, even when the repair lives in files belonging to another unit, provided the repair
changes no design the spec fixed. Where it would, that is a decision and the loop stops for it.

### Where the handover lives

Naming one is optional. Point the loop at a task list and say nothing about state, and it looks for the
handover that task list already has before making a new one — so a second `/renew-loop` at the same openspec
change picks up the tier, the pending decisions, the repairs and the progress baseline the first one
left, instead of starting a parallel history beside it.

**Every path it creates carries the change's name.** The handover for
`openspec/changes/add-auth/tasks.md` is `.pi/renew-loop/add-auth/handover-add-auth.md`, with that unit's
brief and reviewer notes beside it:

```
.pi/renew-loop/add-auth/
├── handover-add-auth.md      # what just happened, and where the loop is
├── brief-3-2.md              # unit 3.2's delegation brief
└── review-3-2.md             # unit 3.2's reviewer notes
```

The slug is the task list's own directory where that names the work (`openspec/changes/add-auth/tasks.md`
→ `add-auth`), otherwise the file's stem (`docs/add-auth-plan.md` → `add-auth-plan`); a directory that
names no work — `tasks/`, `docs/`, `specs/`, the repo root — falls through to the stem. If that path is
already taken by a handover for a *different* list, the slug grows leftwards (`add-auth` →
`changes-add-auth`) until it is free.

This is not cosmetic. A plain `.pi/loop/handover.md` is the same path for every change in the repo, so
the next run over a different task list finds a handover that validates on nothing, and either adopts a
stranger's state or writes over it — silently, since both are called "the handover". Carrying the change
in the name makes that collision impossible to have.

It searches the canonical path first, then `<task-list-dir>/handover-<slug>.md`, then the pre-rename
locations (`.pi/loop/<slug>/handover.md`, `.pi/loop/handover.md`, `<task-list-dir>/handover.md`), and
takes the candidate whose own `Task list:` line names **this** list. A handover belonging to a different
run is skipped, never merged. Two live candidates for the same list is an ambiguity it will not guess at:
it stops and asks which. A handover found at one of the old paths is adopted and then **moved** to the
canonical one, with its brief and notes. Nothing found → it creates the canonical path. Either way it
tells you the path it resolved and whether it adopted, created or moved it, in its first report line.

The search is deliberately the same every cycle, because a restart replays your request verbatim — a
discovery that could land somewhere else would hand the fresh session a different handover than the one
the previous phase just wrote.

Naming a path explicitly always wins and skips the search, which is what `/renew-loop continue from
.pi/renew-loop/add-auth/handover-add-auth.md` does.

### When the task list has no checkboxes

Both termination checks read the task list, so the loop needs something in that file it can tick. On its
first analyse it checks, once:

- **already tickable** — `- [ ]` boxes, or whatever "done" is in that file's own format — it uses what is
  there and reformats nothing;
- **a list with no markers** — numbered or bulleted lines that each name a piece of work — it adds `- [ ]`
  to each unit line, changing nothing else, in its own commit before the first unit;
- **prose, not a list** — it transcribes the steps *the document itself names* into
  `.pi/renew-loop/<slug>/tasks-<slug>.md`, one `- [ ]` each, in the document's order, and works from that
  instead. A step the document does not name does not go in; a document that names no steps stops the
  loop with a question.

So an OpenSpec `tasks.md` is used exactly as it comes, and a hand-written plan becomes trackable without
you having to prepare it first.

### Examples

**One unit, then stop (the default).**

```
/renew-loop implement openspec/changes/add-auth/tasks.md, handover .pi/renew-loop/add-auth/handover-add-auth.md
```

**The same thing, letting it find the handover.** It adopts the one this change already has, or
creates it, and says which.

```
/renew-loop implement openspec/changes/add-auth
```

**Run until the list is empty, checking in between units.**

```
/renew-loop work through openspec/changes/add-auth/tasks.md, handover .pi/renew-loop/add-auth/handover-add-auth.md,
      ask me before starting each next unit, commit after each one
```

**Fully unattended, with bounds.**

```
/renew-loop implement everything in tasks.md,
      continue automatically until all tasks are done, max 12 restarts
```

**No restarts — the cheapest way to try the workflow.** Needs no extension and no harness; both phases run
in one session.

```
/renew-loop implement the first open unit in tasks.md, do everything in this session,
      no context restart
```

**Resuming after a break, or after a crash.**

```
/renew-loop continue from .pi/renew-loop/add-auth/handover-add-auth.md
```

---

## What happens under the hood

```
TURN 1  (fresh session)
├─ /renew-loop expands: protocol body + your request at $@
├─ STEP 1: register the delegate context = "/renew-loop <your request, verbatim>"
│          └─ validated now: does "/renew-loop" resolve?   — crash-safe from here on
├─ STEP 2: which lanes exist here? child runner · skills · openspec · restart
├─ STEP 3: resolve the task list (make it tickable) → then the handover
├─ exit test → no-progress guard → pick ONE unit → analyse
├─ write brief · reviewer-notes · handover
└─ RESTART on whichever comes first:
     A. context crosses 0.85 × the model's window
     B. all three documents written              ← the normal path
                 │
                 ▼
     ┌────────────────────────────────────────────────────────────────┐
     │ provenance: restart #1 · <ts> · reason: loop-analysis-complete │  always
     │ summary: <what turn 1 found>                                   │  default on
     │ next steps: <what turn 2 must do>                              │  default on
     │ /renew-loop <your request> → re-expands to the protocol        │  the registered context
     └────────────────────────────────────────────────────────────────┘
TURN 2  (fresh context)
├─ read ONLY handover + brief — no further investigation
├─ run the unit in the best lane there is, and wait for it
├─ THEN read reviewer-notes → review the diff
├─ minor → fix here · major → new brief, run the unit again
├─ update handover · tick the task list · commit (push only if asked)
└─ stop · ask · or restart into the next unit (reason: loop-unit-complete, under `auto`)
```

Two documents, two jobs — worth remembering when reading a stuck loop:

- **the task list** answers *"what is done"*
- **the handover** answers *"what just happened"*

---

## Automatic continuation

`continue automatically until all tasks are done` makes turn 2's last step another restart instead of a
stop. Two independent checks run at the top of every analyse phase:

- **exit test** — no open unit in the task list → report and stop. This is the intended ending.
- **no-progress guard** — the task list is unchanged since the previous cycle → stop and say so. This catches
  the failure that actually happens: a unit the agent believes it finished but whose checkbox was never
  ticked, and a review that keeps re-opening the same unit. Resuming an existing handover is the one
  exception, and only for one cycle: a run that stopped *because* it closed no unit — a blocker, a decision
  you have since answered — is the case most worth resuming, so the loop records `Resumed:` and continues.
  If that cycle also closes nothing, the guard fires normally.

Automatic does not mean unsupervised judgement. The loop stops rather than guessing whenever a decision is
due, and also stops on: a unit escalating in review twice, a failing child run, a failing commit or push, and
the restart budget being reached.

It draws the line at the **design**, not at the file. A unit blocked by a pre-existing defect is repaired
in place — outside the unit's allowed files if that is where the defect lives, as its own `fix:` commit
before the unit's, recorded in the handover — once the loop has proved the defect is not its own and that
the shortest repair changes no spec-fixed decision, no public surface, no dependency, no protocol and no
test's strength. If any of those *would* change, or the alternatives disagree about the design, the loop
stops and asks. It never takes the third route of ticking the unit against a reduced bar. The full rule,
with its bounds, is the 🔧 lane in
[`IMPROVEMENT-BUDGET.md`](../skills/subagent-brief/IMPROVEMENT-BUDGET.md).

> **Recommendation:** use `ask me before starting each next unit` until you have seen the no-progress guard
> fire at least once. It is the one guard with nothing behind it.

---

## Optional companions

The protocol assumes a shell, a repo and a model. Everything else is a lane it takes when it is there,
and does without when it is not — it never asks you to install anything mid-run, and it says which lane
it took.

| Lane | Best | Then | Floor |
|---|---|---|---|
| running a unit | [`pi-subagents`](https://github.com/nicobailon/pi-subagents) — `subagent` with `agent: "worker"`, and a `reviewer` child for a second opinion | this repo's `pi-subagent` skill (one-shot `pi -p`) | the loop implements the unit itself, from the brief, under the same restricted reading |
| the change's shape | [OpenSpec](https://github.com/Fission-AI/OpenSpec) — `openspec show/status/validate`, and `openspec archive` to apply the change when you ask for it | — | a markdown checklist, and the loop adds the checkboxes if the file has none |
| brief and review | `subagent-brief`, `subagent-review` (this repo, installed with it) | — | the loop writes the brief and the notes itself, to the outlines in the protocol |
| the restart | `pi-renew` (this repo) | — | No-restart mode: both phases in one session |

Two of those are worth installing if you are going to live in this loop:

```bash
pi install npm:pi-subagents          # child agents: worker, reviewer, scout, oracle …
npm install -g @fission-ai/openspec  # spec-driven changes: openspec/changes/<change>/tasks.md
```

`pi-subagents` gives the execute phase a real child session per unit, which is the difference between
the loop's context staying clean for twenty units and staying clean for three. OpenSpec gives the loop a
task list that was written to be executed — one change directory, a spec delta, and a `tasks.md` already
in checkbox form — and a defined way to apply the change at the end (`openspec archive`, when your
request asks for it).

Neither is required, and the loop does not degrade *quietly*: the handover records an `Environment:` line
naming what it found, and a phase that fell back to a lower lane says so in its report.

---

## Using `pi-renew` on its own

`pi-renew` is not part of the loop — the loop is just one caller. Register nothing and it does what it has
always done: reset the context and carry your summary and next steps forward.

```
> we're done exploring; clean the context and keep going with the migration
   → the agent calls the delegation tool with a summary and next steps
   → the session restarts carrying just those
```

The same happens automatically when the high-context trigger fires, in any flow, with no loop present.

If you *do* register a delegate context, it is replayed on every restart, and it can be anything the runtime
can expand:

| Registered context | What the fresh session receives |
|---|---|
| `/renew-loop implement tasks.md` | the loop protocol, with your request in it |
| `/skill:my-workflow arg` | the whole `SKILL.md` body, with `arg` appended |
| plain prose | the prose |

---

## Driving `pi` from outside

Three skills run a `pi` process from the shell. Only the first is part of the loop; the other two exist so
this tooling can be tested without a human in it.

| Skill | Where it lives | Mode | Use it for |
|---|---|---|---|
| `pi-subagent` | `skills/` | one-shot | **the loop's fallback implementation child** — the execute phase launches it per unit where `pi-subagents` is not installed; also a self-contained question. Cannot exercise restarts at all |
| `pi-subagent-rpc` | `.claude/skills/` | long-lived, headless | development only: scripted runs, asserting on structured events |
| `pi-subagent-tmux` | `.claude/skills/` | long-lived, real TUI | development only: the surface you actually use; dead-pane post-mortems |

The two development drivers sit under `.claude/skills/` on purpose: they exist to test this repo's own
tooling, and nothing `/renew-loop` does should be able to reach them. They still resolve `../pi-driver-common/…`
— the repo carries a symlink at `.claude/skills/pi-driver-common` pointing back at `skills/pi-driver-common`,
so the one shared library has exactly one copy.

The RPC driver sees things the model and the tools cannot — notably runtime errors from messages an extension
tried to send. When a run "succeeds" but nothing happened, look there first.

Where `pi-subagents` is installed, the execute phase prefers its `subagent` tool over the `pi-subagent`
skill — a real child session, with a `reviewer` available for a second pass on the diff. The skill stays as
the floor beneath it, and neither is required: with no child runner at all the loop implements the unit
itself. All three lanes produce the same artefacts, so a run that changes lanes mid-way is still one
coherent history.

---

## Troubleshooting

**The fresh session ignored my loop and answered something else.**
The delegate context was delivered but not expanded — the model received the literal text `/renew-loop …`. Usually
`/renew-loop` is not registered at all, or the template was renamed after registration. Check that `/help` lists
`/renew-loop`, and that `pi list` shows the pi-renew package; `./install.mjs --check` in a checkout reports the same thing plus
any stale symlinks from the pre-manifest setup. Registration-time validation is meant to catch this at session
start; if it fired, you will have seen an explicit rejection.

**The loop restarted but repeated turn 1.**
Check the provenance line at the top of the fresh session. If the reason is missing, the restart lost its
state file. If it is present but the handover does not name a unit, turn 2 could not tell where it was —
the handover is the source of truth for what happened.

**It restarted forever.**
The no-progress guard should have stopped it. Check whether the task list is actually being updated when a
unit closes; if the checkbox never changes, the exit test can never become true.

**Nothing was reset, but the loop continued.**
This only applies if you (or another caller) used the `compact` strategy directly — `/renew-loop` itself always
passes `new-session` explicitly and never selects `compact`. Under `compact`, `pi` can refuse to compact —
not only for a small session, but for **any** session whose token mass sits in its oldest entries, however
large the session is overall — and the continuation says so explicitly rather than pretending a reset
happened: it states that it is continuing *without* a reset, naming the reported reason. The `new-session`
strategy has no such floor.

**It implemented the unit in my own session instead of a child.**
No child runner was installed — neither the `subagent` tool from `pi-subagents` nor this repo's
`pi-subagent` skill. That is the documented floor, not a fault, and the handover's `Environment:` line
records it. Install `pi-subagents` if you want a real child session per unit.

**It added checkboxes to my task file.**
The file listed units but had nothing to tick, and both termination checks read that file. The change is
`- [ ]` on each unit line and nothing else, in its own commit before the first unit. Give it a list that
already has checkboxes — an OpenSpec `tasks.md`, say — and it changes nothing.

**It created a second handover for what I thought was the same work.**
The `Task list:` line of the existing handover names a different list than the one this run resolved.
Handovers are per task list by design, and each one carries its change in the path
(`.pi/renew-loop/<change>/handover-<change>.md`) so two runs can never write over each other. Point both
runs at the same task list, or name the handover explicitly.

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

**Why the vocabulary is private to the protocol.** The reason values, the phases and the three
documents are the template's own invention. `pi-renew` never interprets any of them — it only
replays a registered string. That ignorance is what lets the same extension serve callers with
nothing to do with this protocol.

**Why `new-session` is always passed explicitly, and `compact` never.** The registered delegate
context is assembled only inside the `/pi-renew` command handler, and only the `new-session`
branch dispatches that command. Under `compact` the fresh context receives a short continuation
notice and nothing else — no protocol body, no request — so the loop dies after one phase.

**Why registration is verbatim and comes first.** A paraphrased or tidied request drifts a little on
every restart, and the loop ends up chasing a task nobody asked for. Registering before any read
also makes turn 1 crash-safe: a session lost before the first restart resumes from the replayed
string.

**Why every path the loop writes carries the change's name.** A handover is adopted by whichever session
finds it, and the only thing that makes adoption safe is being sure it is *this* run's handover. The
`Task list:` line proves that after the fact; the path prevents the question. A generic
`.pi/loop/handover.md` is one path shared by every change in the repo, so two runs collide on it silently
and the second one reports the first one's progress. `.pi/renew-loop/<change>/handover-<change>.md` cannot
collide, and it reads as what it is in a diff, an editor tab and a `git log`.

**Why every companion is optional.** The protocol's value is the *shape* — one unit per cycle, a brief
across the restart boundary, a review against notes written before the diff existed, a task list as the
single source of what is done. None of that needs a particular child runner or a particular spec tool. So
each of them is a lane the loop takes when it is installed, with a floor underneath it that does the same
job with less: the loop implements the unit itself, writes its own brief, ticks its own checkboxes. A
protocol that stops when a dependency is missing gets installed once and used never.

**Why an unrecognised provenance reason means "re-analyse".** Failing toward re-registering and
re-analysing costs one cycle. Failing toward executing a unit nobody analysed is not recoverable.

**Why the execute phase reads in that order.** Reviewer notes read before the child runs bias how the
child's task is framed instead of judging its result afterwards; reading anything beyond the
handover and brief before launching re-derives exactly the context the brief exists to carry.

---

## See also

- [`../README.md`](../README.md) — what this repo is, and how to install the extension
- [`../pi-extensions/pi-renew/README.md`](../pi-extensions/pi-renew/README.md) — the extension's own
  reference: the three tools, the `/pi-renew` command, restart strategies, payload assembly, config
- [`STATUS.md`](STATUS.md) — what is proven, what is outstanding, and the open runtime-version decision
- [`delegate-restart-streaming-throw.md`](delegate-restart-streaming-throw.md) — the research behind the
  restart-reliability work (a dated record)
- `skills/subagent-brief`, `skills/subagent-review` — the briefing and review skills the loop calls
- `skills/subagent-brief/VERIFICATION-MENU.md` — which check earns its cost on which change (the
  T0–T3 tiers), and the command for it in each ecosystem
- `skills/subagent-brief/IMPROVEMENT-BUDGET.md` — what an agent may improve on its own authority,
  and where a red opportunity goes under `auto`
