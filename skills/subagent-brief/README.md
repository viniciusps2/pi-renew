# Why the brief is shaped this way

Rationale for [SKILL.md](SKILL.md). Not needed to write a brief — read it when a rule looks like
overhead, or when deciding whether to skip one.

## The preflight sweeps

Each sweep costs minutes and prevents a class of failure that is expensive or invisible later.

- **Staleness.** Letting the sub-agent discover mid-run that something already exists means it
  improvises: it may regenerate the thing, or "fix" a file that was already correct.
- **Absence.** Left as "make the suite green", the cheapest solution available to the sub-agent is
  to weaken the assertion. The result is green and wrong.
- **Baseline capture.** A baseline quoted without its command is ambiguous, and an ambiguous
  baseline makes the sub-agent report a discrepancy that does not exist — or miss one that does.
- **Tooling probe.** Five minutes proving an external tool's behaviour yourself is orders of
  magnitude cheaper than the sub-agent discovering it deep into a run and designing around a guess.
- **Baseline artifacts.** A sub-agent that generates both sides of a comparison proves nothing, and
  will report the self-comparison as a pass.
- **Open questions.** Each fixed decision needs its *reason*, because the reason is what lets the
  sub-agent extend the decision to a case you did not foresee instead of reverting to instinct.

## Why fixed decisions are the highest-leverage section

A task with a dozen pre-fixed decisions typically needs no rework on any of them. Every category in
the Phase 1 table is one where "the sub-agent will pick something reasonable" has already produced a
review cycle: a near-miss identity literal that compiles and breaks a string-matching consumer, a
disabled-flag assertion standing in for absence, a fixture whose two orderings coincide.

## Why the constraints are worded the way they are

**The git constraint** is precise because the blunt version ("do not run any git command") also
blocks legitimate work such as building a git repository inside a temp-dir test fixture — and a
sub-agent that reads it literally either stalls or ignores the whole constraint.

Expect it to be crossed anyway. Constraints in a brief are not enforcement, which is the reason
review works on the diff rather than on the report.

**The allowed-files table** keeps a task inside its blast radius even when an acceptance criterion's
wording could be read as licence to change something far away.

## Setting up for review

- **The log**: without a persisted transcript, a run that completes but loses its answer is
  unrecoverable, and you cannot reconstruct what the sub-agent read or decided.
- **The uncommitted tree**: a sub-agent that commits its own work forces you to review through
  history instead of `git diff`.
- **Tracking documents**: a ticked box in a document you did not write is an assertion you have not
  verified.
- **A killed run's partial work**: a half-written file from a dead run is the worst possible
  starting state for the next attempt.

## Why the tier is declared rather than felt

Every check in this pair costs something, and the right amount of checking is not the same on a
documentation batch and a protocol batch. Left to judgement, the two failures are symmetrical and
both invisible: the full battery burns the budget the next batch needed, and the light pass ships the
defect. Writing the tier down — with the checks it selects **and** the ones it rules out — is what
turns "we skipped that" into a decision someone can disagree with later.

Reviewers may raise a tier on sight of the diff; lowering one needs its reason in writing, because a
check skipped deliberately and a check forgotten look identical a week later.

## Why the sub-agent gets an improvement budget

Without one, a sub-agent that notices something worth fixing has two bad options: fold it into the
functional diff, where it destroys the review surface — you can no longer tell the feature from the
cleanup — or drop it, because nobody gave it authority. The budget makes the small, safe,
behaviour-preserving case explicit and cheap, and routes everything else to a person. The separate
commit is the load-bearing half: it is what keeps the batch's own diff reviewable as the batch.

## Companion files

| File | What it is |
|---|---|
| [BRIEF-TEMPLATE.md](BRIEF-TEMPLATE.md) | The nine-section brief, ready to fill in |
| [REPORT-CONTRACT.md](REPORT-CONTRACT.md) | The report the sub-agent must return — the seam with `subagent-review` |
| [VERIFICATION-MENU.md](VERIFICATION-MENU.md) | Which check earns its cost on which change, and the command for it in each ecosystem |
| [IMPROVEMENT-BUDGET.md](IMPROVEMENT-BUDGET.md) | What an agent may improve on its own authority, what it proposes, what it escalates — and the 🔧 lane: what it may repair *outside* the allowed-files table when a blocking defect is not the unit's own |
| [GATE-PROFILE.md](GATE-PROFILE.md) | Per-project gate commands, baselines and known trap signatures |
