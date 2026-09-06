---
name: subagent-review
description: >-
  Scoped to `/renew-loop`'s opt-in **brief-and-review** mode: its analyse turn writes reviewer notes
  from these criteria, and its execute turn reviews the unit's diff against them. Load it only while
  that mode is running, or when the user names it outright ("use subagent-review",
  "/skill:subagent-review") — never on your own initiative for an ordinary review request, which is
  what keeps it out of the way of the user's own skills. What it does: reviews work produced by
  another agent — a delegated child run, another session, a cloud agent, an agent-authored PR — by
  re-running the gate yourself and auditing the diff for the defects a green suite cannot catch, at a
  depth sized to the change, then triaging what is merely worth improving. Runner- and
  language-agnostic — TypeScript, Java (Maven/Gradle), Python, shell.
---

# Reviewing delegated work

**The report is evidence, not proof.** Every number, ticked criterion and passing claim in it is a
statement by the agent whose work you are checking. Verify each against something you ran or read
yourself.

The defect that survives delegation is almost never a failing test. It is a **passing test whose
assertion is too weak to see the bug**, or a decision made silently in a gap the brief left open.
Neither shows in the report; neither is caught by re-running the suite.

Where the work arrived with a [REPORT-CONTRACT.md](../subagent-brief/REPORT-CONTRACT.md) report,
phase 3 audits it section by section. Where it did not, **treat every section as unanswered** — the
checks still apply, you just run them with no map. That includes work this session ran itself for want
of a child runner: your own memory of writing the code is not evidence, and it is the least reliable
map of the three, because it points exactly where you already looked. Rationale: [README.md](README.md).

Runner- and language-agnostic: the checks are the same for TypeScript, Java, Python and shell, and
only the commands change. Where a **`subagent` tool** is available, a fresh-context `reviewer` child
(`subagent({ agent: "reviewer", task: <the diff and the notes> })`) is the second opinion on the diff
— an addition to your own read of it, never a replacement; the `/renew-loop` execute half carries the
call shape. Per-ecosystem commands are in
[VERIFICATION-MENU.md](../subagent-brief/VERIFICATION-MENU.md) Part 4; the project's real ones are in
its [GATE-PROFILE.md](../subagent-brief/GATE-PROFILE.md).

## Phase 0 — Size the review, and read the diff before the report

**Take the tier from the brief; confirm it against the diff.** T0 mechanical, T1 local, T2
behavioural, T3 stateful/protocol — see [VERIFICATION-MENU.md](../subagent-brief/VERIFICATION-MENU.md)
Part 1. A single T3 marker in the diff promotes the whole batch however the brief sized it. Raise the
tier freely; **lowering it needs a written reason** in your notes, because that reason is the only
record that a check was skipped deliberately rather than forgotten.

Then run what the tier selects — Part 2's matrix — and write the three lines down before you start:

```
Tier: T2 (behavioural — the guard changes an error path; nothing persisted)
Checks: gate, lint delta, assertion strength, reviewer mutants ×2, changed-line coverage, spec trace
Skipped: crash-consistency (no persisted state), determinism (no async, no shared state)
```

The budget is roughly **10–20% of the child's run**. A review that costs more than the work it checks
is a sizing error, not diligence.

**Read the diff before you read the report.** The report is a map of where its author thinks the work
is; reading it first anchors you there, and the defects are where they did not look. Write your
questions down first, then open the report and see which it answers. This costs nothing — it is only
an ordering rule — and it is the single cheapest item in this skill.

## Phase 1 — Establish the surface

```bash
git status --porcelain            # includes untracked — new files are where scope escapes
git diff --stat                   # and `git diff --stat HEAD` if the agent committed
```

- **Diff this against the brief's allowed-files table.** A file outside it is a finding regardless of
  whether the change is good. A file *inside* it that was never touched is also a finding — a
  deliverable may be missing. (Your **own** 🔧 repair to a blocking defect is the one sanctioned way
  a file outside the table changes — Phase 5 — and it lands as its own commit, reviewed as one.)
- **Did the agent commit?** If so the work is still reviewable, but check the commit contains only
  the intended change and that nothing was rebased or amended in shared history.
- **Were tracking documents edited?** A ticked box you did not tick is an unverified assertion —
  re-verify it or untick it.
- **Leftover scaffolding?** Probe files, temp fixtures, debug logging, commented-out code.
- **Did the child delegate?** The brief forbids a sub-agent from launching a sub-agent of its own;
  a report or diff you cannot place in this one child (a second agent's voice, a nested run's log) is
  a finding.

## Phase 2 — Re-run the gate yourself

**Never quote the agent's numbers.** Run the project's gate — from its gate profile, or
reconstructed from its scripts and CI config — and use your own output everywhere, including in
whatever notes you write afterwards. Then compare against the pre-task baseline:

- **Prove the suite ran, not just that it passed.** Read the line that names how much executed —
  Surefire's `Tests run:`, Gradle's task outcome, pytest's `collected N items`, the file/test totals
  from Vitest or Jest. **A cached Gradle `test` task prints `UP-TO-DATE` and runs nothing; pytest
  exits 5 on `collected 0 items`; a Maven build with `-DskipTests` succeeds in silence.** Each of
  those is a green run that executed nothing.
- **Counts must rise by roughly what was added.** A fall, or any rise in *skipped* / *todo*, means a
  suite did not really run — cached, empty, or dead infrastructure. Chase that first; a suite that
  did not run makes the whole report meaningless.
- **Sweep the changed test files for focus and skip markers**: `.only(` / `fdescribe` / `fit(` /
  `.skip(` (JS), `@Disabled` / `@Ignore` (Java), `@pytest.mark.skip` / `xfail` (Python), `skip ` in a
  bats `@test`. A live focus marker shrinks a file to one test while still reporting green.
- **A failure with no assertion output is infrastructure until proven otherwise.** Reproduce it on a
  clean tree before attributing it to the diff.
- **Lint: measure the delta, do not eyeball the total.** Stash the change (including untracked),
  measure, restore. Break the delta down by rule and by test-code-vs-source. The question is not
  "did the number rise" but **"is the rise entirely the documented house-style exception, in test
  code?"** A new rule appearing, or any warning in non-test source, is the signal — routinely one
  warning hiding among a dozen innocuous ones.
- **Run every type-check or compile config**, including any the project's own docs forget — each
  `tsconfig`, each `mypy`/`pyright` target, `compileTestJava` as well as `compileJava`, `bash -n` on
  every changed script. A source directory that is built but never type-checked hides its errors from
  the whole gate.
- **Changed-line coverage, where it is wired** (T2+): list the new or changed lines and branches that
  **no** test executes. This is a targeting tool for phase 4, never a percentage gate. Every uncovered
  branch in new production code should be either tested or declared in the report as deliberately
  untested, with its reason.

## Phase 3 — Audit the report against the diff

| Report section | What you verify |
|---|---|
| Files changed | Matches `git status` exactly, in both directions |
| Commands run | The pasted summary lines match **your** run; anything paraphrased is unverified |
| Acceptance | Each named test exists — grep it. Each kill-mutant is plausible. A criterion with no nameable mutant is a prime suspect |
| Non-vacuity probes | Each negative assertion has a probe; each probe **failed** as it must; each probe file is gone |
| Decisions the brief did not fix | **Ratify or reject each one** — unreviewed choices presented as settled. The section that most repays attention |
| Deviations from the brief | The stated problem being real does **not** establish the replacement is right. Evaluate the replacement on its own terms |
| Findings & gaps | Read as *diffs to audit*, not resolved issues. Anything called "fixed" belongs in decisions or deviations — check it was actually changed |
| Review map | A starting order, and a confession of low confidence. Start where it points, then look where it does not |
| Improvements | **Applied (green) improvements are unreviewed changes** — no acceptance criterion covers them. Ratify or revert each: behaviour-preserving, inside the allowed-files table, existing tests unchanged, a separate hunk. Amber/red entries are decisions, not work — route them per Phase 5 |

### Verify the kill-mutants — the highest-value check here

For the two or three most load-bearing criteria, **apply a mutant and confirm the test goes red.**
This tests assertion strength directly, which is where the defects live.

**Pick your own mutant, not the one the report named.** An author's mutant tests the author's model of
their own test; it was chosen, consciously or not, because they knew it was caught. Take a different
one from the menu — negate a conditional · move a boundary (`<` → `<=`, ±1) · return a constant, null
or an empty collection · delete a guard clause · drop an `await`/`join`/`wait` · swap two ordering
keys · change one character of a string literal · call a method unbound from its receiver. Use the
report's mutant as a *second* data point, never the only one.

**Snapshot the files you are about to mutate outside git, and revert from that snapshot.** When the
work under review is uncommitted — the normal case — `git checkout -- <file>` reverts to **HEAD** and
silently destroys the entire delegated change, not just your mutant. The baseline lives in the
working tree, so the snapshot must too.

```bash
# 0. snapshot the review baseline OUTSIDE git — this is what you revert to
mkdir -p /tmp/review-base && cp <files you may mutate> /tmp/review-base/
md5sum <files you may mutate> > /tmp/review-base/md5.before
# 1. confirm the tree is clean of your own edits first
git status --porcelain
# 2. apply the mutant to production code (one line), run only the named test
#    vitest run <file> -t '<name>'   |   mvn -q test -Dtest='FooTest#bar'
#    ./gradlew test --tests 'com.example.FooTest.bar'   |   pytest 'tests/t.py::test_bar'
<run a single test by name>
# 3. it MUST fail. Then revert exactly that file, from the snapshot:
cp /tmp/review-base/<file> <file>
# 4. prove the revert was exact, and the tree is back where you started
md5sum -c /tmp/review-base/md5.before
git status --porcelain
```

A mutant that leaves the test green means the criterion is not proved, whatever the report says.
Revert immediately; never leave a mutant in place while you go read something else.

## Phase 4 — Read the diff for what the criteria did not ask about

Full list in [REVIEW-CHECKLIST.md](REVIEW-CHECKLIST.md). The load-bearing items:

**Assertion strength.** For each new test: *what bug would this still pass with?*
- A permissive matcher where a strict one belongs — truthiness for a format check, a substring match
  on an error message, a partial-object match where equality belongs.
- A fixture whose two orderings coincide, so the test cannot distinguish them.
- A test asserting against a value it derived from the same code it is testing.
- An equivalence "proved" by inspection — counting occurrences, eyeballing a shape — instead of by
  comparison against a baseline you produced.
- An accumulating validator asserted with a substring: the message may also carry a second, wrong error.

**Test-double fidelity — can the double express the failure at all?** A double whose shape cannot
exhibit the defect class makes every test built on it blind, and the blindness is invisible from a
green run. An object literal of arrow functions ignores the receiver, so an unbound call passes
against it and throws in production. A bare `MagicMock()` invents any attribute and accepts any
signature, so a renamed method still passes. A hand-rolled Java stub cannot raise the checked
exception the real collaborator declares. A shell stub that always `return 0` proves nothing about
the failure path. Where the defect class is binding, identity, signature or lifecycle, the double must
be built from the real type. *This is how a suite of 258 passing tests coexisted with a completely
dead production path in this repo.*

**At least one test through the real entry point.** The tool path, the command handler, the registered
callback — not only the pure helper underneath. And **a swallowed exception in handler code is a
finding until proven deliberate**: `catch {}`, `catch (Exception e) { log… }` with no rethrow,
`except Exception: pass`, `|| true` or a missing `set -o pipefail`. Ask what the caller does with a
failure raised by each callback the change adds.

**Criterion inversion** (T2+). For each acceptance criterion, state its complement — what must *not*
happen — and check whether any test asserts it. It turns "what bug would this still pass with?" from
an instinct into a step.

**Partial and boundary cases the criteria named but did not follow through.** If a criterion
describes a limit, truncation or budget, ask what happens to whatever falls *past* it, and whether
that outcome is silent. A silently dropped item is indistinguishable from one that was never there.

**The strings the code emits, read as the consumer will read them.** Criteria check a guard's
*behaviour* and never its *text* — and the text is what a human or another agent acts on. A guard
whose message suggests the very workaround it exists to prevent passes every test.

**Loaders and validators that discard malformed input.** In code whose job is to fail loudly, a
defensive fallback that quietly drops a bad value is a bug, not safety.

**Efficiency the criteria never mentioned.** Work done then thrown away, reads inside a loop a later
filter discards, repeated traversals.

**The cheap class.** Missing trailing newlines, duplicated or mid-file imports, a docblock or README
made stale by the change, a test whose *name* promises more than it asserts. Individually trivial,
collectively the most common thing found in review.

## Phase 5 — Land it

Write findings where the project keeps them, marking each **fixed** or **recorded and deliberately
not fixed** — an out-of-scope problem the agent correctly reported is a note, not a task. Then:

- **Quote your own numbers**, never the report's.
- **Note anything that crossed a constraint**, even where you kept the result — evidence that the
  constraint is not enforcement, and that the next delegation should be reviewed on that basis.
- **Re-run the gate after your own fixes**, not before.
- **Do not commit unless asked.** If you do, the diff you reviewed and the diff you commit must be
  the same one.

### Triage the improvements — yours and the agent's

Anything you or the agent noticed that is *better*, rather than *wrong*, goes through the lanes in
[IMPROVEMENT-BUDGET.md](../subagent-brief/IMPROVEMENT-BUDGET.md):

- **🟢 apply** — behaviour-preserving, inside the allowed-files table, ≤ ~15 net lines, no exported
  signature or dependency change, existing tests pass **unchanged**, contradicts nothing the spec
  fixes. Land it as a **separate commit** (`refactor:` / `test:`), after the functional review is
  green, and re-run the gate. Never fold it into the batch's own commit — the next reader cannot
  separate the feature from the cleanup.
- **🟡 propose** — bigger, a new abstraction, a shared helper, or a test's intent. Record it with a
  sketch. Do not start it.
- **🔴 escalate** — it would change a decision the spec, design or brief fixes; the public surface; a
  dependency; or the protocol or state machine.

**Where a 🔴 goes depends on whether a person is about to read this turn, and only this depends on it:**

| How the run is driven | What happens |
|---|---|
| A person sees the turn — it pauses between turns, it is the last turn, or it is a one-off delegation | Surface it at the natural stopping point, as numbered options with a recommendation |
| **Unattended** — it restarts into the next turn by itself | **Do not stop the run.** Append it to the handover's `## Decisions pending` section, name it in the turn's progress line, and continue |

An opportunistic improvement is never on the unit's critical path, so deferring one cannot make the
unit wrong — and halting an unattended run for an opportunity is the wrong trade. **This carve-out
covers improvements only.** A correctness finding, an ambiguity about intent, or a second review
escalation of the same unit still stops the run either way. If you are reaching for this rule to
avoid stopping, what you are holding is not an improvement.

### The blocked case — 🔧 repair, or a decision

A blocker the child reported, or a gate failure the unit did not introduce, is triaged separately and
**before** it counts as a hard stop. Prove it is pre-existing — reproduce it on something that
references none of the unit's code, or on a clean tree, and name the first failure in the chain; if
that is the unit's own code it is a correctness finding, and the loop stops. Then ask the six 🔴
triggers of the **shortest** correct repair (spec-fixed decision · public surface · dependency ·
protocol · spec delta · a *weakened* test). **None of them → repair it**, outside the allowed-files
table and in other units' files if that is where it lives — a unit already ticked included, whose tick
stands — as its own `fix:` commit before the unit's, with the gate re-run after and an `RP-` entry in
the handover. **Any of them → stop and report**, in every mode. Full lane, bounds and entry format:
[IMPROVEMENT-BUDGET.md](../subagent-brief/IMPROVEMENT-BUDGET.md#-the-repair-lane--blocked-is-not-the-same-as-undecidable).

Note which side of the line does the work here: the **file boundary** never decides it — only whether
the repair changes the design does. And the third option is not available to you: **accepting the
unit on the part of the gate that passed**, with the failing criterion deferred to a later unit,
changes what "done" means for a unit somebody specified. That is a decision even where the repair
would not have been.

A blocked verdict that arrives *from the child* is an input to this triage, not the end of it —
re-derive it from your own run, and if the child wrote its blockage into a tracking document it was
told not to touch, revert that edit and restate the finding yourself. It is a crossed constraint
worth recording even when the technical claim holds up.

## Failure modes of the review itself

- **Reading the report instead of the diff.** The report maps where the author *thinks* the work is;
  the defects are where they did not look.
- **Accepting a self-comparison.** "Old and new behave identically" means nothing unless the old
  side came from somewhere you control — `git show HEAD:<file>` into a scratch file, then a real
  comparison run.
- **Spreading attention evenly.** Rank by risk: new production code and any test guarding an absence
  or an ordering first; mechanical edits last.
- **Stopping at green.** Every defect worth finding here was found in a green tree.
- **Reviewing every batch at the same depth.** The full battery on a documentation change burns the
  budget the next batch needed; the light pass on a protocol change ships the defect. Size it in
  Phase 0, and write down what you skipped.
- **Trusting a report that came from a nested run.** A report that does not add up to one session's
  work is the wrong unit.
- **Accepting an applied improvement because it looks tidy.** No acceptance criterion covers it. It
  is the one part of the diff nobody was asked to prove.
