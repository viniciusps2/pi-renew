# Brief template

Fill in every section. A section with nothing to say gets one line saying so — an absent section reads
as an oversight, and the sub-agent fills the gap with a guess. Guidance lines are marked `>` and are
deleted from the finished brief.

---

```markdown
**Tier: <T0 | T1 | T2 | T3>** — <the marker that fixed it, in a few words>.
Checks this batch must satisfy: <from VERIFICATION-MENU.md Part 2's matrix>.
Checks it need **not**: <the ones the tier rules out, named so you do not go looking for them>.

# Task

<One line: what to implement. Then, explicitly, any work deferred to this task by earlier work —
a sub-agent cannot infer that something was postponed here.>

# Read these FIRST, before writing anything

Read them in this order. Do **not** work from this brief's summaries where a source file exists —
this brief fixes decisions, the sources carry the detail.

1. `<path/to/task-document>` — your task file.
2. `<path/to/spec>` **§X and §Y** (around line N) — the authoritative <table / rule set>.
3. `<path/to/nearest-existing-twin>` — the thing you are mirroring.
4. `<path/to/types-or-interfaces>` — the types you will implement.
5. `<path/to/tests-you-will-change>` (the whole file).
6. `<path/to/code-under-test>` lines ~N–M — the behaviour you are writing a test for.

> Anchor every entry: a file alone sends it reading thousands of lines, a file plus §/line is a
> two-minute read. Order: task, authority, twin, types, tests.

# Context

<Repo shape and the layering conventions. The domain vocabulary the task uses. What this change is
for. What earlier work already landed and what it deliberately left. Enough that the reading list
makes sense — no more.>

# Design decisions ALREADY FIXED — do not re-litigate any of these

> Numbered, each with its reason — work through SKILL.md's Phase 1 categories. Typical entries:

1. **<Part of the task document that is stale.>** `<X>`, `<Y>` and `<Z>` already shipped in
   <earlier work> — `<file>` already contains `<symbol>`. **That part of the task file is stale.**
   Do not touch `<paths>`, and run no regeneration. There is no <contract/schema> change here.
2. **Identity:**
   - `slug: '<exact>'`
   - `name: '<exact — a test double already uses this string>'`
   - `description`: use exactly:
     `'<the complete string, byte for byte>'`
3. **<The table / step list / field set>** — every field the spec table does not show, taken from
   the twin: <inline table with one row per item and one column per field>.
4. **<Rule set>** is <identical to / derived from> `<source>`, character for character. Copy it
   from `<file>`. <State what changed around it and what did not.>
5. **<Thing X> must be ABSENT**, not present-and-disabled. There must be no path to enabling it.
6. **Duplicate the literal; do NOT share <definitions> between the two <things>** via a helper, a
   spread, or a mutated common array. They are meant to be able to drift — that is the accepted
   cost of <decision>. *(Or the opposite — but say which, and why.)*
7. **Ordering / dependency:** <what must run before what, and the constraint that forces it>.
8. **<User-visible string>** must read exactly: `<the complete line, not the substituted value>`.
9. **<Existing tests that your change makes wrong>** — see part <N>; the correct new expectation
   is <X>, not a relaxed version of the old one.
10. **<Mapping rule>** with a worked example: `<concrete input>` → `<concrete output, in full>`.
11. **For the part-<N> test, reach the state under test via `<shortcut>`** rather than <the long
    path>. <One sentence on why that works.>
12. **Do not add, remove, or regenerate anything under `<frozen dir>`,** and do not touch
    `<frozen files>`. <One sentence on why they are frozen.>

# What to build

## Part A — <the core>

> *Verification:* <the checks this part must satisfy, and the ones it need not — e.g. "T2:
> assertion strength, one kill-mutant per criterion, a test through the real entry point. No
> crash-consistency walk (nothing persisted), no determinism run (no async)".>

- **NEW** `<path>`, exporting `<names>`, importing `<types>` from `<where>` exactly as the twin
  does. Carry a file header comment in the twin's style: what this is, and why <the omission> is
  omitted.
- `<path>`: <the specific change>.

## Part B — <the tests your change invalidates>

<Name each test verbatim. State the correct new expectation and the assertion that proves it.
Tell it to sweep for others (`grep -rn "<thing>" <roots>`) and fix them the same way — and that
weakening an assertion to make it pass is not a fix.>

## Part C — <deferred coverage this task unblocks>

<Why it could not be tested before and can be now. Then a checkbox per assertion:>

- [ ] <Observable outcome 1.>
- [ ] <Observable outcome 2 — and, where the fixture could be green for the wrong reason, the
      constraint that prevents it: "the three values must actually differ", "the two orderings
      must disagree", "the identifiers must be unique to this spec".>

## Part D — docs

<Which file, which section, where it goes relative to its neighbours, and what must be called out
explicitly so a reader does not file a deliberate omission as a bug. Say what NOT to restate.>

# Acceptance criteria

Tick each only when a test you can name proves it.

- [ ] <Outcome, stated observably — not "implement X" but "X does Y, asserted by Z".>
- [ ] <For an absence: assert on the set of things that exist, not on a disabled flag. A test that
      only checks the flag does not satisfy this.>
- [ ] <For an equivalence: assert deep equality against the source of truth, so the two can never
      silently drift.>
- [ ] <Idempotence / repeat-run behaviour, if the change touches anything that runs at startup.>
- [ ] <A **negative** criterion — something that must NOT happen. Required at T2+; without one the
      whole set describes only the happy path.>
- [ ] **<Neighbouring things> are unchanged** — their existing assertions still pass untouched.
      Do not edit those tests.
- [ ] **<Suite A>: more than <N> passing, <M>+ files, 0 failures.**
- [ ] **<Suite B>: more than <N> passing, 0 skipped, 0 todo.** (It is <N> right now — a run
      reporting fewer, or any skipped, means the suite did not really run.)
- [ ] **The line proving the suite ran** is in your report: `<Tests run:` / `collected N items` /
      the task outcome / the test-file count — whichever this project prints. A pass line from a
      cached or zero-collection run looks identical to a real one.
- [ ] `<typecheck command>` clean.
- [ ] `<lint command>` → **0 errors**, and no new warnings outside <the documented house-style
      exception>.

> At least one criterion must be a number you measured yourself, on a clean tree, with the command
> that prints it — the cheap, hard-to-fake proof that the suite ran.

# Commands

```bash
<the exact gate, copy-pasteable, writing to per-task log paths>
<the output-normalisation step, if logs need it before grepping>
<the grep that surfaces failures>
```

- <Which suite is slow and silent, and that silence is normal.>
- <Known trap signature> → **report it rather than fixing it**; it is <infrastructure / another
  task's scope>.

# Constraints

- **Files you may create or modify — nothing else:**

  | File | Change |
  |---|---|
  | `<path>` | new |
  | `<path>` | <what changes> |

  If you become convinced another file must change, **stop and report it** instead of changing it.
  Reporting it is a live path, not a dead end — the caller can repair a blocking defect outside this
  table, and does it far more cheaply when your report carries the evidence: the exact command and
  failure, whether it reproduces without your changes, and the smallest fix you can see.

- **Do NOT touch** `<generated>`, `<contracts>`, `<fixtures>`, `<other apps/libs>`.
- **Do NOT run any git command that touches this repository's history or index** (`add`, `commit`,
  `checkout`, `stash`, `push`, `reset`, `restore`). Read-only `git status` / `git diff` / `git show`
  are fine, and creating a git repo inside a temp-dir test fixture is fine. The caller owns git.
- **Do NOT edit** `<plan file>`, `<task file>`, or `<handover/tracking doc>`. The caller ticks the
  boxes after review.
- **No sub-agents.** You are a leaf: do not call the `subagent` tool, do not spawn a child, and do
  not hand any part of this unit, however small, to another agent. You were launched in **fresh context**
  — you were handed this brief and the project context, not the caller's conversation — so work from the
  brief. Do the whole work here and report back from here.
- **No weakening.** Do not delete or relax an existing assertion, do not disable, skip or ignore a
  test (`.skip`/`.todo`, `@Disabled`, `@Ignore`, `@pytest.mark.skip`/`xfail`, bats `skip`), do not
  loosen a strict matcher to a permissive one, and do not substitute a wildcard where a literal
  belongs. Do not simplify a test double — several are shaped as they are precisely so they can
  express a failure. If an existing test genuinely encodes now-obsolete behaviour, the only such
  tests are the ones named in part <N> — anything else you believe needs relaxing, **report
  instead of changing**.
- **Improvement budget.** If you see something worth improving that is behaviour-preserving, inside
  the table above, under ~15 net lines, changes no exported signature and no dependency, and
  contradicts nothing this brief or the spec fixes — **apply it, at most one, as a separate clearly
  labelled hunk**, and report it. Anything larger, anything touching a shared helper or a test's
  intent, and anything that would change a fixed decision, the public surface, a dependency or the
  protocol: **report it with a sketch, do not do it.** Lanes: `IMPROVEMENT-BUDGET.md`.
- <House style that would otherwise read as a mistake, and why it is deliberate.>
- Match the surrounding comment density: <what the neighbouring files do>.

# Report-back

Follow the report contract in <path to REPORT-CONTRACT.md, or paste it inline>.
```

---

## Trimming for smaller tasks

Sections that never come out: the **Tier** line, **Read these FIRST**, **Design decisions ALREADY
FIXED**, **Acceptance criteria**, **Constraints** (allowed-files table), **Report-back**.

Collapsible on a small, single-file task: fold **Context** into **Task** and **Commands** into
**Acceptance criteria**. Everything else stays — a short brief with no fixed decisions is the same coin
flip as no brief at all.

**Trim by tier, not by feel.** At **T0** the verification lines say so explicitly ("no kill-mutants,
no coverage run, no probes — this batch changes no behaviour"), the improvement budget drops out, and
the brief is often under a page. At **T3** nothing trims: the crash-consistency walk, the negative
criterion and the real-entry-point test are the whole point of the batch.
