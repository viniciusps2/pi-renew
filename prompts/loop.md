---
description: Analyse one unit of work, restart the context, then execute and review it — repeat over a task list.
argument-hint: <what to implement, optionally where the handover lives, and any options>
---

You are running the `/loop` protocol: drive a task list to completion one **unit** at a time —
analyse a unit, restart your context, then execute and review it. A unit is whatever one item the
request's task list points at (one checkbox, one task, one section). Never more than one per cycle.

Background, setup and troubleshooting live in `pi-renew/docs/pi-loop.md`. You do not need it.

## Your request

Read this in full before Step 0. It is the protocol's only source for what you were asked to do:

$@

Map it onto the parameters below by intent — there are no flags.

| Signal in the request | Parameter it fixes |
|---|---|
| a path to a checklist, tasks file, or spec section | the task list to read and update |
| a plan, an openspec change, or the directory holding one | the task list **inside** it — Step 1 resolves which |
| `handover <path>` (e.g. `.pi/loop/handover.md`) | where handover, brief and reviewer notes live |
| nothing about a handover | Step 1 finds the one this task list already has, or creates it |
| nothing about continuing | continuation `stop` — the default |
| "ask me…", "check in before…", "before each next unit" | continuation `ask` |
| "continue automatically", "keep going", "until … done" | continuation `auto` |
| "no context restart", "do everything in this session" | restart `none` — see No-restart mode |
| no such phrase | restart `new-session`, passed explicitly every time |
| "max N restarts" | the restart budget, checked against the provenance ordinal |
| "summarize the results", "report at the end" | produce The final report |
| nothing about a summary | no report — end with a short completion statement |

Never guess a missing parameter. Step 1 either resolves it by a rule that gives the same answer every
cycle, or stops and asks.

## Step 0 — Which phase am I in?

Look in the messages *preceding* this one — never in Your request — for the provenance line the
`pi-renew` extension inserts before this body:

```
[pi-renew restart #2 at 2026-08-24T18:04:11.921Z] reason: loop-analysis-complete
```

Match on whether the reason **contains** a value below, not on equality — it sits inside a longer
line. Note the ordinal (`#2`): Termination compares it to the restart budget.

| Reason contains | Enter |
|---|---|
| no such line, or nothing below matches | Step 1, then the analyse phase |
| `loop-analysis-complete` | the execute phase, directly |
| `loop-unit-complete` | the analyse phase, for the next unit |
| `context usage too high` | whichever phase the handover's `Phase:` line names |

Treat anything unrecognised as absent and re-analyse. That direction is deliberate: re-analysing is
recoverable, executing a unit nobody analysed is not.

## Step 1 — Register before doing anything else

Fresh invocations only. A continuing restart skips this step — the turn-1 registration still stands,
and re-registering only resets the restart counter Termination relies on.

Before reading the task list, the handover, or anything else:

- Call `set_delegate_context` with `context` set to the literal string `/loop ` followed by the
  request in Your request above, character for character — no paraphrase, no re-ordering, no
  tidying. This is what makes turn 1 crash-safe: a session lost before the first restart resumes by
  replaying that string. Normalizing it makes the loop drift once per restart.
- If `set_delegate_context` is unavailable, `pi-renew` is not loaded. Note that in the handover,
  run both phases in this one session regardless of what the request asked for (see No-restart
  mode), and say so plainly in your final message.

Registering first keeps even an under-specified request resumable while you resolve the rest of it.

Then resolve **where the work is**, and only then **where the state lives**:

- **The task list.** Named in the request → use it. A plan, an openspec change or a directory named
  instead → resolve the list inside it by convention: `tasks.md`, then `TASKS.md`, `plan.md`,
  `checklist.md`. Two of those present, or none, → stop and ask which. Nothing about work at all →
  stop and ask. **Never invent a task list**; it is the one parameter with no safe default.
- **The handover.** Named in the request — including `/loop continue from <path>` — → use it, and
  skip the search. Otherwise find it, below.

### Finding the handover

Search the same way every cycle. A restart replays the registered request verbatim, so a discovery
that is not deterministic hands the fresh session a different handover than the one the last phase
wrote — which loses the tier, the pending decisions and the no-progress baseline in one step.

Look in all three places — do not stop at the first hit, because knowing whether there are two is the
point:

1. `<task-list-dir>/handover.md`
2. `.pi/loop/<slug>/handover.md` — `<slug>` from the task list's own directory where that names the
   work (`openspec/changes/add-auth/tasks.md` → `add-auth`), otherwise from its filename
3. `.pi/loop/handover.md`

A candidate **validates only if it is about this task list**: its `Task list:` line names it, or —
for one written before that line existed — its own text plainly refers to this list or to units from
it. A handover naming a *different* list belongs to another run: skip it, never merge the two, and
never adopt one whose subject you cannot confirm either way.

- **Exactly one validates** → adopt it, and add the `Task list:` line if it has none.
- **Several validate** → **stop and ask which.** Two live handovers for one task list is the
  ambiguity Termination says never to guess at, and what would be lost by choosing wrong — progress,
  pending decisions, repairs — is the whole reason to adopt one at all. Make the answer cheap: list
  them with their last-modified time and the unit each names, and recommend one.
- **None validates** → create `.pi/loop/<slug>/handover.md`, with its `Task list:` line first.

**Adopting one that stopped mid-flight.** A handover saying `Phase: execute` belongs to a session
that died before its unit closed. Adoption never re-enters the execute phase — only a provenance line
does, and re-analysing is the recoverable direction — but do not re-analyse *over* an interrupted
child's uncommitted diff. Discard that partial work first (a killed run is discarded and re-run from
clean, never resumed), or stop and ask if you cannot tell which changes were its. Then analyse
normally.

Either way, **name the path in your first report line, and say whether you adopted or created it.**
A discovered path the user did not expect costs one sentence to mention and a debugging session to
find later.

## The analyse phase

1. Run the exit test and the no-progress guard (Termination). Either one stopping the loop takes
   priority — do not go looking for work until both pass.
2. Select exactly **one** open unit: the one the request orders explicitly, otherwise the first
   still open in the task list's own order.
3. Invoke `/skill:subagent-brief` to write that unit's delegation brief. **Size the unit first** —
   T0 mechanical, T1 local, T2 behavioural, T3 stateful/protocol — and put the tier, the checks it
   selects and the checks it rules out at the top of the brief. The tier travels to the execute
   phase in the brief; nothing else carries it across the restart. Read the handover's `## Repairs`
   entries against this unit before you size it: a 🔧 repair from an earlier cycle may already have
   done part of what the task document still describes as pending, which is scope the staleness
   sweep must catch and the brief must rule out explicitly.
4. Write reviewer notes for the unit, applying `/skill:subagent-review`'s criteria to what the brief
   asks for, **at the depth the tier selects**. Name the checks you are deliberately not asking for,
   with the reason — a check skipped silently and a check forgotten look identical next cycle.
5. Write or update the handover with: a `Task list:` line naming the list this handover belongs to
   (Step 1's search reads it back — without it, the next session cannot tell this handover from
   another run's, and will create a second one beside it), the unit you selected, its tier, the
   brief and reviewer-notes paths, which units the task list has open right now (the guard has
   nothing to compare
   against next cycle otherwise), any unresolved `## Decisions pending` entries and any `## Repairs`
   entries carried forward, and exactly one `Phase:` line — `Phase: execute` once all three documents are complete,
   `Phase: analyse` if you are restarting before they are.

Unless the request names other locations, write the brief and notes beside the handover as
`brief-<unit-slug>.md` and `review-<unit-slug>.md`, slug from the unit's number or title (`5.4` →
`5-4`).

Restart on whichever comes first: all three documents written (the normal case), or the
high-context reminder firing.

## The restart

Both phases hand off normally by calling `delegate_to_agent` with:

- `reason` — `loop-analysis-complete` from analyse; `loop-unit-complete` from execute under `auto`.
- `strategy` — always `new-session`, passed explicitly. Never omit it and never pass `compact`:
  `compact` does not replay a registered delegate context, so the fresh context would get a bare
  continuation notice and the loop would die after this phase.
- `summary` — the tool's structured summary (Goal, Constraints & Preferences, Progress, Key
  Decisions, Next Steps, Critical Context) covering the phase that just finished.
- `nextSteps` — one concrete first action for the fresh session (e.g. read the handover and brief
  for the pending unit, then launch the child).

**High-context variant.** If the extension's high-context reminder fires mid-phase, that is not your
decision to restart — follow the reminder instead: stop work, write a complete handover including
its `Phase:` line, then call `delegate_context_high` with `handoverPath` pointing at that file. Do
not call `delegate_to_agent` for this path; `delegate_context_high` calls it internally with the
right reason and nextSteps. Step 0 routes that reason by the `Phase:` line, so writing it correctly
is what makes this path resumable.

## The execute phase

1. Read the handover.
2. Read the brief.
3. Launch `/skill:pi-subagent` for the implementation child, immediately and asynchronously — no
   further reading, no re-deriving context from the task list or the source tree. The brief already
   carries everything the child needs.
4. Wait for the child's result within this same turn.
5. Only now read the reviewer notes — before the child ran there was no diff for them to check.
6. Review the diff against them — **the diff first, the child's report second**. The report maps
   where the child thinks the work is; reading it first anchors you there, and the defects are where
   it did not look.
7. Minor findings — fix them yourself in this turn. Major findings — write a new brief for what
   remains and launch another child (back to step 3).
8. **If the unit is blocked by something outside it** — the child reported it could not finish, or
   your own gate run is red for something the unit did not introduce — triage it through
   `IMPROVEMENT-BUDGET.md`'s **🔧 repair lane** before treating it as a hard stop. First *prove* the
   defect is pre-existing: reproduce it on something referencing none of the unit's code, or on a
   clean tree, and name the first failure in the chain — if that is the unit's own code you have a
   correctness finding, and the loop stops. Then ask whether the **shortest** correct repair changes
   a spec-fixed decision, the public surface, a dependency, the protocol, the spec delta, or a test's
   strength. **None of them → repair it yourself**, outside the allowed-files table and in other
   units' files if that is where it lives, as its own `fix:` commit *before* the unit's, re-running
   the gate after. **Any of them → that is a real decision: stop and report it, in every mode.** Two
   candidate repairs are a decision only when they *disagree about the design*; two spellings of one
   mechanical fix are not — take the narrower, and say which in the handover. Never take the third
   option of ticking the unit against a reduced bar: deferring a failing acceptance criterion is a
   decision even where the repair would not have been. Either way, record it in the handover as an
   `RP-` entry, naming which later units the repair changes.
9. **Triage the improvements** — anything *better* rather than *wrong*, from the child's report or
   your own reading, through the lanes in `subagent-brief`'s `IMPROVEMENT-BUDGET.md`:
   **🟢** behaviour-preserving, inside the allowed-files table, ≤ ~15 net lines, no exported
   signature or dependency change, existing tests unchanged, contradicts nothing the spec fixes →
   apply it and commit it **separately** from the unit's own commit, re-running the gate after.
   **🟡** bigger, a new abstraction, a shared helper, a test's intent → record it in the handover
   with a sketch; do not start it.
   **🔴** would change a spec-fixed decision, the public surface, a dependency, or the protocol →
   never applied in-phase. Under `stop`/`ask`, put it to the user with numbered options and a
   recommendation. **Under `auto`, do not stop**: append it to the handover's `## Decisions pending`
   section, name it in your report line, and carry on. An opportunity is never on the unit's
   critical path, so deferring one cannot make the unit wrong.
10. Close the unit in the task list — tick its checkbox, or whatever "done" is in that file's format.
    Nothing else does this, and both Termination checks depend on it.
11. Update the handover with what you found, any gotchas, next steps, any new `## Decisions pending`
    entry from step 9, and any `## Repairs` entry from step 8. Keep `Phase: execute` until the unit
    is committed.
12. Commit the unit's change, with the task-list edit and handover update in that same commit; push
    only if the request asks for it. A 🔧 repair from step 8 is its own commit **before** this one and
    a 🟢 improvement from step 9 its own commit **after** it — never folded in, so the unit's diff
    stays reviewable as the unit.

Steps 1–5 are a rule about *order*, not just about which files get read: reviewer notes read earlier
bias how the child's task is framed instead of judging the result, and anything read beyond the
handover and brief before launching re-derives what the brief exists to carry.

## Continuation modes

| Mode | Once the execute phase completes |
|---|---|
| `stop` (default) | The loop ends. No restart, no further unit. Report per The final report. |
| `ask` | Report what you did, name the next open unit, wait for the user's decision. |
| `auto` | Restart into analyse for the next unit (`loop-unit-complete`), subject to Termination. |

## Termination and bounds

Both checks run at the top of **every** analyse phase, before a unit is selected, in every
continuation mode — a manual `/loop continue from <handover>` can loop on a stuck unit exactly as an
unattended `auto` run can.

- **Exit test** — no open unit left in the task list → stop and report completion. This is the
  ordinary way the loop ends. The task list is the source of truth for what is done.
- **No-progress guard** — the task list is unchanged from what the previous cycle recorded in the
  handover → stop and report that no progress was made. This catches what the exit test cannot: a
  unit believed finished but never ticked, or a review that keeps re-opening the same unit. The
  handover is the source of truth for what happened. On a session's first analyse there is nothing
  to compare against, so it passes.

  **A handover Step 1 adopted is a baseline, not a previous cycle — but only once.** When you
  adopted one and the task list still matches what it recorded, read *why* the last cycle ended
  before stopping. A recorded hard stop, blocker or pending decision is an explanation: write
  `Resumed: <date> — after <that reason>` into the handover and continue, since the user resuming a
  loop they unblocked is the intended path. No recorded reason — or a `Resumed:` line already there
  with nothing closed since — means two consecutive cycles produced nothing: stop and report it.
  Without this the guard fires on every resume of a run that stopped *because* it closed no unit,
  which is the case most worth resuming.

**Hard stops.** Stop under any continuation mode, reporting what you have and what blocks you, when:

- continuing would mean guessing the user's intent — which unit, how to resolve a conflict, whether
  a finding is minor or major. Ask instead of choosing.
- the same unit escalates in review a second time;
- a child run fails;
- a commit or push fails;
- the provenance ordinal reaches the restart budget the request named (unbounded if it named none).

A **🔴 improvement opportunity is not a hard stop under `auto`** — the execute phase's step 9
defers it to the handover. That carve-out covers opportunistic improvements only: a correctness
finding, an ambiguity about intent, or a second escalation of the same unit still stops the loop in
every mode. If you are reaching for the carve-out to avoid stopping, what you are holding is not an
improvement.

**A blocked unit is not a hard stop until the 🔧 repair lane says so.** Step 8 is what decides that,
and it decides on one question only: *does the shortest correct repair change the design?* A
mechanical repair — the build, the wiring, a fixture, a registration another unit left broken — is
not a decision for the user, however far outside the unit's allowed files it lives, and the loop
repairs it and carries on. A repair that would change a spec-fixed decision, the public surface, a
dependency, the protocol or a test's strength **is** the decision, and the loop stops for it in every
mode. Files belong to units; the design belongs to the spec. Crossing a file boundary to unblock the
tree is bookkeeping. Crossing the spec to unblock the tree is the thing you must always stop for.

## No-restart mode

Selected by the request, or forced by Step 1 when `set_delegate_context` is unavailable. Run analyse
then execute in sequence in one session, with no `delegate_to_agent` call of your own. Still produce
all three documents — they are the child's input and the review's yardstick, not restart
bookkeeping.

What does not apply here: the execute phase's restricted reading (nothing destroyed the analysis, so
re-reading anything you already hold is fine); Step 0's phase table and the restart call shapes
(there is no provenance to read and no reason to emit); and the `Phase:` line as a resume point
(still write it — nothing reads it back).

If the high-context reminder fires anyway, follow it as above: write the handover and call
`delegate_context_high`. It restarts the session even though nothing else here does — it is the
extension's safety net, and not optional because the request asked for no restarts.

## The final report

Produce a full result report only when the request asked for one. Otherwise end with a short
completion statement: which unit closed, and why the loop stopped — continuation mode, a hard stop,
or the exit test.

Either way, your final reply in this turn **is** the report. There is no other channel; the handover
is for the next session, not for the user.
