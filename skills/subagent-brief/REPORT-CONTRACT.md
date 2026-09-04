# Report contract

The shared seam between `subagent-brief` and `subagent-review`. The brief **imposes** it; the
review **consumes** it.

Paste this into the brief's `# Report-back` section, or reference it by path if the sub-agent can
read the repository.

A report written to this contract is not a narration of success. It is an **audit trail**: it
tells the reviewer where to look, what to distrust, and which decisions were made without
authority. Sections 3–6 exist because a green suite proves nothing about assertion strength, and
because a sub-agent's silent choices are otherwise invisible until they cause a bug.

**Scale it to the tier.** On a T0 batch sections 3, 4 and 9 are usually "none" and the report is
half a page; on a T3 batch none of them are. Write "none" — never drop the heading, because an
absent section and an empty one are indistinguishable to the reviewer.

---

## The contract (paste from here)

```markdown
End your answer with a report in exactly these nine sections, in this order. Do not omit a
section — write "none" if it is empty. Accuracy matters more than looking finished: a report that
says "I could not verify this" is more useful than one that claims a pass you did not observe.

### 1. Files changed

One row per file: path, and one line on what changed and why. If you touched anything not in the
allowed-files table, say so **first and explicitly** — do not bury it in the table.

### 2. Commands run

One row per command, with the **verbatim summary line** the command printed — not a paraphrase,
not a number you recalled. If a command failed and you re-ran it, show both. If you did not run
one of the required commands, say which and why.

### 3. Acceptance

One entry per acceptance criterion from the brief, in the brief's order. Each entry needs three
things:

- the criterion, restated;
- the **exact name of the test** that proves it, as a reviewer would grep for it;
- the **kill-mutant**: the single change to *production* code that makes that test fail.

Example shape:

- [x] <criterion>
      test: `<exact test name>`
      kill-mutant: <one-line change to production code> → this test fails

If you cannot name a kill-mutant for a criterion, **say so instead of inventing one**. That is the
signal that the assertion may not test what the criterion says, and it is exactly what the
reviewer needs to know. A criterion proved only by an existing test you did not write should say
so too.

Name the mutant you think is **hardest** for the test to catch, not the easiest. The reviewer will
apply a different one of their own choosing; a mutant picked because you know it is caught tells
neither of you anything. Mutants come from this menu: negate a conditional · move a boundary
(`<` → `<=`, ±1) · return a constant, null or an empty collection · delete a guard clause · drop
an `await` / `join` / `wait` · swap two ordering keys · change one character of a string literal ·
call a method unbound from its receiver.

### 4. Non-vacuity probes

For every assertion that is negative or checks an absence — `expect(...).not.*`,
`assertFalse` / `assertNull` / `assertThrows`-that-expects-nothing, `assertNotIn`,
`pytest.raises` never entered, a shell `! grep -q`, "does not contain", "is absent", "no rows
returned" — prove the assertion can actually fail.

Write a throwaway test that feeds it the case it is supposed to reject, confirm that test **fails**,
paste the failure output, and delete the probe. A negative matcher applied to a value the matcher
does not support passes vacuously, and looks identical to a real pass.

Report per probe: the assertion being checked, the probe's outcome (it must be a failure), and
confirmation that the probe file was deleted.

If there were no negative assertions, write "none".

### 5. Decisions I made that the brief did not fix

Every choice you made that the brief did not decide for you. Per entry: what you chose, what you
rejected, and why. Include choices that felt obvious — naming, file placement, which helper to
reuse, how to shape a fixture, what to do when two conventions in the codebase disagreed.

This is not a confession; it is the list of things the reviewer must ratify. An empty list on a
non-trivial task is not credible.

### 6. Deviations from the brief

Anything where you did something the brief told you not to, or did not do something it told you
to. Per entry: what the brief said, what you did, and why.

This is separate from section 5 on purpose. Section 5 is filling a gap; this is overriding a
decision. If a deviation was driven by a problem you found in the brief, state the problem and the
replacement separately — the problem being real does not establish that the replacement is right.

### 7. Findings & gaps

- Anything you could not do, and what blocked it.
- Anything you noticed that is wrong but out of scope — reported, **not** fixed.
- Assumptions you are relying on that the brief did not state.
- Anything you believe is a defect in the brief, the task document, or the spec.

Read this section back before you finish: if it contains something you actually *changed*, it
belongs in section 5 or 6, not here.

### 8. Review map

Where a reviewer should look, hardest first.

- Rank the changed hunks by risk, riskiest first, one line each on why.
- Name anything you are **not** confident in.
- Name anything a passing suite does **not** prove here — the cases you did not cover, the
  behaviours no test observes.

Then the final numbers, exactly as the tools printed them: per-suite passing/files/skipped/todo,
type-check or compile result, lint errors and warnings. Include the line that proves the suite
**ran** — the tests-run count, the collected count, the task outcome — not only that it passed.
If coverage was asked for, list the changed lines and branches no test executes.

### 9. Improvements

Under the improvement budget in the brief. Three lists, each of which may be "none":

- **Applied (green).** What you changed, why, and **which hunk it is** — it must be a separate,
  clearly labelled hunk, never mixed into a functional change. State that the existing tests
  passed unchanged; if any test had to change, it was not behaviour-preserving and belongs below.
- **Proposed (amber).** What you would change, the sketch, and what it would cost. Not started.
- **Escalated (red).** Anything that would change a decision the spec or the brief fixes, the
  public surface, a dependency, or the protocol. Describe it, give options and a recommendation.
  Do not do it.

If you found nothing worth improving, "none" is a perfectly good answer. Do not manufacture one.
```

---

## Why each added section exists (reviewer's note — do not paste)

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

**None of these make the report trustworthy.** They make it *checkable*. The verification still
happens in `subagent-review`, against the diff and a gate you re-run yourself.
