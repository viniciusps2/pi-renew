# Review checklist

Work top to bottom. Every item is something that has shipped past a green suite.

**Each item carries the condition that makes it fire.** Size the change first (Phase 0), then run
what its tier selects — a `[T2+]` item on a documentation batch is wasted budget, and skipping one on
a protocol batch is how the defect ships. Tags:

`[all]` every batch · `[T1+]` `[T2+]` `[T3]` at that tier and above · `[if …]` only when the
condition holds. Language-neutral: commands per ecosystem are in
[VERIFICATION-MENU.md](../subagent-brief/VERIFICATION-MENU.md) Part 4.

## Sizing

- [ ] `[all]` Tier taken from the brief and **confirmed against the diff**; a single T3 marker
      promotes the whole batch.
- [ ] `[all]` Tier, checks run, and **checks skipped** written down. A lowered tier carries its
      reason.
- [ ] `[all]` The diff was read **before** the agent's report.

## Surface

- [ ] `[all]` `git status --porcelain` (with untracked) matches the allowed-files table **in both
      directions** — nothing extra, nothing missing.
- [ ] `[all]` Nothing was committed, rebased, or amended that the reviewer owns.
- [ ] `[all]` No tracking document (plan, task list, handover, changelog) was edited by the agent;
      any box it ticked is re-verified or unticked.
- [ ] `[all]` No leftover scaffolding: probe files, temp fixtures, debug logging, commented-out code.
- [ ] `[all]` Every new file ends with a trailing newline.
- [ ] `[T1+]` No duplicated imports, and no imports scattered mid-file where the file's style puts
      them at the top.

## Gate — your run, not the report's

- [ ] `[all]` Every suite re-run by you; counts rose by roughly what was added.
- [ ] `[all]` **The suite actually ran** — the executed-count line, not just the pass line. Gradle
      `UP-TO-DATE`/`FROM-CACHE`, pytest `collected 0 items` (exit 5), a Maven build with no
      `Tests run:` line, "No test files found": each is a green run that executed nothing.
- [ ] `[all]` **0 skipped, 0 todo** where the project expects none. Any rise means a suite did not run.
- [ ] `[if tests]` Changed test files swept for focus/skip markers: `.only(` `fdescribe` `fit(`
      `.skip(` · `@Disabled` `@Ignore` · `@pytest.mark.skip` `xfail` · bats `skip`.
- [ ] `[all]` Every type-check or compile config run, including ones the project's docs omit —
      each `tsconfig`, each `mypy`/`pyright` target, `compileTestJava` as well as `compileJava`,
      `bash -n` on every changed script.
- [ ] `[T1+]` Lint delta measured (stash including untracked → measure → restore), not eyeballed.
- [ ] `[T1+]` Lint delta broken down **by rule** and **by test-code vs. source**. Any new rule, or
      any warning in non-test source, is investigated individually.
- [ ] `[all]` Any failure with no assertion output reproduced against a clean tree before being
      attributed to the diff.
- [ ] `[T2+]` Changed-line coverage listed: new or changed lines and branches **no** test executes.
      Each is tested, or declared deliberately untested with a reason. Never a percentage gate.
- [ ] `[if async/time/fs/shared state]` New tests run **alone**, **three times**, and the suite in a
      **randomised order**. Where a test reads the clock or locale, once under a different `TZ`.

## Report audit

- [ ] `[all]` Command results are **pasted output**, and they match your run.
- [ ] `[T1+]` Every test named in the acceptance section exists — grepped, not assumed.
- [ ] `[T1+]` Every criterion has a nameable kill-mutant. Ones that do not are treated as unproved.
- [ ] `[T2+]` The 2–3 most load-bearing mutants were **applied** and the named tests went red — with
      **a mutant you chose**, not only the one the report named. Tree reverted from the working-tree
      snapshot and confirmed clean afterwards.
- [ ] `[if negative assertions]` Every negative/absence assertion has a non-vacuity probe that
      **failed**, and the probe file is gone.
- [ ] `[all]` Every entry in "decisions the brief did not fix" is explicitly ratified or rejected.
- [ ] `[all]` Every deviation is judged on the **replacement**, not on whether the stated problem
      was real.
- [ ] `[all]` "Findings & gaps" cross-checked against the diff — nothing described there was
      actually changed without being declared.
- [ ] `[all]` Every **applied** improvement ratified or reverted; every proposed/escalated one routed.

## Assertion strength — for each new test, "what bug would this still pass with?"  `[T1+]`

- [ ] No truthiness or length check standing in for a format check.
- [ ] No substring match on an error message where the whole message matters — especially for a
      validator that accumulates errors and could be emitting a second, wrong one.
- [ ] No partial-object or permissive matcher where equality is what the criterion claims.
- [ ] No wildcard where a literal belongs.
- [ ] **Ordering tests: the fixture's orderings actually disagree.** If the natural sort of the
      identifiers happens to equal the order under test, the test proves nothing — change the
      fixture so the two orders are different.
- [ ] Values that must differ actually differ across the fixture (not three rows carrying the
      same default).
- [ ] Identifiers unique to this spec where the test environment's state is shared between specs.
- [ ] No test asserting against a value derived from the code under test.
- [ ] Any equivalence/identity claim is proved by **comparison against a baseline the reviewer or
      brief produced** (`git show HEAD:<file>` → compare), not by inspection or by counting
      occurrences.
- [ ] Assertions go through the production read path where the criterion is about what production
      observes — not through a direct query that sorts, filters, or normalises differently.
- [ ] Every new test's **name** matches what it actually asserts.
- [ ] **Test doubles can express the failure.** No object literal of arrow functions standing in for
      a prototype method; no bare `MagicMock()` where `create_autospec(..., spec_set=True)` belongs;
      no Java stub that cannot raise the checked exception the real collaborator declares; no shell
      stub that always returns 0. A double that cannot fail the way production fails makes every
      test on it blind.
- [ ] `[T2+]` At least one test drives the **real entry point** — the handler, tool path or
      registered callback — not only the pure helper underneath it.
- [ ] `[if pure function]` Where an invariant exists — idempotence, round-trip, order-independence,
      totality — it is asserted as an invariant, not approximated with three examples.
- [ ] `[if bugfix]` The regression test was shown **failing on the pre-fix tree**, with the output.

## Outside the acceptance criteria

- [ ] `[T2+]` **Criterion inversion**: each criterion's complement — what must *not* happen — is
      stated, and something asserts it.
- [ ] `[T2+]` Limits, budgets, truncations: what happens to what falls past them, and is it
      **silent**? A silently dropped item is indistinguishable from one that was never there.
- [ ] `[T2+]` Error paths and empty inputs, where the criteria only described the happy path.
- [ ] `[if it emits text]` **Every string the change emits, read as its consumer will read it** —
      guard messages, warnings, log lines, fallbacks. Does any of them suggest the workaround the
      guard exists to prevent? Is a fallback emitted as a bare substituted value where a whole
      sentence was meant?
- [ ] `[T2+]` No swallowed failure in handler or callback code: `catch {}`, `catch (Exception e)`
      that only logs, `except Exception: pass`, `|| true`, a missing `set -o pipefail`.
- [ ] `[T2+]` Loaders and validators: no defensive fallback that silently discards malformed input
      in code whose job is to fail loudly.
- [ ] `[T2+]` Efficiency: no work performed and then discarded, no read inside a loop that a later
      filter throws away.
- [ ] `[T3]` Crash-consistency walked: process dies between write and acknowledgement · the same
      message delivered twice · out-of-order arrival · new code reading absent or legacy state · old
      code reading new state · nothing cleans up after an abandoned run.
- [ ] `[T3]` Concurrency and shared state, where the change touches anything other tests or
      processes also use.
- [ ] `[if spec]` **Bidirectional spec trace**: every normative requirement has a named test, and
      every new test traces to a requirement or is declared as extra.
- [ ] `[if refactor]` A batch claiming behaviour preservation left the **test files unchanged**.
- [ ] `[if rename/removal]` Dead-surface sweep: nothing left unreferenced, no export nobody imports.
- [ ] `[T1+]` Docs, docblocks, and READMEs the change made stale — including ones describing a
      feature as working when only part of it was built.

## Close-out

- [ ] `[all]` Findings split into **fixed** and **recorded, deliberately not fixed**, with the reason.
- [ ] `[all]` Improvements triaged: 🟢 applied as a **separate commit** after the functional review is
      green; 🟡 recorded with a sketch; 🔴 escalated — to the user under `stop`/`ask`, or to the
      handover's `## Decisions pending` under `auto`, without stopping the loop.
- [ ] `[all]` Gate re-run **after** any fixes or improvements made during review.
- [ ] `[all]` Notes quote your own numbers, with the command that produced each.
- [ ] `[all]` Any crossed constraint noted, even where the result was kept.
