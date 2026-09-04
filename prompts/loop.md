---
description: Analyse one unit of work, restart the context, then execute and review it — repeat over a task list.
argument-hint: <what to implement, where the handover lives, and any options>
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
| `handover <path>` (e.g. `.pi/loop/handover.md`) | where handover, brief and reviewer notes live |
| nothing about continuing | continuation `stop` — the default |
| "ask me…", "check in before…", "before each next unit" | continuation `ask` |
| "continue automatically", "keep going", "until … done" | continuation `auto` |
| "no context restart", "do everything in this session" | restart `none` — see No-restart mode |
| no such phrase | restart `new-session`, passed explicitly every time |
| "max N restarts" | the restart budget, checked against the provenance ordinal |
| "summarize the results", "report at the end" | produce The final report |
| nothing about a summary | no report — end with a short completion statement |

Never guess a missing parameter. Step 1 says what to do instead.

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

Then, if the request names no handover location or is empty, stop and ask for one. Do not invent a
path or a task list. Registering first keeps even an under-specified request resumable while you
wait.

## The analyse phase

1. Run the exit test and the no-progress guard (Termination). Either one stopping the loop takes
   priority — do not go looking for work until both pass.
2. Select exactly **one** open unit: the one the request orders explicitly, otherwise the first
   still open in the task list's own order.
3. Invoke `/skill:subagent-brief` to write that unit's delegation brief. **Size the unit first** —
   T0 mechanical, T1 local, T2 behavioural, T3 stateful/protocol — and put the tier, the checks it
   selects and the checks it rules out at the top of the brief. The tier travels to the execute
   phase in the brief; nothing else carries it across the restart.
4. Write reviewer notes for the unit, applying `/skill:subagent-review`'s criteria to what the brief
   asks for, **at the depth the tier selects**. Name the checks you are deliberately not asking for,
   with the reason — a check skipped silently and a check forgotten look identical next cycle.
5. Write or update the handover with: the unit you selected, its tier, the brief and reviewer-notes
   paths, which units the task list has open right now (the no-progress guard has nothing to compare
   against next cycle otherwise), any unresolved `## Decisions pending` entries carried forward, and
   exactly one `Phase:` line — `Phase: execute` once all three documents are complete,
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
8. **Triage the improvements** — anything *better* rather than *wrong*, from the child's report or
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
9. Close the unit in the task list — tick its checkbox, or whatever "done" is in that file's format.
   Nothing else does this, and both Termination checks depend on it.
10. Update the handover with what you found, any gotchas, next steps, and any new
    `## Decisions pending` entry from step 8. Keep `Phase: execute` until the unit is committed.
11. Commit the unit's change, with the task-list edit and handover update in that same commit; push
    only if the request asks for it. A 🟢 improvement from step 8 is its **own** commit, after this
    one — never folded in, so the unit's diff stays reviewable as the unit.

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

**Hard stops.** Stop under any continuation mode, reporting what you have and what blocks you, when:

- continuing would mean guessing the user's intent — which unit, how to resolve a conflict, whether
  a finding is minor or major. Ask instead of choosing.
- the same unit escalates in review a second time;
- a child run fails;
- a commit or push fails;
- the provenance ordinal reaches the restart budget the request named (unbounded if it named none).

A **🔴 improvement opportunity is not a hard stop under `auto`** — the execute phase's step 8
defers it to the handover. That carve-out covers opportunistic improvements only: a correctness
finding, a blocked deliverable, an ambiguity about intent, or a second escalation of the same unit
still stops the loop in every mode. If you are reaching for the carve-out to avoid stopping, what you are holding is not an
improvement.

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
