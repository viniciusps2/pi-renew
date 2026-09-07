---
name: renew-loop-brief-and-review
description: >-
  The two-turn procedure for `/renew-loop`'s opt-in **brief-and-review** mode: find the runner, split
  one unit into an analyse turn and an execute turn, and review the diff before the unit is ticked.
  Load it at the top of every turn of that mode, or when the user names it outright — never on its own
  initiative for an ordinary delegation or review request.
---

# brief-and-review: one unit, two turns

`/renew-loop` selected this mode. Everything in the protocol still holds — registration, the handover,
the bounds, the stop conditions, No-restart mode. This file carries only what the mode adds.

**Both turns count against the same budget**, so a budget of 10 is five units.

## Find the runner, once per turn

This mode delegates each unit, so before the first brief decide whether a **`subagent` tool** (from
`pi-subagents`) is available. Probe it by *calling* it — a `subagent`-* skill, or an entry in an MCP or
skills listing, does not prove the tool is loaded, and inferring "no runner" from either silently
loses the executor's context isolation:

    subagent({ action: "list" })

- **Returns an agent roster** (`worker`, `reviewer`, …) → the tool is present. Run each unit on **one**
  `subagent` call per **The runner contract** below; a `reviewer` child is available as a second
  opinion on the diff.
- **Unavailable or errors** → **no runner**: run the unit **in this same session**, from the brief,
  under the same restricted reading. The mode is not cancelled by the absence of a runner — the brief,
  the reviewer notes and the two-turn split are what it is for. What you lose is the executor's
  context isolation, so keep the reading tight.

Record which you found in the handover (`Runner: subagent tool` / `this session`) and name it in the
turn's report, so a run that fell back is visible rather than mysterious. Re-probe only if a previous
turn's runner is gone.

**Delegation runs exactly one level deep.** This session is the only thing that calls `subagent`, and
only to launch a `worker` (and optionally a `reviewer`). A child is a **leaf**: it does the unit,
reports back, and never calls `subagent` again. Every child is launched in **fresh context** — it sees
the brief and the project, never this session's conversation — and inherits this session's `subagent`
tool, so every brief forbids further delegation outright, and the review checks it.

## The runner contract

Every delegated unit launches as **one** `subagent` call, with these defaults. Override a line only on
an explicit user request — never to save a step:

    subagent({ agent: "worker", task: <the brief>, context: "fresh" [, skill: "<name>"] })

- **Sync.** It is the **only** tool call in its turn. Issue it alone, wait for the child to return, and
  do nothing else until it does — no `read`/`bash`/… batched beside it.
- **Fresh.** `context: "fresh"`: the child is a cold leaf that knows the brief (and project context), not
  your conversation. The `worker`'s package default is a **fork**, so pass `"fresh"` explicitly; use
  `context: "fork"` only if the user asked the child to read your reasoning. A fork carries your in-flight
  calls into the child, where they resurface as orphans it wastes its first turn sorting out.
- **Not async.** Never pass `async: true` unless the user asked for a background/async subagent.
- **Skill.** Pass `skill: "<name>"` when the request names one (`with skill java`).

A `reviewer` second opinion obeys the same contract: fresh, its own turn, sync.

## The analyse half

1. Run `/renew-loop` Step 4's checks 1–4 first. A stop takes priority over starting a unit.
2. Select exactly **one** open unit.
3. **Size it** — T0 mechanical, T1 local, T2 behavioural, T3 stateful/protocol — and put the tier, the
   checks it selects and the checks it rules out at the top of the brief. Nothing else carries the
   tier across the restart.
4. **Write the brief** — `/skill:subagent-brief` where installed, otherwise the outline below.
5. **Write the reviewer notes** — `/skill:subagent-review`'s criteria where installed, otherwise the
   outline below — at the depth the tier selects. Name the checks you are deliberately not asking for,
   with the reason: a check skipped silently and a check forgotten look identical next turn.
6. Archive and rewrite the handover as `/renew-loop` Step 3.6 says: `Mode: brief-and-review`, the unit,
   its tier, the brief and notes paths, the units still open, and `Next: execute <unit>`.
7. Restart with `reason: renew-loop-analysis` — same call shape as Step 4.6 otherwise.

**If the analysis finds the plan itself defective** — the approach the handover recorded would fail the
unit's own acceptance criteria — that is Step 3's repair rule, not a stop by default. Prove it against
the design rather than a failing command, then run the same triage. Where it clears, the brief you
write is the corrected one and the correction lands as its own `fix:` in the execute half; where it
does not, stop with the options.

Write the brief and notes beside the handover as `brief-<unit-slug>.md` and `review-<unit-slug>.md`,
the slug from the unit's number or title (`5.4` → `5-4`). The handover's directory already carries the
work's name, so these two do not repeat it.

## The execute half

1. Read the handover.
2. Read the brief.
3. **Run the unit immediately**, in the runner the handover's `Runner:` line names — no further
   reading, no re-deriving context from the task list or the source tree:
   - `subagent` tool → **one** call, per **The runner contract** —
     `subagent({ agent: "worker", task: <the brief>, context: "fresh" })`, the only call in its turn;
     wait for the child before anything else;
   - this session → implement it yourself, from the brief. The restricted reading is *not* relaxed
     here: it is what the restart bought. If the brief is not enough to implement from, that is a
     defect in the brief — record it and re-analyse rather than reading around it.
4. Wait for the result within this same turn.
5. **Only now** read the reviewer notes — before the unit ran there was no diff for them to check.
6. Review the diff against them — **the diff first, any report second**. A report maps where its author
   thinks the work is; reading it first anchors you there, and the defects are where they did not look.
   A `reviewer` child, where one exists, is an addition to your own review of the diff, never a
   replacement.
7. Minor findings — fix them here. Major findings — write a new brief for what remains and run the unit
   again (back to 3). The **same unit escalating twice is a hard stop.** Every finding goes into this
   turn's `## Turn <n> record`: the ones you fixed, the ones you dismissed and why, and what the notes
   asked for that the diff answered. The review happens once, in a context about to be thrown away.
8. **Blocked?** `/renew-loop` Step 3's repair rule decides it in full: prove the defect is pre-existing,
   take the shortest correct repair if it changes no design, stop and ask if it would. The repair may
   live outside the unit's allowed files — files belong to units, the design belongs to the spec — and
   lands as its own `fix:` commit *before* the unit's, recorded as an `RP-` entry in `## Traps` with
   what it changed for the units not yet reached. `IMPROVEMENT-BUDGET.md` in `subagent-brief` carries
   the rule at length where that skill is installed.
9. **Triage the improvements** — anything *better* rather than *wrong*:
   **🟢** behaviour-preserving, inside the brief's allowed files, ≤ ~15 net lines, no exported signature
   or dependency change, existing tests unchanged → apply it, committed **separately** from the unit,
   with the check re-run after.
   **🟡** bigger, a new abstraction, a shared helper, a test's intent → record it in
   `## Carried improvements` with the sketch that makes it actionable; do not start it.
   **🔴** would change a fixed decision, the public surface, a dependency or the protocol → never
   applied in the turn. Put it in `## Decisions pending` as a `DP-` entry, index it with one line in
   `## Carried improvements`, name it in your report line, and carry on: an opportunity is never on the
   unit's critical path, so deferring one cannot make the unit wrong. A correctness finding, an
   ambiguity about intent, or a second escalation still stops the loop.
10. Tick the unit, archive and rewrite the handover, and commit + push as Step 3 says (push is default;
    opt out with "no push"). A 🔧 repair its own commit before the unit's, a 🟢 improvement its own
    after it, so the unit's diff stays reviewable as the unit.
11. Then Step 4: stop, ask, or restart into the next unit's analyse half.

Steps 1–5 are a rule about *order*, not only about which files get read: reviewer notes read earlier
bias how the unit's task is framed instead of judging its result, and anything read beyond the handover
and brief before running it re-derives what the brief exists to carry.

## The outlines, for when the brief and review skills are absent

They are the executor's input and the review's yardstick, not skill bookkeeping, so they get written
either way.

**The brief** — the unit and its tier; exactly what to change and what not; the files it may touch; the
source documents to read first (pointed at, never restated); the decisions already fixed, so the
executor invents none; the checks that must pass; **the constraint that it is a leaf — it may not
launch a sub-agent of its own, stated outright**; and what its report back must say.

**The reviewer notes** — what "done" means for this unit, in checkable statements; the checks to re-run
yourself rather than believe; the specific ways this unit could be wrong while its tests stay green;
and the checks you are deliberately not asking for, with the reason.
