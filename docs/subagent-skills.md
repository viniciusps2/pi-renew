# Why `subagent-brief` and `subagent-review` are shaped this way

Rationale for the two skills, and for `renew-loop-brief-and-review`, the mode that drives them. None of
it is needed to *use* them — the skills carry the rules, this file carries the reasoning. Read it when a
rule looks like overhead, or when you are deciding whether to skip one.

The skills themselves:

| File | What it is |
|---|---|
| [`skills/renew-loop-brief-and-review/SKILL.md`](../skills/renew-loop-brief-and-review/SKILL.md) | the two-turn procedure `/renew-loop` loads when the mode is on |
| [`skills/subagent-brief/SKILL.md`](../skills/subagent-brief/SKILL.md) | writing the brief, and the preflight that precedes it |
| [`skills/subagent-brief/BRIEF-TEMPLATE.md`](../skills/subagent-brief/BRIEF-TEMPLATE.md) | the nine-section brief, ready to fill in |
| [`skills/subagent-brief/REPORT-CONTRACT.md`](../skills/subagent-brief/REPORT-CONTRACT.md) | the report the sub-agent must return — the seam between the two skills |
| [`skills/subagent-brief/VERIFICATION-MENU.md`](../skills/subagent-brief/VERIFICATION-MENU.md) | which check earns its cost on which change, and the command for it per ecosystem |
| [`skills/subagent-brief/IMPROVEMENT-BUDGET.md`](../skills/subagent-brief/IMPROVEMENT-BUDGET.md) | 🟢 apply / 🟡 propose / 🔴 escalate, and the 🔧 repair lane |
| [`skills/subagent-brief/GATE-PROFILE.md`](../skills/subagent-brief/GATE-PROFILE.md) | per-project gate commands, baselines and trap signatures |
| [`skills/subagent-review/SKILL.md`](../skills/subagent-review/SKILL.md) | reviewing what came back |
| [`skills/subagent-review/REVIEW-CHECKLIST.md`](../skills/subagent-review/REVIEW-CHECKLIST.md) | the enumerated defect list, tagged by tier |

---

## The brief

### The preflight sweeps

Each sweep costs minutes and prevents a class of failure that is expensive or invisible later.

- **Staleness.** Letting the sub-agent discover mid-run that something already exists means it
  improvises: it may regenerate the thing, or "fix" a file that was already correct.
- **Absence.** Left as "make the suite green", the cheapest solution available to the sub-agent is to
  weaken the assertion. The result is green and wrong.
- **Baseline capture.** A baseline quoted without its command is ambiguous, and an ambiguous baseline
  makes the sub-agent report a discrepancy that does not exist — or miss one that does.
- **Tooling probe.** Five minutes proving an external tool's behaviour yourself is orders of magnitude
  cheaper than the sub-agent discovering it deep into a run and designing around a guess.
- **Baseline artifacts.** A sub-agent that generates both sides of a comparison proves nothing, and
  will report the self-comparison as a pass.
- **Open questions.** Each fixed decision needs its *reason*, because the reason is what lets the
  sub-agent extend the decision to a case you did not foresee instead of reverting to instinct.

### Why fixed decisions are the highest-leverage section

A task with a dozen pre-fixed decisions typically needs no rework on any of them. Every category in the
Phase 1 table is one where "the sub-agent will pick something reasonable" has already produced a review
cycle: a near-miss identity literal that compiles and breaks a string-matching consumer, a
disabled-flag assertion standing in for absence, a fixture whose two orderings coincide.

### Why the constraints are worded the way they are

**The git constraint** is precise because the blunt version ("do not run any git command") also blocks
legitimate work such as building a git repository inside a temp-dir test fixture — and a sub-agent that
reads it literally either stalls or ignores the whole constraint. Expect it to be crossed anyway.
Constraints in a brief are not enforcement, which is the reason review works on the diff rather than on
the report.

**The allowed-files table** keeps a task inside its blast radius even when an acceptance criterion's
wording could be read as licence to change something far away.

### Setting up for review

- **The log**: without a persisted transcript, a run that completes but loses its answer is
  unrecoverable, and you cannot reconstruct what the sub-agent read or decided.
- **The uncommitted tree**: a sub-agent that commits its own work forces you to review through history
  instead of `git diff`.
- **Tracking documents**: a ticked box in a document you did not write is an assertion you have not
  verified.
- **A killed run's partial work**: a half-written file from a dead run is the worst possible starting
  state for the next attempt.

### Why the sub-agent gets an improvement budget

Without one, a sub-agent that notices something worth fixing has two bad options: fold it into the
functional diff, where it destroys the review surface — you can no longer tell the feature from the
cleanup — or drop it, because nobody gave it authority. The budget makes the small, safe,
behaviour-preserving case explicit and cheap, and routes everything else to a person. The separate
commit is the load-bearing half: it is what keeps the batch's own diff reviewable as the batch.

---

## The report contract

Sections 3–6 of the contract exist because a green suite proves nothing about assertion strength, and
because a sub-agent's silent choices are otherwise invisible until they cause a bug.

| Section | The failure it exposes |
|---|---|
| 3, kill-mutant | An assertion too weak to see the bug it is supposed to catch. A criterion whose mutant cannot be named is self-identifying as vacuous, before the reviewer opens the diff. |
| 4, non-vacuity probes | Negative matchers that pass because the matcher silently does not apply to the value. Indistinguishable from a real pass by inspection; a positive control settles it in thirty seconds. |
| 5, decision log | Silent guesses. These are invisible in a green run and surface much later as "why is it like this?" |
| 6, deviation log | An override justified by a true premise but resolved in the wrong direction. Separating it from section 5 stops it being laundered as a gap-fill. |
| 2, verbatim output | Numbers recalled rather than read, and suites that did not actually run. |
| 8, review map | Reviewer attention spent uniformly across a diff instead of on the risky part — and the sub-agent usually knows which part that is. |
| 8, "prove it ran" line | A pass line from a suite that executed nothing — a cached task, a zero-collection run, a skipped module. |
| 9, improvements | A cleanup folded into the functional diff, so the review surface is two changes at once; or a real improvement dropped because nobody had authority to act. Splitting applied / proposed / escalated makes each one reviewable as what it is. |

**None of these make the report trustworthy.** They make it *checkable*. The verification still happens
in `subagent-review`, against the diff and a gate you re-run yourself.

---

## The review

### What it is actually looking for

Re-running the suite proves the acceptance criteria were satisfied. It says nothing about the space
just outside them, which is where delegated defects concentrate: an assertion too weak to see the bug
it was written for, and a decision the brief left open that the agent settled silently and presented as
settled. Phases 3 and 4 exist entirely to find those two.

### Why the scope applies beyond sub-agents

The same checks fit any agent-authored change — another session working in the same repo, a cloud
agent, a PR you did not write. What varies is only whether a report exists to audit; without one, every
section of the report contract is simply unanswered, and you run the checks with no map.

### Why the snapshot before mutating

The brief tells the sub-agent to leave the tree dirty so the diff is the review surface. That makes
`git checkout -- <file>` — the reflex revert — destroy the entire delegated change, because it reverts
to HEAD rather than to the state you are reviewing. The baseline you want lives in the working tree, so
the snapshot has to live outside git. If the work *is* committed, `git checkout --` is safe, but the
snapshot costs one command and removes the need to decide.

### Why lint is measured as a delta

A total tells you nothing: the interesting signal is one new warning in non-test source hiding among a
dozen innocuous house-style ones in test code. Only stash-measure-restore separates them.

### Why the review is sized before it starts

The checks are not free, and a review that costs more than the work it checks is a sizing error rather
than diligence. The tier decides the depth; declaring it — including what was *not* run — is what stops
a skipped check from being indistinguishable from a forgotten one. The asymmetry is deliberate: raise a
tier freely on seeing the diff, lower one only in writing.

### Why the reviewer picks their own mutant

An author's kill-mutant tests the author's model of their own test. It was chosen, consciously or not,
because they already knew it was caught — so it confirms what they believed and nothing else. A mutant
drawn independently from the operator menu tests the assertion instead. The author's mutant stays
useful as a second data point, and a criterion whose mutant *cannot* be named is still the cheapest
signal in the report.

### Why your own numbers, always

Quoting the agent's numbers — even in notes written afterwards — launders an unverified claim into the
project's record, where the next reader has no way to tell it apart from a measurement.

---

## The lanes

### Why a red improvement does not stop an unattended loop

An opportunistic improvement is by definition not on the unit's critical path: deferring one cannot
make the unit wrong, so halting an unattended run to ask about an opportunity trades a working loop for
a question that could have waited. Recording it in the handover keeps it from being lost, which is the
actual risk. The carve-out is narrow on purpose — a correctness finding or an ambiguity about intent
still stops the loop, because each of those *does* make the unit wrong if guessed at.

### Why a blocked unit is triaged before it is escalated

"I am blocked" and "I need a decision" look identical from inside a stopped loop, and they are not the
same thing. The case that made this rule: a unit's integration test could not run because of a
duplicate bean registration four units upstream — pre-existing, provable as pre-existing (an earlier
unit's test failed the same way, referencing none of the new code), and fixable by one annotation in a
file the brief forbade. The loop stopped and asked, because "a blocked deliverable stops the loop in
every mode" made no distinction. Nobody had a decision to make: both offered options were spellings of
the same mechanical fix.

The distinction that replaced it is not about **files**, it is about the **design**. An allowed-files
table exists to keep a review surface readable — it is bookkeeping, and crossing it to repair a broken
tree costs nothing that a separate `fix:` commit does not restore. A spec-fixed decision, the public
surface, a dependency, the protocol, a test's strength: those are what an agent must never change to
get itself moving, and those are what still stop the loop. Asking a person to authorise a build fix
wastes the thing an unattended loop is for; changing the design without asking destroys the thing it is
working on.

### What a repair is never a licence to do

**Widen the gate.** A latent defect that survived several units usually means the gate has a blind spot
— a suite that never starts a real context, a module nothing type-checks, an integration test no ticked
unit ever ran. Repairing the defect is mechanical; changing what "done" measures is a decision about
the project's standard of proof. Record the blind spot as a 🔴 in `## Decisions pending`, with the
evidence, and carry on.

**Narrow the unit.** The tempting alternative to a repair is always the same: tick the unit on the part
of the gate that *is* green and defer the failing criterion to a later unit. That is the mirror image
of a repair, and unlike a repair it is always a decision — it changes what "done" means for a unit
somebody specified. When a design-neutral repair exists, take it. When it does not, stop.

---

## The verification tiers

### Why the tier is declared rather than felt

Every check costs something, and the right amount of checking is not the same on a documentation batch
and a protocol batch. Left to judgement, the two failures are symmetrical and both invisible: the full
battery burns the budget the next batch needed, and the light pass ships the defect. Writing the tier
down — with the checks it selects **and** the ones it rules out — turns "we skipped that" into a
decision someone can disagree with later.

### The cases behind three of the checks

**Test-double fidelity.** Every mocked collaborator in this repo was once a plain object literal whose
method was an **arrow function**. Arrow functions ignore the receiver, so calling the method *unbound*
worked perfectly against the double and threw against the real prototype method. The offline gate was
**26 files / 258 passed / 0 failed** with the live path completely dead, and the failure was blamed on
a dependency version for three sessions. The Python analogue — a bare `MagicMock()` that invents any
attribute and accepts any signature — is the commonest form of the same blindness.

**The real entry point.** F144's second, separately unrecorded defect was a throw swallowed by the
runner's handler `catch`: the high-context reminder was silently never delivered on any live session,
and no unit test could see it because no test entered through the runner. Hence the corollary: a
swallowed exception in handler code is a finding until proven deliberate.

**Determinism.** Order dependence and nondeterminism are cheap to find with a shuffled, repeated run
and expensive later, where they are misdiagnosed as real defects — the standing example here is a
timeout reported as "a slow endpoint".

---

## See also

- [`renew-loop.md`](renew-loop.md) — the protocol these skills serve, its design notes and troubleshooting
- [`STATUS.md`](STATUS.md) — what is proven and what is outstanding
