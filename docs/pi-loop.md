# The `pi` implementation loop

> **Status: implemented, not yet exercised end to end.** The mechanisms this document describes are
> shipped — both the `pi-renew` extension and the `/loop` prompt template (`prompts/loop.md`) exist in
> this repo today, with the extension's unit suite green. What is still outstanding is a **live,
> end-to-end loop run**: a `restart: none` run, and full loops with restarts under `continuation: ask`
> and `continuation: auto`. So this document describes shipped behaviour that has not yet been
> exercised in a full live loop. [`STATUS.md`](STATUS.md) tracks exactly what is proven, what is
> outstanding, and the runtime-version question the live proofs are gated on.

A checklist-driven implementation loop for the `pi` CLI. You point it at a task list; it works one unit at a
time, restarting its own context between analysing a unit and executing it, so the executing agent never
inherits the analysing agent's clutter.

It is built from pieces that are layered, not peers: `/loop` calls the two below it — `pi-renew` for the
restart, `pi-subagent` for each unit's implementation child — and neither of them knows anything about
loops, phases or reasons. That ignorance is the contract: it is what lets the same extension and the same
child runner serve callers that have nothing to do with this protocol.

| Piece | What it is | What it does |
|---|---|---|
| `/loop` | a prompt template | the protocol: analyse → restart → execute → review → commit |
| `pi-renew` | an extension | a generic context-restart primitive; knows nothing about loops |
| `pi-subagent` | a skill | runs the implementation child the execute phase launches |
| `pi-subagent-rpc`, `pi-subagent-tmux` | skills, under `.claude/skills/` | drive a `pi` process from outside — for developing and testing this repo only, deliberately kept out of the `skills/` tree `pi` loads |

---

## Setup

One-time per machine, then per checkout. Assume you have cloned this repo and are standing in its
root, so `$PWD` is the checkout you just made — the one path that moves from machine to machine. Each
step below is either keyed off `$PWD` or lives once in `~/.pi/agent/` and is reused by every checkout.

```bash
# 0. Be in the checkout:   cd <this-repo>          # so $PWD is the repo root

# 1. Load the pi-renew extension from THIS checkout (see the repo README for `pi install`, and for
#    installing straight from GitHub instead). This is the one path that follows the folder:
pi install "$PWD/pi-extensions/pi-renew"
#    …which writes the entry into ~/.pi/agent/settings.json:
#    "packages": [ …, "<path to this checkout>/pi-extensions/pi-renew" ]

# 2. (Once per machine) Turn on the high-context auto-restart; add model aliases if you like:
#    cat ~/.pi/agent/pi-renew.json
#    { "highContextReminder": { "enabled": true, "thresholdFraction": 0.85 } }

# 3. Install the /loop template globally, keeping the file version-controlled in this repo:
ln -sfn "$PWD/prompts/loop.md" ~/.pi/agent/prompts/loop.md

# 4. Expose the skills the loop drives. Symlink the WHOLE skills/ tree as a single namespace so the
#    skills stay siblings of one another: subagent-review reads ../subagent-brief/…, and pi-subagent
#    reads ../pi-driver-common/… (a shared lib with no SKILL.md of its own). Linking individual
#    skills instead would break those relative references. The namespace name is arbitrary (here:
#    dev). The two development drivers are NOT in this tree — they live under .claude/skills/ so
#    that pi never loads them:
ln -sfn "$PWD/skills" ~/.pi/agent/skills/dev

# 5. If any flow you run uses this repo's project-local .pi/ resources, trust it (inside an
#    interactive pi session; /loop itself does not need this):
#    /trust
```

`/loop` is installed globally, so it works in every repo with no trust gate — while the file itself stays
version-controlled in this repo. One loop serves every project; a project needing a different protocol adds
its own template under a **different name** rather than overriding `loop`.

> **Why trust still matters.** Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never prompt for
> trust and silently ignore project-local resources without it. That no longer affects `/loop`, but it does
> affect any `.pi/skills/` or `.pi/settings.json` a flow depends on — and an unresolved slash command is
> delivered to the model as literal text rather than failing, so the failure is quiet.

---

## Quick start

```
$ cd <repo> && pi
> /loop implement openspec/changes/add-x/tasks.md, handover .pi/loop/handover.md, review each unit, commit
```

The loop analyses one unit, restarts itself, executes and reviews it, commits, and stops. To do the next
unit, ask again:

```
> /loop continue from .pi/loop/handover.md
```

---

## Writing the request

Everything after `/loop` is free text, interpolated into the protocol. There are no flags — you say what you
want, and the protocol translates it into its parameters.

| What you want | How you say it |
|---|---|
| Where the work is listed | `implement openspec/changes/add-x/tasks.md` |
| Where state lives | `handover .pi/loop/handover.md` |
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

### Examples

**One unit, then stop (the default).**

```
/loop implement openspec/changes/add-auth/tasks.md, handover .pi/loop/handover.md
```

**Run until the list is empty, checking in between units.**

```
/loop work through openspec/changes/add-auth/tasks.md, handover .pi/loop/handover.md,
      ask me before starting each next unit, commit after each one
```

**Fully unattended, with bounds.**

```
/loop implement everything in tasks.md, handover .pi/loop/handover.md,
      continue automatically until all tasks are done, max 12 restarts
```

**No restarts — the cheapest way to try the workflow.** Needs no extension and no harness; both phases run
in one session.

```
/loop implement the first open unit in tasks.md, do everything in this session,
      no context restart, handover .pi/loop/handover.md
```

**Resuming after a break, or after a crash.**

```
/loop continue from .pi/loop/handover.md
```

---

## What happens under the hood

```
TURN 1  (fresh session)
├─ /loop expands: protocol body + your request at $@
├─ STEP 1: register the delegate context = "/loop <your request, verbatim>"
│          └─ validated now: does "/loop" resolve?   — crash-safe from here on
├─ read task list → exit test → no-progress guard → pick ONE unit → analyse
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
     │ /loop <your request>  → re-expands to the protocol             │  the registered context
     └────────────────────────────────────────────────────────────────┘
TURN 2  (fresh context)
├─ read ONLY handover + brief — no further investigation
├─ launch the implementation child and wait for it
├─ THEN read reviewer-notes → review the diff
├─ minor → fix here · major → new brief, run the child again
├─ update handover · commit (push only if the request asked for it)
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
  ticked, and a review that keeps re-opening the same unit.

Automatic does not mean unsupervised judgement. The loop stops rather than guessing whenever a decision is
due, and also stops on: a unit escalating in review twice, a failing child run, a failing commit or push, and
the restart budget being reached.

> **Recommendation:** use `ask me before starting each next unit` until you have seen the no-progress guard
> fire at least once. It is the one guard with nothing behind it.

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
| `/loop implement tasks.md` | the loop protocol, with your request in it |
| `/skill:my-workflow arg` | the whole `SKILL.md` body, with `arg` appended |
| plain prose | the prose |

---

## Driving `pi` from outside

Three skills run a `pi` process from the shell. Only the first is part of the loop; the other two exist so
this tooling can be tested without a human in it.

| Skill | Where it lives | Mode | Use it for |
|---|---|---|---|
| `pi-subagent` | `skills/` | one-shot | **the loop's own implementation child** — the execute phase launches it every unit; also a self-contained question. Cannot exercise restarts at all |
| `pi-subagent-rpc` | `.claude/skills/` | long-lived, headless | development only: scripted runs, asserting on structured events |
| `pi-subagent-tmux` | `.claude/skills/` | long-lived, real TUI | development only: the surface you actually use; dead-pane post-mortems |

The two development drivers sit under `.claude/skills/` on purpose: they exist to test this repo's own
tooling, and nothing `/loop` does should be able to reach them. They still resolve `../pi-driver-common/…`
— the repo carries a symlink at `.claude/skills/pi-driver-common` pointing back at `skills/pi-driver-common`,
so the one shared library has exactly one copy.

The RPC driver sees things the model and the tools cannot — notably runtime errors from messages an extension
tried to send. When a run "succeeds" but nothing happened, look there first.

---

## Troubleshooting

**The fresh session ignored my loop and answered something else.**
The delegate context was delivered but not expanded — the model received the literal text `/loop …`. Usually
the global symlink at `~/.pi/agent/prompts/loop.md` is missing or broken, or the template was renamed after
registration. Check `readlink -f ~/.pi/agent/prompts/loop.md`. Registration-time validation is meant to catch
this at session start; if it fired, you will have seen an explicit rejection.

**The loop restarted but repeated turn 1.**
Check the provenance line at the top of the fresh session. If the reason is missing, the restart lost its
state file. If it is present but the handover does not name a unit, turn 2 could not tell where it was —
the handover is the source of truth for what happened.

**It restarted forever.**
The no-progress guard should have stopped it. Check whether the task list is actually being updated when a
unit closes; if the checkbox never changes, the exit test can never become true.

**Nothing was reset, but the loop continued.**
This only applies if you (or another caller) used the `compact` strategy directly — `/loop` itself always
passes `new-session` explicitly and never selects `compact`. Under `compact`, `pi` can refuse to compact —
not only for a small session, but for **any** session whose token mass sits in its oldest entries, however
large the session is overall — and the continuation says so explicitly rather than pretending a reset
happened: it states that it is continuing *without* a reset, naming the reported reason. The `new-session`
strategy has no such floor.

**The context filled up before the handover was written.**
The threshold fraction is too close to the runtime's own auto-compaction trigger, which fires at the model's
window minus its reserve. Lower `thresholdFraction`.

---

## Design notes

Rationale that used to sit in `prompts/loop.md` itself. The template is now instructions only; the
reasoning behind them lives here.

**Why a prompt template and not a skill.** A skill is discoverable — the model can decide to invoke
it. The loop must only ever run because a human typed `/loop`, so its body is delivered as a prompt
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
