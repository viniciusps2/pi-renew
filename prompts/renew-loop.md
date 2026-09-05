---
description: Repeat a turn — do the work, write the handover, restart with a fresh context — until a stop condition or the turn budget.
argument-hint: <what to do each turn, when to stop, and any options>
---

You are running the `/renew-loop` protocol: repeat one **turn** of work until a stop condition is met
or the turn budget runs out. Each turn is its own session with a fresh context, and everything the
next turn needs is in a handover file — not in the conversation, which the restart throws away.

The default loop is deliberately plain: read the handover, do the next piece of work, record what
happened, restart. Nothing else is required — no sub-agents, no skills, no spec tool. What those add
is opt-in, and the request is what turns it on.

Background, setup and troubleshooting live in `pi-renew/docs/renew-loop.md`. You do not need it.

## Your request

Read this in full before Step 0. It is the protocol's only source for what you were asked to do:

$@

Map it onto the parameters below by intent — there are no flags.

| Signal in the request | Parameter it fixes |
|---|---|
| a goal, a task list, a checklist, a plan, a thing to repeat | the work each turn advances |
| `stop when …`, `until …`, `once … passes` | the stop condition |
| `max N turns`, `max N restarts` | the turn budget — **default 10** |
| `handover <path>` | where the handover lives |
| nothing about a handover | Step 2 finds this work's own, or creates it |
| `ask me between turns`, `check in each turn` | pause after each turn instead of restarting |
| `one turn only`, `do one unit and stop` | a budget of 1 |
| `no context restart`, `do everything in this session` | No-restart mode |
| no such phrase | restart `new-session`, passed explicitly every turn |
| `apply and review`, `apply with review`, `apply with subagent review`, `brief and review each unit`, `delegate each unit` | **brief-and-review mode** — opt-in, below |
| `summarize the results`, `report at the end` | produce The final report |
| nothing about a summary | no report — end with a short completion statement |

Never guess a missing parameter. Step 2 either resolves it by a rule that gives the same answer every
turn, or stops and asks. The two exceptions are the ones with safe defaults: an unstated budget is
**10**, and an unstated mode is the plain loop.

A run needs at least one way to end. A stop condition, a task list that can empty, or both — and the
budget behind them either way. If the request gives none of those, the budget alone bounds the run,
and you say so in your first report line.

## Step 0 — Which turn am I in?

Look in the messages *preceding* this one — never in Your request — for the provenance line the
`pi-renew` extension inserts before this body:

```
[pi-renew restart #2 at 2026-08-24T18:04:11.921Z] reason: renew-loop-turn
```

Match on whether the reason **contains** a value below, not on equality — it sits inside a longer
line. The ordinal (`#2`) is how many turns this run has spent: Step 4 checks it against the budget.

| Reason contains | Enter |
|---|---|
| no such line, or nothing below matches | Step 1, then Step 2 — a fresh run |
| `renew-loop-turn` | Step 2, then the turn — a continuing run |
| `renew-loop-analysis` | brief-and-review mode's **execute half**, directly |
| `context usage too high` | Step 2, then whatever the handover's `Next:` line names |

Treat anything unrecognised as absent and start a fresh turn from Step 2. That direction is
deliberate: re-reading the handover and repeating a turn's planning is recoverable, executing a unit
nobody analysed is not. (A run started before this protocol was renamed says `loop-unit-complete` and
`loop-analysis-complete`; read those as `renew-loop-turn` and `renew-loop-analysis`.)

## Step 1 — Register before doing anything else

Fresh runs only. A continuing restart skips this step — the first turn's registration still stands,
and re-registering only resets the restart counter the budget is read from.

Before reading the handover, the task list, or anything else:

- Call `set_delegate_context` with `context` set to the literal string `/renew-loop ` followed by the
  request in Your request above, character for character — no paraphrase, no re-ordering, no
  tidying. This is what makes turn 1 crash-safe: a session lost before the first restart resumes by
  replaying that string. Normalizing it makes the loop drift once per turn.
- If `set_delegate_context` is unavailable, `pi-renew` is not loaded. Note that in the handover, run
  in one session (see No-restart mode) regardless of what the request asked for, and say so plainly
  in your final message.

Registering first keeps even an under-specified request resumable while you resolve the rest of it.

## Step 2 — Resolve the work, the handover and the bounds

Every turn resolves these the same way. A restart replays the registered request verbatim, so a rule
that could answer differently on turn 4 than on turn 3 hands the fresh session someone else's state.

- **The work.** A path in the request → use it. A directory holding a plan or an openspec change →
  resolve the list inside it by convention: `tasks.md`, then `TASKS.md`, `plan.md`, `checklist.md`.
  Two of those present, or none, → stop and ask which. A goal with no document at all is fine — the
  handover carries the plan instead. **Never invent a task list**: point at one, or work from the
  goal and record the steps in the handover.
- **The handover** — below. It is the only thing that survives the restart.
- **The bounds.** The stop condition in the request, and the turn budget (default 10). Write both
  into the handover on the first turn and read them back from it afterwards, so a resumed run keeps
  the bound it started with.
- **Make a task list tickable**, if there is one — below.
- **The restart primitive.** `set_delegate_context` and `delegate_to_agent` present → restart between
  turns. Absent → No-restart mode. That is the only capability the default loop cares about; the
  optional lanes are probed only in the modes that use them.

### Where the handover lives

**Every path this loop creates carries the work's name.** The slug is:

1. the task list's own directory where that names the work —
   `openspec/changes/add-auth/tasks.md` → `add-auth`;
2. otherwise the task list's filename stem — `docs/add-auth-plan.md` → `add-auth-plan`. Directory
   names that name no work (`tasks`, `task`, `docs`, `doc`, `plans`, `specs`, `.pi`, the repo root)
   fall through to this rule;
3. with no document at all, a short kebab-case slug from the goal itself (`get the e2e suite green`
   → `e2e-suite-green`), written into the handover on turn 1 and re-read from it afterwards rather
   than re-derived;
4. and if the canonical path below already holds a handover for **different** work, extend the slug
   leftwards one path segment at a time (`add-auth` → `changes-add-auth`) until it is free.

The canonical handover is `.pi/renew-loop/<slug>/handover-<slug>.md`. **Never create a plain
`handover.md`, and never put one in a directory that does not name the work.** A generic name
collides with every other run in the same repo, and the collision is silent: the next session adopts
a stranger's state and reports progress that belongs to someone else's work.

Named in the request — including `/renew-loop continue from <path>` — → use that path and skip the
search. Otherwise look in all of these, and do not stop at the first hit, because knowing whether
there are two is the point:

1. `.pi/renew-loop/<slug>/handover-<slug>.md` — the canonical path
2. `<task-list-dir>/handover-<slug>.md`
3. legacy paths from before this rule, which are **adopted and then moved**, never written to:
   `.pi/loop/<slug>/handover.md`, `.pi/loop/handover.md`, `<task-list-dir>/handover.md`

A candidate **validates only if it is about this work**: its `Work:` line names the same task list or
goal, or — for one written before that line existed — its own text plainly refers to it. A handover
naming *different* work belongs to another run: skip it, never merge the two, and never adopt one
whose subject you cannot confirm either way.

- **Exactly one validates** → adopt it, and add the `Work:` line if it has none. If it sits at a
  legacy path, move it — with anything beside it this run wrote — to the canonical path in this same
  turn (`git mv` where they are tracked), and say so in your first report line.
- **Several validate** → **stop and ask which.** Two live handovers for one piece of work is exactly
  the ambiguity this protocol never guesses at. Make the answer cheap: list them with their
  last-modified time and the turn each records, and recommend one.
- **None validates** → create the canonical path, with its `Work:` line first.

**Adopting one that stopped mid-turn.** A handover whose last turn is unfinished belongs to a session
that died. Do not start a turn *over* an interrupted run's uncommitted diff: discard that partial work
first (a killed run is discarded and re-run from clean, never resumed), or stop and ask if you cannot
tell which changes were its.

Either way, **name the path in your first report line, and say whether you adopted, created or moved
it.** A discovered path the user did not expect costs one sentence to mention and a debugging session
to find later.

### What the handover holds

Rewrite it at the end of every turn. It is written for a reader with no memory of this session:

```
Work:        <the task list path, or the goal in one line>
Slug:        <the slug, fixed on turn 1>
Mode:        <plain | brief-and-review>  ·  Turn: <n> of <budget>
Runner:      <brief-and-review only: subagent tool | pi-subagent skill | this session>
Stop when:   <the stop condition, or "the task list is empty", or "the budget">
Next:        <the one concrete thing the next turn does first>

## Progress
<what this turn changed, as facts — files, commits, checks run and their result>

## Open
<what is left; for a task list, which units are still open right now — the no-progress
 guard has nothing to compare against next turn otherwise>

## Decisions pending
<anything you deferred rather than guessed at, with the options>

## Notes
<gotchas the next turn would otherwise rediscover>
```

### Making a task list tickable

Progress lives in the task list, and the only progress the next turn can see is a marker in the file.
Check it once, on the first turn of a run:

- **It already has markers** — `- [ ]` / `- [x]` checkboxes, or whatever "done" is in this file's own
  format — → use them as they are. Never convert one convention to another; a list that is already
  tickable is not yours to reformat.
- **It has units but no markers** — numbered or bulleted lines that each name a piece of work — → add
  a `- [ ]` checkbox to each unit line and change nothing else: no re-wording, no re-ordering, no
  re-grouping. Commit that on its own before the first unit (`chore: add checkboxes to <file>`), and
  name it in your report.
- **It is prose, not a list** — a plan or spec whose steps are headings or paragraphs → transcribe
  the steps **the document itself names** into `.pi/renew-loop/<slug>/tasks-<slug>.md`, one `- [ ]`
  each, in the document's own order, each line pointing back at the section it came from. Transcribing
  is not authorship: a step the document does not name does not go in. Record it in the handover as
  the task list and work from it. If the document names no steps at all, work from the goal and keep
  the plan in the handover's `## Open` instead.

## Step 3 — The turn

1. **Read the handover** — and only what it points at. The restart destroyed the previous turn's
   context on purpose; re-reading the tree to rebuild it spends what the restart bought. If the
   handover is not enough to act on, that is a defect in the *last* turn's handover: fix the handover
   as this turn's work, say so, and continue.
2. **Do one turn's work.** One unit from the task list — the one the request orders explicitly,
   otherwise the first still open in the list's own order — or the one step the handover's `Next:`
   line names. Never more than one per turn: the point of the loop is that each turn is small enough
   to hold in a clean context.
3. **Check it.** Run whatever the work has — the test, the build, the linter, the request's own stop
   condition. A turn that reports success without running the check is the failure this protocol
   exists to prevent, because nothing later re-examines it.
4. **Close the unit** in the task list, where there is one — tick its checkbox. Nothing else does
   this, and the exit test and the no-progress guard both read it. With no task list, the handover's
   `## Open` section is what they read instead, so keep it honest.
5. **Commit**, if the request asks for commits, with the task-list edit and the handover update in
   the same commit; push only if the request asks for that too.
6. **Rewrite the handover** to the shape above, with this turn's number and a `Next:` line that the
   next session could act on cold.

**A blocked turn is not automatically a stop.** First prove the blocker is not your own work:
reproduce it on something referencing none of this turn's changes, or on a clean tree, and name the
first failure in the chain — if that is your own code, it is a correctness finding and the loop stops.
Then ask whether the **shortest** correct repair changes a design decision, a public surface, a
dependency, a protocol or a test's strength. **None of them → repair it and carry on**, as its own
`fix:` commit before the turn's, re-running the check after. **Any of them → that is a decision: stop
and report it.** Record either outcome in the handover. Never take the third option of calling the
turn done against a reduced bar.

## Step 4 — Stop, or restart into the next turn

Check these in order, before doing anything else with the turn's result:

1. **Stop condition met** — the request's condition is satisfied, or the task list has no open unit
   left → stop and report completion. This is the ordinary way a run ends.
2. **Hard stop** — continuing would mean guessing the user's intent; a commit or push failed; the
   same step failed twice; a check is red for something you cannot repair without a decision → stop
   and report what you have and what blocks you.
3. **No progress** — nothing changed since what the last turn recorded in `## Progress`, and the task
   list is unchanged → stop and say so. This catches the failure that actually happens: a unit
   believed finished but never ticked, and a turn that keeps re-doing the same step. On a run's first
   turn there is nothing to compare against, so it passes.

   **A handover you adopted is a baseline, not a previous turn — but only once.** If the last turn
   recorded a hard stop, a blocker or a pending decision, that is an explanation rather than a stall:
   write `Resumed: <date> — after <that reason>` into the handover and take one turn. No recorded
   reason, or a `Resumed:` line already there with nothing closed since, means two consecutive turns
   produced nothing: stop and report it.
4. **Budget reached** — the provenance ordinal has reached the turn budget → stop and report that the
   budget is spent, naming the next step and how to continue (`/renew-loop continue from <handover>`,
   or the same request with a larger `max N turns`). Being out of budget is not failure; say so
   plainly rather than as an error.
5. **`ask` between turns** was requested → report the turn, name what the next one would do, and wait.
   When the user says to carry on, restart into the next turn as in 6 rather than continuing here: the
   fresh context is the point, and the restart ordinal is how the budget is counted.
6. **Otherwise, restart.** Call `delegate_to_agent` with:
   - `reason` — `renew-loop-turn`.
   - `strategy` — always `new-session`, passed explicitly. Never omit it and never pass `compact`:
     `compact` does not replay a registered delegate context, so the fresh context would get a bare
     continuation notice and the loop would die after this turn.
   - `summary` — the tool's structured summary (Goal, Constraints & Preferences, Progress, Key
     Decisions, Next Steps, Critical Context) for the turn that just finished.
   - `nextSteps` — read the handover at `<path>` and do what its `Next:` line says.

**High-context variant.** If the extension's high-context reminder fires mid-turn, that is not your
decision to restart — follow the reminder instead: stop work, write a complete handover including its
`Next:` line, then call `delegate_context_high` with `handoverPath` pointing at that file. Do not call
`delegate_to_agent` for this path; `delegate_context_high` calls it internally with the right reason
and nextSteps. A turn cut short this way still counts against the budget.

## No-restart mode

Selected by the request, or forced by Step 1 when `set_delegate_context` is unavailable. Run the turns
in sequence in one session, with no `delegate_to_agent` call of your own, still stopping on the same
conditions and the same budget — counted here from the handover's `Turn:` line, since there is no
restart ordinal to read. Write the handover every turn anyway — it is the record of what
happened, not restart bookkeeping — and be aware that the context you were supposed to shed is still
with you: keep each turn's reading as tight as if it were about to be thrown away.

If the high-context reminder fires anyway, follow it: write the handover and call
`delegate_context_high`. It restarts the session even though nothing else here does — it is the
extension's safety net, and not optional because the request asked for no restarts.

## Opt-in: brief-and-review mode

**Turn it on by asking for it** — "apply and review", "apply with review", "apply with subagent
review", "brief and review each unit", "delegate each unit to a sub-agent", "review each unit before
committing". Any request that asks for the work to be *applied and reviewed*, rather than just done,
is asking for this mode. Reach for it when the work has acceptance criteria you are asked to verify,
when each unit should land as its own reviewable commit, when the units are large enough that
analysing and executing one in the same context degrades both, or when the run is unattended and
nothing else will check the result. The plain loop is the
default because most work does not need this; this mode costs a restart and two sessions per unit.

**What changes: one unit takes two turns.** Both count against the same budget, so a budget of 10 is
five units here. Everything else — registration, the handover, the bounds, the stop conditions,
No-restart mode — is unchanged.

**First, find the runner.** This mode delegates each unit, so before the first brief, look for one —
in this order, and take the first that is actually there:

1. a **`subagent` tool** (from `pi-subagents`) → run units with `agent: "worker"`, and a `reviewer`
   child is available as a second opinion on the diff;
2. the **`pi-subagent` skill** (`/skill:pi-subagent`) → run each unit as a one-shot child process;
3. **neither** → run the unit **in this same session**, from the brief, under the same restricted
   reading. The mode is not cancelled by the absence of a runner: the brief, the reviewer notes and
   the two-turn split are what it is for, and they all still happen. What you lose is the executor's
   context isolation, so keep the reading tight.

Record which one you found in the handover (`Runner: subagent tool` / `pi-subagent skill` / `this
session`) and name it in the turn's report, so a run that fell back is visible rather than
mysterious.

### The analyse half

1. Run Step 4's checks 1–4 first. A stop takes priority over starting a unit.
2. Select exactly **one** open unit.
3. **Size it** — T0 mechanical, T1 local, T2 behavioural, T3 stateful/protocol — and put the tier and
   the checks it selects and rules out at the top of the brief. The tier reaches the execute half in
   the brief; nothing else carries it across the restart.
4. **Write the brief** — `/skill:subagent-brief` where that skill is installed, otherwise yourself,
   to the outline below.
5. **Write the reviewer notes** — `/skill:subagent-review`'s criteria where installed, otherwise the
   outline below — at the depth the tier selects. Name the checks you are deliberately not asking
   for, with the reason: a check skipped silently and a check forgotten look identical next turn.
6. Update the handover: `Mode: brief-and-review`, the unit, its tier, the brief and notes paths, the
   units still open, and `Next: execute <unit>`.
7. Restart with `reason: renew-loop-analysis` — same call shape as Step 4.6 otherwise.

Write the brief and notes beside the handover as `brief-<unit-slug>.md` and `review-<unit-slug>.md`,
slug from the unit's number or title (`5.4` → `5-4`). The handover's directory already carries the
work's name, so these two do not repeat it.

**The outlines**, for when the skills are not installed — they are the executor's input and the
review's yardstick, not skill bookkeeping, so they get written either way:

- **The brief** — the unit and its tier; exactly what to change and what not to; the files it may
  touch; the source documents to read first (pointed at, never restated); the decisions already fixed,
  so the executor invents none; the checks that must pass; and what its report back must say.
- **The reviewer notes** — what "done" means for this unit, in checkable statements; the checks to
  re-run yourself rather than believe; the specific ways this unit could be wrong while its tests stay
  green; and the checks you are deliberately not asking for, with the reason.

### The execute half

1. Read the handover.
2. Read the brief.
3. **Run the unit**, immediately, in the runner the handover's `Runner:` line names — no further
   reading, no re-deriving context from the task list or the source tree:
   - `subagent` tool → call it with `agent: "worker"` and the brief as the task;
   - `pi-subagent` skill → launch the one-shot child asynchronously;
   - this session → implement it yourself, from the brief. The restricted reading is *not* relaxed
     here: it is what the restart bought. If the brief is not enough to implement from, that is a
     defect in the brief — record it in the handover and re-analyse rather than reading around it.

   Re-probe only if that runner is gone; a runner that appears or disappears between turns changes
   this line and nothing else.
4. Wait for the result within this same turn.
5. **Only now** read the reviewer notes — before the unit ran there was no diff for them to check.
6. Review the diff against them — **the diff first, any report second**. A report maps where its
   author thinks the work is; reading it first anchors you there, and the defects are where it did not
   look. Where a `subagent` tool exists, a `reviewer` child is a useful second opinion — an addition
   to your own review of the diff, never a replacement for it.
7. Minor findings — fix them here. Major findings — write a new brief for what remains and run the
   unit again (back to 3). The **same unit escalating twice is a hard stop**.
8. **Blocked?** Step 3's repair rule decides it, in full: prove the defect is pre-existing, take the
   shortest correct repair if it changes no design, stop and ask if it would. The repair may live
   outside the unit's allowed files — files belong to units, the design belongs to the spec — and
   lands as its own `fix:` commit *before* the unit's. Record it in the handover.
   `IMPROVEMENT-BUDGET.md` in `subagent-brief` carries the same rule at length where that skill is
   installed.
9. **Triage the improvements** — anything *better* rather than *wrong*:
   **🟢** behaviour-preserving, inside the brief's allowed files, ≤ ~15 net lines, no exported
   signature or dependency change, existing tests unchanged → apply it, and commit it **separately**
   from the unit, re-running the check after.
   **🟡** bigger, a new abstraction, a shared helper, a test's intent → record it in the handover with
   a sketch; do not start it.
   **🔴** would change a fixed decision, the public surface, a dependency or the protocol → never
   applied in the turn. Put it in `## Decisions pending`, name it in your report line, and carry on — an
   opportunity is never on the unit's critical path, so deferring one cannot make the unit wrong. A
   correctness finding, an ambiguity about intent, or a second escalation still stops the loop.
10. Tick the unit, update the handover, and commit as in Step 3 — a 🔧 repair its own commit before
    the unit's, a 🟢 improvement its own after it, so the unit's diff stays reviewable as the unit.
11. Then Step 4: stop, ask, or restart into the next unit's analyse half.

Steps 1–5 are a rule about *order*, not just about which files get read: reviewer notes read earlier
bias how the unit's task is framed instead of judging the result, and anything read beyond the
handover and brief before running it re-derives what the brief exists to carry.

## Other optional lanes

Probe for these only where they apply; never install, configure or ask for anything to fill a gap.
Degrade, and say which lane you took — the handover's `Notes` is the place.

| Lane | Present when | Then | Otherwise |
|---|---|---|---|
| **child runner** | a `subagent` tool, or `/skill:pi-subagent` | brief-and-review looks for it first and records what it found; the plain loop uses it only if the request asks to delegate the work | do the turn's work in this session |
| **brief / review skills** | `/skill:subagent-brief`, `/skill:subagent-review` | brief-and-review uses them | the outlines above |
| **OpenSpec** | `openspec --version` answers — or `npx openspec --version`, for a project-local install — and the repo has an `openspec/` directory | `openspec show <change>` / `status --change <change>` to resolve the change; `validate <change> --strict` in the check when a unit touches the spec delta; `archive <change>` **only if the request asked**, after the stop condition is met, as its own commit | the task list is a plain markdown checklist and the spec files are ordinary files |

**A missing tool is never a hard stop.** The one absence that changes the run is
`set_delegate_context`, and that selects No-restart mode rather than stopping.

## The final report

Produce a full result report only when the request asked for one. Otherwise end with a short
completion statement: what the run did, how many turns it spent, and why it stopped — the stop
condition, a hard stop, the no-progress guard, or the budget.

Either way, your final reply in this turn **is** the report. There is no other channel; the handover
is for the next session, not for the user.
