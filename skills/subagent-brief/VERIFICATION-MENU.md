# The verification menu

Which check earns its cost, on which change. `subagent-brief` **declares** the tier and the per-part plan;
`subagent-review` **runs** what the tier selects; in `/renew-loop`'s brief-and-review mode the brief carries
the declaration from the analyse turn to the execute turn.

It prevents two opposite failures: the whole battery on a two-line documentation change, so the review costs
more than the work; and the battery skipped on a change that needed it, with **nothing in the record** saying
which checks were skipped or why. **The tier is declared, not felt** — writing it down is what makes the
second failure visible.

**Language-neutral.** Parts 1–3 name no toolchain; Part 4 gives the command per ecosystem, and the project's
real ones belong in [GATE-PROFILE.md](GATE-PROFILE.md).

---

## Part 1 — Size the change first

| Tier | What it is | Markers |
|---|---|---|
| **T0 Mechanical** | No production behaviour can change | docs, comments, formatting, a version bump with no code change, an additive test that changes no existing assertion |
| **T1 Local** | New or changed code with no persisted or external effect | a pure function, an isolated helper, a new test file; no existing assertion touched |
| **T2 Behavioural** | Another component can observe the change | control flow, a guard or an error path changed; an existing assertion changed or deleted; an exported signature added or changed |
| **T3 Stateful / protocol** | Can leave the system in a half-state | persisted records, handshakes, restart and crash paths, process lifecycle, concurrency, the filesystem |

**Promote, never average.** A single T3 marker makes the whole batch T3. "Mostly T1 with one file that
writes to disk" is a T3 batch.

**Effort budget.** The review should land near **10–20% of the child's run**. If the tier implies forty
minutes of checks on a ten-line change, fix the tier, not the budget.

**Declare it** — one line, in the brief and again in the reviewer's notes:

```
Tier: T2 (behavioural — the new guard changes an error path; nothing persisted)
Checks: gate, lint delta, assertion strength, reviewer mutant ×2, changed-line coverage, spec trace
Skipped: crash-consistency (no persisted state), determinism (no async or shared state)
```

And when the batch really is trivial — the point of writing it down is that this is a claim someone can
dispute, not a silence:

```
Tier: T0 (mechanical — one README section; no code, no test, no behaviour)
Checks: gate, surface diff, staleness sweep (does the section describe something already shipped?)
Skipped: everything else — there is no assertion, no branch and no string the code emits
```

The reviewer may **raise** the tier freely on seeing the diff. Lowering it requires a written reason — the
only way a skipped check stays auditable.

---

## Part 2 — The matrix

| Technique | Fires when | Skip when | ~Cost |
|---|---|---|---|
| Surface diff vs. allowed-files table | always | never | 1 min |
| Own gate re-run + numeric floor | always | never | the gate |
| Report audit §1/2/5/6 | always | no report exists — then every section is *unanswered*, not absent | 5 min |
| Lint delta by rule, test-code vs. source | T1+ | T0 | 3 min |
| Author-named kill-mutant per criterion | T1+ | T0 | in-report |
| Assertion-strength read of each new test | T1+ | T0 | 5–15 min |
| **Reviewer-applied** mutant, 2–3 | T2+; also T1 when a criterion is the *only* proof of a new behaviour | T0, and T1 mechanical | 10 min |
| Non-vacuity probe | **any** negative or absence assertion exists — tier-independent | there are none | 3 min each |
| Focus / skip marker sweep | any batch that touches tests — tier-independent | the batch touches no test file | 1 min |
| Changed-line coverage | T2+ (T1 too, once it is one command) | T0 | 2 min |
| Test-double fidelity | the change is exercised only through a double of a host/SDK object | production types are used directly | 5 min |
| Real-entry-point test | T2+, whenever the unit is reached through a host callback, tool path or command handler | the export under test *is* the entry point | 10 min |
| Invariant / property test | a pure function carries idempotence, round-trip, order-independence or totality | a mapping with no invariant beyond its examples | 15 min |
| Determinism: alone, ×3, shuffled | tests touch time, async, the filesystem, ports or shared state | pure synchronous tests | 3 min |
| Crash-consistency + at-least-once menu | **T3 only** | T0–T2 | 20 min |
| Bidirectional spec trace | the batch maps to a spec delta | ad-hoc work with no spec behind it | 10 min |
| Strings read as the consumer reads them | the change emits user- or agent-visible text | it emits none | 5 min |
| Criterion inversion | T2+ | T0/T1 | 5 min |
| Refactor equivalence | the batch claims to preserve behaviour | it changes behaviour on purpose | 1 min |
| Regression-test-first | the unit is a bug fix | new-feature work | included |
| Dead-surface sweep | after any rename, removal or refactor | additive-only change | 2 min |
| Blind-diff-first ordering | always | never — it is free | 0 |

---

## Part 3 — Recipes

Only the techniques that need one. The rest are a single command or a single question.

### Reviewer-applied mutant

The author names a kill-mutant per criterion, and a criterion with no nameable mutant self-identifies as
vacuous — keep that. But an author's mutant tests the author's model of their own test. For the two or three
**load-bearing** criteria, pick a *different* mutant yourself:

> negate a conditional · move a boundary (`<` → `<=`, ±1) · return a constant, `undefined` or an empty
> collection · delete a guard clause · drop an `await` · swap two ordering keys · change one character of a
> string literal · unbind a method from its receiver

Apply it, run only the named test, confirm red, revert from the **working-tree snapshot** (`subagent-review`
Phase 3 — `git checkout --` reverts to HEAD and destroys the delegated change).

### Changed-line coverage

A targeting tool, **never a percentage gate**. Run coverage scoped to the batch's files, list the new or
changed lines and branches executed by **zero** tests, then apply the rule:

> Every uncovered branch in new production code is either tested, or named in the report as deliberately
> untested **with its reason**.

That is what catches the ordinary shape of a thin batch: the happy path has a criterion and a test, the error
path has neither.

### Test-double fidelity

**Ask: can this double express the failure at all?** A double whose shape cannot exhibit the defect class
makes every test built on it blind, and the blindness is invisible from a green run. Per double: **does it
have the arity, the error paths, the laziness and the lifecycle of the thing it stands for?** Where the
defect class is binding, identity, signature or lifecycle, build the double from the real type rather than
hand-shaping it to fit the call site.

| Ecosystem | The blind double | The faithful one |
|---|---|---|
| TypeScript / JS | an object literal of arrow functions — ignores `this`, accepts any arity | a class instance with prototype methods; or a typed `satisfies` double so a signature drift fails to compile |
| Python | a bare `MagicMock()` — invents any attribute and accepts any signature, so a typo or a renamed method passes | `create_autospec(Thing, spec_set=True)`, or `patch(..., autospec=True)` |
| Java | a hand-rolled stub, or a mock stubbed only for the happy path — cannot raise the checked exception the real collaborator declares | a Mockito mock of the real interface with the failure paths stubbed (`doThrow(...)`), and `verify` on the interaction |
| Shell | a stub function that ignores its arguments and always `return 0` | a stub that asserts its arguments and reproduces the real exit codes, including the non-zero ones |

### Real-entry-point test

At least one test must drive the **production entry point** — the tool path, the command handler, the
registered callback — not only the pure helper underneath it. Corollary for review: **a swallowed exception
in callback or handler code is a finding until proven deliberate.** Ask what the caller does with a failure
raised by each callback the change adds.

| Ecosystem | What swallowing looks like |
|---|---|
| TypeScript / JS | `catch {}`, a `.catch(() => {})`, an un-awaited promise, a `try` whose `catch` only logs |
| Java | `catch (Exception e) { log.warn(...) }` with no rethrow; an empty `catch`; a `Future` whose `get()` is never called |
| Python | `except Exception: pass`, a bare `except:`, a `contextlib.suppress` wider than the case it was written for |
| Shell | `\|\| true`, a missing `set -e`, a failure inside a pipeline with no `set -o pipefail`, a `trap` that exits 0 |

### Focus / skip marker sweep

A focus marker left in a file silently reduces that file to one test **while still reporting green**; a skip
marker silently removes the only test proving the criterion. One grep over the changed test files:

| Ecosystem | Grep for |
|---|---|
| TypeScript / JS | `.only(`, `fdescribe`, `fit(`, `.skip(`, `.todo(`, `xit(` |
| Java (JUnit 5 / 4) | `@Disabled`, `@Ignore`, `assumeTrue(false)`, a `@Tag` the gate's filter excludes |
| Python | `@pytest.mark.skip`, `skipif`, `xfail`, `pytest.skip(`, a `-k`/`-m` filter in the project config |
| Shell (bats / shunit2) | `skip ` at the top of a `@test`, a commented-out `@test`, a renamed `test_` function |

This pairs with the numeric floor: the floor catches a suite that shrank, the sweep explains why.

### Invariants over examples

For a pure decision function, name the invariant class rather than adding a fourth example — three examples
cannot prove idempotence, and a two-line invariant test can.

| Invariant | Reads as | Where it applies here |
|---|---|---|
| Idempotence | applying twice equals applying once | the stand-down guard |
| Round-trip | `parse ∘ render = id` | the restart signal renderer |
| Order-independence | the verdict does not depend on arrival order | the supervision window |
| Totality | never throws across the input domain | any classifier fed live events |

### Determinism and isolation

Run the new test **alone**, then **three times**, then the suite in a **randomised order** (commands in Part
4). Order dependence found here is cheap; found later it is misdiagnosed as a real defect. Where a test reads
the clock, the locale or the timezone, run it once under a different `TZ` and locale too — one command,
whole class caught.

### Crash-consistency and at-least-once — T3 only

Walk the menu, one line of evidence each: the process dies between the write and the acknowledgement · the
same message is delivered twice · messages arrive out of order · new code reads absent or legacy state · old
code reads new state · nothing cleans up after an abandoned run.

### Bidirectional spec trace

Both directions, because each catches something the other cannot:

- **requirement → test**: every normative requirement in the delta spec has a named test. Catches the case
  the brief structurally cannot — *the brief dropped a requirement, so the child implemented the brief
  perfectly.*
- **test → requirement**: every new test traces to a requirement, or is declared as extra. A test tracing to
  nothing is either scope creep or an undocumented decision.

This is also the mechanical guardrail for the improvement budget: an "improvement" that breaks a trace is a
design change. See [IMPROVEMENT-BUDGET.md](IMPROVEMENT-BUDGET.md).

### Criterion inversion

For each acceptance criterion, state its complement — what must **not** happen — and check whether any test
asserts it. Its counterpart in the brief: **at least one acceptance criterion should be negative.**

### Refactor equivalence

If a batch claims to preserve behaviour and the **test files changed**, that is a finding by definition.

### Regression-test-first

Any unit that is a bug fix must show its new test **failing on the pre-fix tree**, with the failure output
pasted. Without that there is no evidence the test targets the bug rather than the fix.

### Blind-diff-first

Read the diff and write your questions down **before** reading the child's report. The report maps where its
author thinks the work is; the defects are where they did not look.

---

## Part 4 — The same check in each ecosystem

Reference commands, not project truth: the project's real gate lives in [GATE-PROFILE.md](GATE-PROFILE.md).
Flags marked *(plugin)* need a dependency the project may not have — if it is absent, say so in the brief and
drop that check rather than adding a dependency for one review.

### Run one test by name

| Ecosystem | Command |
|---|---|
| Vitest / Jest | `npx vitest run <file> -t '<test name>'` · `npx jest <file> -t '<test name>'` |
| Maven | `mvn -q test -Dtest='FooTest#barCase'` |
| Gradle | `./gradlew test --tests 'com.example.FooTest.barCase'` |
| pytest | `pytest 'tests/test_foo.py::TestFoo::test_bar'` |
| bats / shunit2 | `bats -f '<test name>' test/foo.bats` |

### Randomised order, repeated runs, and "did it actually run"

| Ecosystem | Random order | Force a real run |
|---|---|---|
| Vitest / Jest | `--sequence.shuffle` · `--randomize` | `--no-cache`; check the printed file/test totals |
| Maven | `-Dsurefire.runOrder=random` | never trust a build run with `-DskipTests` or `-Dmaven.test.skip`; check Surefire's "Tests run:" line |
| Gradle | JUnit 5 `-Djunit.jupiter.testclass.order.default=…`, or a random-order extension *(plugin)* | **`--rerun-tasks`, or `cleanTest test`** — a cached `test` task prints `UP-TO-DATE`/`FROM-CACHE` and runs nothing |
| pytest | `-p randomly` *(plugin)* or `--random-order` *(plugin)* | `collected 0 items` and **exit code 5** mean the suite did not run |
| bats | n/a — order is file order | a `.bats` file with no `@test` reports success; check the test count |

**Gradle's cached `test` task and pytest's exit-5 are the two most convincing "green" runs that never
executed a thing.** Both belong in every gate profile's trap table.

### Coverage of the changed lines

| Ecosystem | Command | Where the uncovered lines are |
|---|---|---|
| Vitest / Jest | `vitest run --coverage` *(needs `@vitest/coverage-v8`)* · `jest --coverage` | the text reporter's uncovered-line column |
| Maven | `mvn -q verify` with the JaCoCo plugin bound | `target/site/jacoco/jacoco.xml`, `…/index.html` |
| Gradle | `./gradlew test jacocoTestReport` | `build/reports/jacoco/test/jacocoTestReport.xml` |
| pytest | `pytest --cov=<pkg> --cov-branch --cov-report=term-missing` | printed inline, per file, as line ranges |
| Shell | `kcov` *(plugin)* — usually skip; read the branches by eye instead | — |

### Type-check and lint

| Ecosystem | Type / compile | Lint |
|---|---|---|
| TypeScript | `tsc --noEmit` — **once per config**, including the ones the project's docs forget | `eslint` |
| Java | the build compiles; add `-Werror`/Error Prone where configured | `mvn checkstyle:check spotbugs:check pmd:check` · `./gradlew checkstyleMain spotbugsMain spotlessCheck` |
| Python | `mypy <pkg>` or `pyright` | `ruff check` · `flake8` · `pylint` |
| Shell | `bash -n <script>` (syntax only) | `shellcheck -S style <script>` |

### Invariant / property testing *(plugin, all four)*

`fast-check` (TS/JS) · `jqwik` or `junit-quickcheck` (Java) · `hypothesis` (Python) · none for shell — use a
table-driven loop over the input domain instead.

### Whole-suite mutation tools — optional, and usually not

`Stryker` (TS/JS) · `PIT` (Java) · `mutmut` / `cosmic-ray` (Python). **Not part of the default flow**:
minutes to hours per run, for marginal gain over two or three reviewer-chosen mutants. The one case that
earns it is a Java module where PIT can be scoped to the changed classes
(`-DtargetClasses=com.example.changed.*`) and the suite is fast.

### Shell-specific, because the language has no type system

- `set -euo pipefail` at the top, or state why not. Its absence is a finding on any T2+ script.
- A failure inside a pipeline is invisible without `pipefail`.
- Quote every expansion; a `# shellcheck disable=` added by the change needs a stated reason.
- `mktemp` plus a `trap … EXIT`: a script that leaves temp state behind is a T3 concern, not a style one.

## Part 5 — Signals you sized it wrong

- A **reviewer-chosen mutant survives** — the criterion is unproved, and the tier that let you skip the check
  was too low.
- A **T0/T1 batch touches a file that writes to disk, spawns a process, or is registered with the host** — it
  was T3 all along.
- The diff **grew past the allowed-files table** — re-size before reviewing; the batch is not what the brief
  described.
- The **gate's skipped or todo count rose** — stop sizing and chase that first. A suite that did not run makes
  every other check meaningless.
