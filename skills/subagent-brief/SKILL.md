---
name: subagent-brief
description: >-
  Write a delegation brief a cold-start sub-agent can execute without rework, producing a diff you
  can actually review: the preflight sweeps, the tier that sizes how much verification the batch
  earns, the decisions to fix up front, the nine-section structure, the improvement budget, and the
  report contract. Runner- and language-agnostic — TypeScript, Java (Maven/Gradle), Python, shell.
  Triggers: "write a brief for the sub-agent",
  "delegate this task", "hand this task off", "prepare a delegation prompt".
---

# Briefing a sub-agent

A sub-agent starts **cold** and cannot ask a follow-up. Every ambiguity you leave becomes a silent
guess you discover in review, if at all. The brief's job is not to explain the task: it is to
**remove every decision the sub-agent would otherwise invent**, and to make the result checkable by
someone who was not there.

**State the precedence rule in every brief:** *the brief fixes decisions; the source documents carry
the detail.* Point at the task file and spec sections and require them to be read first. Never
restate their content — a restatement drifts and the sub-agent cannot tell which one wins.

Pair with `subagent-review` (verifying what comes back) and [REPORT-CONTRACT.md](REPORT-CONTRACT.md)
(the seam between them). [VERIFICATION-MENU.md](VERIFICATION-MENU.md) decides how much checking this
batch earns; [IMPROVEMENT-BUDGET.md](IMPROVEMENT-BUDGET.md) decides what the sub-agent may improve on
its own authority. Rationale and failure stories: [README.md](README.md).

## Phase 0 — Size it, then preflight

**First, size the change.** Pick the tier from [VERIFICATION-MENU.md](VERIFICATION-MENU.md) Part 1 —
T0 mechanical, T1 local, T2 behavioural, T3 stateful/protocol — promoting on any single T3 marker
rather than averaging. The tier decides which checks the brief demands and which the review will run,
and writing it down is the only thing that makes a skipped check auditable later.

Then the six sweeps. At **T0** most collapse to nothing, but run the staleness sweep anyway — a
documentation batch describing something that already shipped is the commonest T0 defect. At **T1 and
above, run all six.** Do not skip one because the task document looks complete: task documents are
written before the work runs, and the ground moves under them.

1. **Staleness sweep.** Grep for every symbol, file, flag and export the task tells the sub-agent to
   create: `grep -rn "<SymbolTheTaskAsksYouToCreate>" <source-roots>`. Anything that already exists
   is **not scope** — say so explicitly ("the task file lists this; it shipped earlier; that part is
   stale; do not touch these files") and move those paths to the do-not-touch list.
2. **Absence sweep.** Anything you add that a system enumerates, seeds, validates or registers
   invalidates tests written around its absence: `grep -rn "<the-thing-about-to-exist>"
   <test-roots>`. Every hit asserting non-existence is a **deliverable of its own**, with its
   correct new expectation stated in the brief.
3. **Baseline capture.** Run the gate yourself on a clean tree and record every number **next to the
   exact command that prints it**. Fill in [GATE-PROFILE.md](GATE-PROFILE.md) once per project and
   reuse it.
4. **Tooling probe.** If the task depends on how an external tool behaves (exit codes, output shape,
   ordering, what it writes where), prove it in a temp directory and turn the result into a fixed
   decision. Watch for pipelines that mask what you are probing — a probe piped through another
   command reports *that* command's exit code.
5. **Baseline artifacts.** If the deliverable is an identity, equivalence or "behaviour preserved"
   proof, **you** produce the "before" side: `git show HEAD:path/to/file > /tmp/<task>/before.<ext>`.
   Put the comparison command in the brief **verbatim** and ask for its output, not for a claim that
   it passed.
6. **Open-question sweep.** Write down every question the task document leaves open; each becomes an
   entry in the fixed-decisions section **with its reason**, so the sub-agent can extend the
   decision to a case you did not foresee.

## Phase 1 — Decisions to fix up front

| Category | Fix in the brief | Why it fails otherwise |
|---|---|---|
| **Identity literals** | Exact slug, display name, export names, file paths, any description or label **byte-for-byte** | A near-miss name compiles, passes, and breaks a consumer matching on the string |
| **User-visible strings** | The **complete line you want emitted**, not the value substituted into it | A fallback specified as its substituted value gets emitted without its sentence |
| **Duplicate vs. share** | Whether to copy a literal/table or factor a helper, and why | Both are defensible; you will disagree in review |
| **Absent vs. present-but-disabled** | "Absent, with no path to enabling it" **and how to assert it** — on the set of things that exist, not on a disabled flag | A disabled-flag assertion passes while the thing is still reachable |
| **Invalidated tests** | Name each one and state the correct new expectation | "Make it pass" has a cheap solution: delete the assertion |
| **Fixtures that could be green for the wrong reason** | Require orderings to *disagree*, values to *differ*, identifiers to be unique | A fixture where two orderings coincide passes either way |
| **Mapping / transformation rules** | One worked example with concrete values, in full | Spec prose describes the rule; the sub-agent needs one instance of the output |
| **Test setup shortcuts** | Name the shortcut that reaches the state under test | Otherwise it brute-forces a long path, or tests something adjacent |
| **Frozen areas** | Name generated code, contracts, fixtures, snapshots — and forbid regeneration | Regeneration produces an enormous diff that hides the real change |
| **Ownership** | Who owns git history and index, plan/tracking documents, changelogs | See the git constraint below |
| **What "done" measures** | Which numbers are the gate, by which exact command | An unqualified number invites a wrong measurement and a phantom discrepancy |
| **Verification depth** | The tier, and the checks it selects for each part — including the ones you are deliberately not asking for | Left open, the sub-agent either gold-plates a trivial part or under-proves the risky one, and you cannot tell which from the report |
| **Improvement authority** | Which lane applies (green/amber/red) and that green improvements land as a separate hunk | Otherwise a cleanup arrives inside the functional diff and the review surface is two changes at once |

**Word the git constraint precisely** — "do not run any git command" also blocks building a git repo
inside a temp test fixture. Use:

> Do not run any git command that touches this repository's history or index (`add`, `commit`,
> `checkout`, `stash`, `push`, `reset`, `restore`). Read-only `git status` / `git diff` / `git show`
> are fine, and creating a git repo inside a temp-dir test fixture is fine. The caller owns git.

Expect it to be crossed anyway. It is a constraint, not an enforcement mechanism — which is why
review works on the **diff**, not the report.

## Phase 2 — The brief

Use [BRIEF-TEMPLATE.md](BRIEF-TEMPLATE.md). The tier line from Phase 0 sits at the top; then nine
sections, in order:

1. **Task** — one line. Fold in any deferred debt from earlier work *explicitly*.
2. **Read these FIRST, before writing anything** — ordered, with section/line anchors, plus the
   precedence rule.
3. **Context** — repo shape, domain vocabulary, what earlier work left behind and what it did not.
   Enough that the reading list makes sense; no more.
4. **Design decisions ALREADY FIXED — do not re-litigate any of these** — numbered, each with its
   reason. The highest-leverage section in the document.
5. **What to build** — independently checkable parts, one per separable deliverable (implementation,
   invalidated tests, deferred coverage, docs), each with its own checkboxes. Parts are what make a
   partial failure legible.
6. **Acceptance criteria** — "tick each only when a test you can name proves it", plus at least one
   **falsifiable numeric floor** ("more than N passing, 0 skipped"). The floor is the only thing
   proving the suite ran rather than being cached or silently empty. At T2+, include at least one
   **negative criterion** — something that must *not* happen — or the whole set describes only the
   happy path.
7. **Commands** — the gate, verbatim, with log paths. Include the gate profile's known trap
   signatures and say **"if you see this, report it rather than fixing it"**.
8. **Constraints** — the allowed-files table, the do-not-touch list, the git constraint, the
   anti-weakening clause, the improvement budget, house style, comment density.
9. **Report-back** — impose [REPORT-CONTRACT.md](REPORT-CONTRACT.md) by reference or by pasting it.

**The allowed-files table** lists every file the sub-agent may create or modify, plus: *"if you
become convinced another file must change, stop and report it instead of changing it."* It keeps the
task inside its blast radius and makes review start with one command: does `git status` match the
table?

**The anti-weakening clause** — required in any brief touching tests:

> Do not delete or relax an existing assertion, do not `.skip`/`.todo` a test, do not loosen a
> strict matcher to a permissive one, and do not substitute a wildcard where a literal belongs.
> If an existing test genuinely encodes now-obsolete behaviour, the only such tests are the ones
> named above — anything else you believe needs relaxing, report instead of changing.

**The verification plan** goes in *What to build*, one line per part, naming the checks that part
must satisfy and — just as usefully — the ones it need not. Take both lists from the menu's matrix.
Asking for a crash-consistency walk on a pure renderer wastes the run; leaving a T3 part with no
non-vacuity probe wastes the review.

> Part B is T1: assertion strength and a named kill-mutant per criterion. No coverage run, no
> determinism check, no crash-consistency walk — it is a pure function with no async and no state.

**The improvement budget** — required in any brief that is not T0:

> If you see something worth improving that is behaviour-preserving, inside the allowed-files table,
> under ~15 net lines, changes no exported signature and no dependency, and contradicts nothing this
> brief or the spec fixes — **apply it, at most one, as a separate clearly-labelled hunk**, and say
> so in your report. Anything larger, anything touching a shared helper or a test's intent, and
> anything that would change a fixed decision, the public surface, a dependency or the protocol:
> **report it with a sketch, do not do it.** Full lanes: `IMPROVEMENT-BUDGET.md`.

## Phase 3 — Set up for review before you launch

- **Keep the run's log** at a known path — a run that completes but loses its answer is otherwise
  unrecoverable.
- **Leave the tree uncommitted.** The diff is the review surface.
- **Do not let it edit tracking documents** — plan files, checklists, handover notes are yours to
  tick *after* review.
- **Budget for the shape of the run, not its tool count.** A long opening read, then a large silent
  reasoning pass with an empty tree, then files landing fast, then gate iteration. A frozen tool
  counter with a growing transcript is not a hang — check transcript byte growth.
- **Discard a killed run's partial work**, never resume it: revert modified files, delete new ones,
  re-run from clean.

## Anti-patterns

- **Restating the spec in the brief** — two sources of truth, and the sub-agent cannot tell which wins.
- **Acceptance criteria describing the implementation** instead of an observable outcome — it will
  satisfy the description and you will have no test.
- **"Make the tests pass"** — always name the correct new expectation.
- **No numeric floor** — then "all tests pass" covers a suite that never ran.
- **Leaving a decision open because "either is fine"** — a coin flip in the brief is free; in the
  diff it costs a review cycle.
- **Assuming the task document's scope is current** — run the staleness sweep.
- **Briefing every batch at the same depth** — a T0 documentation batch asked for kill-mutants and
  coverage burns the run; a T3 protocol batch asked for neither ships a defect a green suite cannot
  see. Size it, then choose.
- **Leaving improvement authority unstated** — the sub-agent either folds a cleanup into the
  functional diff, or drops a real one because nobody said it could act.

## When it comes back

Hand off to `subagent-review`: re-run the gate yourself, diff the allowed-files table against
`git status`, and read the diff for what the acceptance criteria **did not** ask about — at the depth
the tier selected, and with the improvement lanes triaged rather than accepted.
