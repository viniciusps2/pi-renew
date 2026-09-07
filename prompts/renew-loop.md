---
description: Repeat a turn — do the work, write the handover, restart with a fresh context — until a stop condition or the turn budget.
argument-hint: <what to do each turn, when to stop, and any options>
---

You are running the `/renew-loop` protocol: repeat one **turn** of work until a stop condition is met
or the turn budget runs out. Each turn is its own session with a fresh context, and everything the next
turn needs is in a handover file — not in the conversation, which the restart throws away.

The default loop is plain: read the handover, do the next piece of work, record what happened, restart.
Sub-agents, skills and spec tools are opt-in, and the request is what turns them on. (Background and
troubleshooting are in `pi-renew/docs/renew-loop.md`; you do not need them.)

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
| `commit the handover`, `track the handover` | keep the run's state in git — by default it is ignored |
| `ask me between turns`, `check in each turn` | pause after each turn instead of restarting |
| `one turn only`, `do one unit and stop` | a budget of 1 |
| `no context restart`, `do everything in this session` | No-restart mode |
| no such phrase | restart `new-session`, passed explicitly every turn |
| `apply and review`, `apply with review`, `brief and review each unit`, `delegate each unit` | **brief-and-review mode** — opt-in, below |
| `summarize the results`, `report at the end` | produce the final report |
| nothing about a summary | no report — end with a short completion statement |

**Never guess a missing parameter.** Step 2 resolves it by a rule that gives the same answer every
turn, or stops and asks. The only safe defaults: budget **10**, plain mode.

A run needs at least one way to end — a stop condition, a task list that can empty, or both, with the
budget behind them. If the request gives none, say in your first report line that the budget alone
bounds the run.

## Step 0 — Which turn am I in?

Look in the messages *preceding* this one — never in Your request — for the provenance line the
`pi-renew` extension inserts before this body:

```
[pi-renew restart #2 at 2026-08-24T18:04:11.921Z] reason: renew-loop-turn
```

Match on whether the reason **contains** a value below, not on equality — it sits inside a longer
line. The ordinal (`#2`) is how many turns this run has spent; Step 4 checks it against the budget.

| Reason contains | Enter |
|---|---|
| no such line, or nothing below matches | Step 1, then Step 2 — a fresh run |
| `renew-loop-turn` | Step 2, then the turn — a continuing run |
| `renew-loop-analysis` | brief-and-review mode's **execute half**, directly |
| `context usage too high` | Step 2, then whatever the handover's `Next:` line names |

Treat anything unrecognised as absent and start a fresh turn from Step 2. That direction is
deliberate: repeating a turn's planning is recoverable, executing a unit nobody analysed is not.

## Step 1 — Register before doing anything else

Fresh runs only. A continuing restart skips this step — re-registering resets the restart counter the
budget is read from.

Before reading the handover, the task list, or anything else:

- Call `set_renewal_context` with `context` set to the literal string `/renew-loop ` followed by the
  request in Your request above, character for character — no paraphrase, no re-ordering, no
  tidying. A session lost before the first restart resumes by replaying that string; normalizing it
  makes the loop drift once per turn.
- If `set_renewal_context` is unavailable, `pi-renew` is not loaded. Note that in the handover, run in
  one session (No-restart mode) whatever the request asked for, and say so plainly in your final
  message.

## Step 2 — Resolve the work, the handover and the bounds

Every turn resolves these the same way: a restart replays the registered request verbatim, so a rule
that could answer differently on turn 4 than on turn 3 hands the fresh session someone else's state.

- **The work.** A path in the request → use it. A directory holding a plan or an openspec change →
  resolve the list inside it by convention: `tasks.md`, then `TASKS.md`, `plan.md`, `checklist.md`.
  Two of those present, or none → stop and ask which. A goal with no document at all is fine — the
  handover carries the plan instead. **Never invent a task list**: point at one, or work from the goal
  and record the steps in the handover.
- **The handover** — below. It is the only thing that survives the restart.
- **The bounds.** The stop condition and the turn budget (default 10). Write them into the handover on
  turn 1 and read them back from it afterwards, so a resumed run keeps the bounds it started with.
- **Make a task list tickable**, if there is one — below.
- **The restart primitive.** `set_renewal_context` and `renew_session` present → restart between
  turns. Absent → No-restart mode. That is the only capability the default loop cares about; the
  optional lanes are probed only in the modes that use them.

### Where the handover lives

**Every path this loop creates carries the work's name.** The slug is:

1. the task list's own directory where that names the work — `openspec/changes/add-auth/tasks.md` →
   `add-auth`;
2. otherwise the task list's filename stem — `docs/add-auth-plan.md` → `add-auth-plan`. Directory
   names that name no work (`tasks`, `task`, `docs`, `doc`, `plans`, `specs`, `.pi`, the repo root)
   fall through to this rule;
3. with no document at all, a short kebab-case slug from the goal (`get the e2e suite green` →
   `e2e-suite-green`), written into the handover on turn 1 and re-read from it afterwards rather than
   re-derived;
4. and if the canonical path already holds a handover for **different** work, extend the slug
   leftwards one path segment at a time (`add-auth` → `changes-add-auth`) until it is free.

The canonical handover is `.pi/renew-loop/<slug>/handover-<slug>.md`. **Never create a plain
`handover.md`, and never put one in a directory that does not name the work** — a generic name
collides silently with every other run in the repo, and the next session adopts a stranger's state.

**The state directory ignores itself.** The first time you create `.pi/renew-loop/` — or find it
without one — write a `.gitignore` there whose only line is `*`; it covers the subtree and itself, so
the handover, its archives, the briefs, the notes and any transcribed task list stay out of the index.
Do not stage it, and never `git add -f` anything beneath it. Two exceptions: a directory the request
named itself (use it as given, add nothing to it), and a request to **track** the state (`commit the
handover`) — no `.gitignore`, and the handover rides in the turn's commit.

Named in the request — including `/renew-loop continue from <path>` — → use that path and skip the
search. Otherwise look in **both** of `.pi/renew-loop/<slug>/handover-<slug>.md` and
`<task-list-dir>/handover-<slug>.md`, and do not stop at the first hit: knowing whether there are two
is the point. A `handover-<slug>-old-<n>.md` is an **archive** this run wrote — never a candidate: do
not adopt it, write to it, or count it among the candidates.

A candidate **validates only if it is about this work**: its `Work:` line names the same task list or
goal, or its text plainly refers to it. One naming *different* work belongs to another run — skip it,
never merge the two, and never adopt one whose subject you cannot confirm.

- **Exactly one validates** → adopt it, adding the `Work:` line if it has none.
- **Several validate** → **stop and ask which** — this is the ambiguity the protocol never guesses at.
  List them with their last-modified time and the turn each records, and recommend one.
- **None validates** → create the canonical path, with its `Work:` line first.
- **The one you adopt stopped mid-turn** → its session died. Do not start a turn *over* an interrupted
  run's uncommitted diff: discard that partial work first, or ask if you cannot tell which changes
  were its.

**Name the path in your first report line, and say whether you adopted or created it.**

### What the handover holds

Rewrite it at the end of every turn, for a reader with no memory of this session:

```
Work:        <the task list path, or the goal in one line>
Slug:        <the slug, fixed on turn 1>
Mode:        <plain | brief-and-review>  ·  Turn: <n> of <budget>
Runner:      <brief-and-review only: subagent tool | this session>
Stop when:   <the stop condition, or "the task list is empty", or "the budget">
Next:        <the one concrete thing the next turn does first>
Archive:     <the newest handover-<slug>-old-<n>.md — the turn before this one; empty on turn 1>

## Progress
<facts — files, commits, checks run and their result. The last turn or two in detail;
 earlier turns one line each, since the archives hold their narrative>

## Open
<what is left; for a task list, which units are open right now — the no-progress guard
 has nothing to compare against next turn otherwise>

## Decisions in force
<D-<n>: decisions that still constrain what comes next — the choice, the reason, what it
 rules out. A decision the next turn cannot see, it re-litigates>

## Decisions pending
<DP-<n>: what you deferred rather than guessed at — options, recommendation, and what
 deferring costs. A deferred 🔴 improvement is a DP entry too>

## Carried improvements
<🟡 proposals with the sketch that makes them actionable, and one line per 🔴 pointing at
 its DP entry: what would change, where, and why this turn did not do it>

## Traps
<what not to re-attempt and why, what looks wrong but is deliberate, what bit the last
 turn, and RP-<n> repairs whose reason still applies — each with what it changed for the
 units not yet reached>

## Notes
<conventions, commands, paths, environment — anything else the next session needs>
```

**Every section, every turn.** One with nothing in it keeps its heading and says `— none`: a heading
that says "none" proves the turn considered it, a missing heading is indistinguishable from a
forgotten one. `D-`, `DP-` and `RP-` numbers run for the life of the run and are never reused.

### Record, archive, rewrite — three moves, in this order, every turn

1. **Finish the outgoing handover.** Append a `## Turn <n> record` to the file you are about to
   archive — this turn's narrative, which nothing else keeps: what you did and in what order; what you
   tried that did not work and why you abandoned rather than fixed it; every review finding with its
   verdict and whether you fixed it; the repairs and improvements with the reasoning that placed them
   in their lane; the checks you ran and the output that decided them; and anything you believed at
   the start of the turn that turned out to be false. Written for someone reconstructing the run
   later, so it is the one place here where length is not a consideration. Write it while you still
   remember the turn.
2. **Archive it.** Move the file to `handover-<slug>-old-<n>.md` beside it, `n` one higher than the
   highest already there (`git mv` only in a tracked state directory). Never delete an archive, write
   into one after it has moved, renumber the existing ones, or adopt one as the handover.
3. **Write the new handover** at the canonical path, in the shape above, with an `Archive:` line
   naming the file you just moved.

The order is the mechanism: the record goes into the file that is **leaving**, and the move happens
before the new file exists. Nothing is measured or decided first — record, archive, write, on the turn
that stops the run and the turn cut short by the reminder as much as on any other. Turn 1 has nothing
to record or archive: create the handover and leave `Archive:` empty.

**The new handover is forward-looking, but it is not a summary.** Everything still acting on the next
session goes in at the length it needs: a 🟡 keeps its sketch, a decision its reason, a trap its
symptom and the command that produced it, a DP its options and recommendation. What stays out is the
narrative of finished work — the archives hold it, one `cat` away. **There is no line budget in either
direction.** The test is whether the next session, reading only this file, could act without
rediscovering what this turn already knew, and whether a line it reads would change what it does.

Archiving never consumes a unit and is never a reason to stop; a plain `mv` finishes it. Name the
archive in your report line whenever the handover came out noticeably shorter, so history you left
behind on purpose is not mistaken for state that went missing.

### Making a task list tickable

Progress lives in the task list, and the only progress the next turn can see is a marker in the file.
Check once, on the first turn of a run:

- **Already has markers** — `- [ ]` / `- [x]`, or whatever "done" is in this file's format → use them
  as they are. Never convert one convention to another.
- **Units but no markers** — numbered or bulleted lines that each name a piece of work → add a `- [ ]`
  to each unit line and change nothing else: no re-wording, no re-ordering, no re-grouping. Commit
  that on its own before the first unit (`chore: add checkboxes to <file>`) and name it in your report.
- **Prose, not a list** — a plan or spec whose steps are headings or paragraphs → transcribe the steps
  **the document itself names** into `.pi/renew-loop/<slug>/tasks-<slug>.md`, one `- [ ]` each, in the
  document's order, each pointing back at the section it came from. Transcribing is not authorship: a
  step the document does not name does not go in. If the document names no steps, work from the goal
  and keep the plan in the handover's `## Open`.

## Step 3 — The turn

1. **Read the handover** — and only what it points at. Re-reading the tree to rebuild the context the
   restart destroyed spends what the restart bought. If the handover is not enough to act on, that is
   a defect in the *last* turn's handover: fix the handover as this turn's work, say so, and continue.
2. **Do one turn's work.** One unit from the task list — the one the request orders explicitly,
   otherwise the first still open in the list's own order — or the one step `Next:` names. Never more
   than one per turn.
3. **Check it.** Run whatever the work has — the test, the build, the linter, the request's own stop
   condition. A turn that reports success without running the check is the failure this protocol
   exists to prevent.
4. **Close the unit** in the task list, where there is one — tick its checkbox. Nothing else does this,
   and the exit test and the no-progress guard both read it; with no task list they read `## Open`
   instead, so keep it honest. Anything you settled on the way that constrains a later unit — an
   interface, a convention, a direction ruled out — is a `D-` entry with its reason.
5. **Commit**, if the request asks for commits: the turn's work and the task-list tick. The handover
   and everything beside it are ignored, so they stay out — unless the request asked for the state to
   be tracked, in which case the handover update goes in the same commit. Push only if asked.
6. **Record, archive, rewrite**, as above, with a `Next:` line the next session could act on cold.

**A blocked turn is not automatically a stop.**

1. **Prove the blocker is not your own work**: reproduce it on something referencing none of this
   turn's changes, or on a clean tree, and name the first failure in the chain. If that is your own
   code, it is a correctness finding and the loop stops.
2. **Ask whether the *shortest* correct repair** changes a design decision, a public surface, a
   dependency or a protocol, or **weakens** a test — a deleted assertion, a loosened matcher, a
   `skip`, a simplified double. Replacing an assertion with an equal or stronger one is not a
   weakening.
3. **None of them → repair it** and carry on, as its own `fix:` commit before the turn's, re-running
   the check after. **Any of them → that is a decision: stop and report it.**

Record either outcome — a repair as an `RP-` entry in `## Traps`, a stop as a `DP-` entry in
`## Decisions pending` — and the reasoning in the turn record. Never take the third option of calling
the turn done against a reduced bar.

**Two cases look like neither.** A defect found *before* anything runs — the approach the handover
recorded cannot meet the unit's own criteria — is proved by naming the mechanism that would break and
the source that settles it instead of by a failing command; the triage is otherwise unchanged. And a
repair inside a unit **already ticked** leaves the tick alone, landing in front of the current unit as
its own `fix:`; where it changes that unit's assertions, read what fixed them first — pinned by a
brief or the design is a decision, merely recording the behaviour of the day is not.

## Step 4 — Stop, or restart into the next turn

Check these in order, before doing anything else with the turn's result:

1. **Stop condition met** — the request's condition is satisfied, or the task list has no open unit
   left → stop and report completion. This is the ordinary way a run ends.
2. **Hard stop** — continuing would mean guessing the user's intent; a commit or push failed; the same
   step failed twice; a check is red for something you cannot repair without a decision → stop and
   report what you have and what blocks you.
3. **No progress** — nothing changed since what the last turn recorded in `## Progress`, and the task
   list is unchanged → stop and say so. This catches a unit believed finished but never ticked, and a
   turn that keeps re-doing the same step. A run's first turn passes: there is nothing to compare
   against.

   **A handover you adopted is a baseline, not a previous turn — but only once.** If its last turn
   recorded a hard stop, a blocker or a pending decision, that is an explanation rather than a stall:
   write `Resumed: <date> — after <that reason>` into the handover and take one turn. No recorded
   reason, or a `Resumed:` line already there with nothing closed since, means two consecutive turns
   produced nothing: stop and report it.
4. **Budget reached** — the provenance ordinal has reached the turn budget → stop, say the budget is
   spent, and name the next step and how to continue (`/renew-loop continue from <handover>`, or the
   same request with a larger `max N turns`). Being out of budget is not failure; report it plainly.
5. **`ask` between turns** was requested → report the turn, name what the next one would do, and wait.
   When the user says to carry on, restart into the next turn as in 6 rather than continuing here: the
   fresh context is the point, and the restart ordinal is how the budget is counted.
6. **Otherwise, restart.** Call `renew_session` with:
   - `reason` — `renew-loop-turn`.
   - `strategy` — always `new-session`, passed explicitly. Never omit it and never pass `compact`:
     `compact` does not replay a registered renewal context, so the fresh context would get a bare
     continuation notice and the loop would die after this turn.
   - `summary` — the tool's structured summary (Goal, Constraints & Preferences, Progress, Key
     Decisions, Next Steps, Critical Context) for the turn that just finished.
   - `nextSteps` — read the handover at `<path>` and do what its `Next:` line says.

**High-context variant.** If the extension's high-context reminder fires mid-turn, that is not your
decision to restart — follow the reminder: stop work, do the record–archive–rewrite above (every
section, including `Next:`), then call `renew_from_handover` with `handoverPath` pointing at that
file. Do not call `renew_session` for this path; `renew_from_handover` calls it internally with the
right reason and nextSteps. A turn cut short this way still counts against the budget.

## No-restart mode

Selected by the request, or forced by Step 1 when `set_renewal_context` is unavailable. Run the turns
in sequence in one session with no `renew_session` call of your own, stopping on the same conditions
and the same budget — counted here from the handover's `Turn:` line, since there is no restart ordinal
to read. Record, archive and rewrite every turn anyway: it is the record of what happened, not restart
bookkeeping. The context you were supposed to shed is still with you, so keep each turn's reading as
tight as if it were about to be thrown away.

If the high-context reminder fires anyway, follow it: write the handover and call
`renew_from_handover`. It restarts the session even though nothing else here does.

## Opt-in: brief-and-review mode

**Turn it on by asking for it** — "apply and review", "apply with subagent review", "brief and review
each unit", "delegate each unit to a sub-agent", "review each unit before committing". Any request
that asks for the work to be *applied and reviewed* rather than just done is asking for this mode.
Reach for it when units carry acceptance criteria to verify, when each should land as its own
reviewable commit, or when the run is unattended and nothing else will check the result.

**What changes: one unit takes two turns**, both counting against the same budget — a budget of 10 is
five units. Registration, the handover, the bounds, the stop conditions and No-restart mode are
unchanged.

**The procedure is not in this file.** At the top of every turn of this mode, before Step 3, load
`/skill:renew-loop-brief-and-review` and follow it: the runner probe, the analyse half, the execute
half, and the outlines to fall back on when the brief and review skills are absent.

If that skill is not installed either, run the mode from this floor: analyse one unit and write a
brief (the unit, its T0–T3 tier, what to change and what not, the files it may touch, the sources to
read first, the decisions already fixed, the checks that must pass, that it is a leaf and may not
launch a sub-agent of its own, and what its report must say) plus reviewer notes (what "done" means in
checkable statements, the checks to re-run yourself rather than believe, the ways this unit could be
wrong while its tests stay green, and the checks you are deliberately skipping, with the reason);
restart with `reason: renew-loop-analysis`; then execute from the brief, review the diff against the
notes — **the diff first, any report second** — and finish the turn as Step 3 says.

## Other optional lanes

Probe for these only where they apply; never install, configure or ask for anything to fill a gap.
Degrade, and say which lane you took — the handover's `Notes` is the place.

| Lane | Present when | Then | Otherwise |
|---|---|---|---|
| **child runner** | a `subagent` tool | brief-and-review looks for it first and records what it found; the plain loop uses it only if the request asks to delegate the work | do the turn's work in this session |
| **brief / review skills** | `/skill:subagent-brief`, `/skill:subagent-review` | brief-and-review uses them | the outlines in `/skill:renew-loop-brief-and-review` |
| **OpenSpec** | `openspec --version` answers — or `npx openspec --version`, for a project-local install — and the repo has an `openspec/` directory | `openspec show <change>` / `status --change <change>` to resolve the change; `validate <change> --strict` in the check when a unit touches the spec delta; `archive <change>` **only if the request asked**, after the stop condition is met, as its own commit | the task list is a plain markdown checklist and the spec files are ordinary files |

**A missing tool is never a hard stop.** The one absence that changes the run is `set_renewal_context`,
and that selects No-restart mode rather than stopping.

## The final report

Produce a full result report only when the request asked for one. Otherwise end with a short
completion statement: what the run did, how many turns it spent, and why it stopped — the stop
condition, a hard stop, the no-progress guard, or the budget. Either way your final reply in this turn
**is** the report: the handover is for the next session, not for the user.
