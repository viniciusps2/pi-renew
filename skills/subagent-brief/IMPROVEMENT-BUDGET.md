# The improvement budget

What an agent may improve **on its own authority** while implementing or reviewing a batch, what it
must propose instead, and what it must escalate. Shared by `subagent-brief` (which states the budget
as a constraint), `subagent-review` (which triages what came back), and the `/loop` driver (which
decides where an escalation goes).

The problem it solves: without a sanctioned path, a real improvement either gets **smuggled into the
functional diff** — where it destroys the review surface, because you can no longer tell the feature
from the cleanup — or gets **dropped**, because nobody had authority to act on it.

**The design in the spec always wins.** Nothing in this file authorises a change to a decision the
spec, the design document or the brief has fixed. An "improvement" that contradicts one of those is
a design change; it goes to 🔴 regardless of its size.

---

## The three lanes

### 🟢 Green — apply it, no permission needed

**Every one of these must hold.** One failure drops it to 🟡.

- behaviour-preserving, and **existing tests pass unchanged** (if a test had to change, it was not
  behaviour-preserving — see refactor equivalence in [VERIFICATION-MENU.md](VERIFICATION-MENU.md));
- confined to files already in the brief's allowed-files table;
- **≤ ~15 net lines**, and one named refactor — not a sequence of them;
- no exported signature change, no new dependency, no frozen area (generated code, contracts,
  fixtures, snapshots);
- contradicts nothing the spec, the design document or the brief fixes;
- **at most one per batch** from the child. The driver's own review fixes are counted separately.

**How it lands — the load-bearing rule:**

> The improvement is applied **after** the batch's functional review is green, as a **separate
> commit** (`refactor:` or `test:`, never folded into the batch's `feat:`), and the gate is re-run
> after it.

An improvement that arrives *inside* the diff under review makes the review surface "the feature plus
the cleanup", and neither gets read properly. A child that cannot commit (the normal case) keeps the
improvement as a separate, clearly labelled hunk and says so in its report; the driver commits it
separately.

### 🟡 Amber — propose it with a sketch, do not apply it

Anything green-shaped that fails a green condition, and specifically:

- more than ~15 net lines, or several refactors that only make sense together;
- a new abstraction, or a helper extracted for a second caller — **the rule of three holds**: two
  occurrences are not duplication;
- a shared helper touched, where the blast radius leaves the batch;
- a test's *intent* changed, as opposed to a test moved or renamed;
- anything you would need to re-baseline the gate to justify.

Report it as: what you would change, why, the sketch, and what it would cost. Do not start it.

### 🔴 Red — a decision that is not yours

- it would change a decision the **spec, design document or brief** fixes;
- it changes the **public surface** — an export or a `public`/`protected` member, a tool parameter, a
  CLI flag or command name, an environment variable, a persisted or wire shape;
- it adds or upgrades a **dependency**;
- it touches the **protocol or the state machine** — restart, handshake, guard, lifecycle;
- it would require a **spec delta update** to be correct.

Red items are never applied in-phase by anyone, in any mode.

---

## Where a 🔴 goes — mode-dependent

This is the one place the lane depends on how the loop is being driven, and it is deliberately the
only such place.

| Continuation mode | What happens to a 🔴 improvement |
|---|---|
| `stop` / `ask` / a one-off delegation | Surface it to the user at the turn's natural stopping point, as numbered options with a recommendation. |
| **`auto`** | **Do not stop the loop.** Append it to the handover's `## Decisions pending` section and name it in the turn's progress/report line. Continue to the next unit. |

**In `auto`, a 🔴 improvement is never a hard stop.** It is optional work by definition — it is never
on the critical path of the unit in hand, so deferring it cannot make the unit wrong. Halting an
unattended loop for an opportunity is the wrong trade.

**This carve-out covers opportunistic improvements only.** It does **not** touch the existing hard
stops, and must never be used to keep an unattended loop moving past one:

- a **correctness finding** in the unit's own work still stops the loop;
- a **blocked deliverable** — something the unit needs that you cannot do — still stops the loop;
- a **conflict, an ambiguity about intent, or a second review escalation of the same unit** still
  stops the loop.

If you find yourself reaching for this rule to avoid stopping, the thing you are holding is not an
improvement.

### The `## Decisions pending` entry

One block per deferred 🔴, in the handover, so the queue survives the cold start:

```markdown
### DP-<n>. <one-line title> — 🔴 deferred by auto mode, <date>
**Found:** during <unit>, in `<file>`.
**Opportunity:** <what could be better, and the evidence it is worth doing>.
**Why red:** <which trigger — spec-fixed decision / public surface / dependency / protocol>.
**Options:** (i) <…> (ii) <…> (iii) leave as is. **Recommendation:** <one>.
**Cost if deferred:** <what gets more expensive the longer it waits — or "none, it keeps">.
```

Carry unresolved `DP-` entries forward into every later handover. Resolving one is a **user
decision**, and it becomes its own unit in the task list — never a silent fold-in to an unrelated
batch.

---

## What to look for

Bounded on purpose: this is a list of things worth ten minutes, not a licence to rewrite.

- a literal or a table duplicated a **third** time;
- a magic number or repeated string with no name;
- a helper with one caller, worth inlining;
- a boolean parameter that is really two functions;
- a comment explaining what the code should have said;
- nested conditionals that inverting into guard clauses would flatten;
- a dead branch, or an abstraction with exactly one implementation;
- an export nobody imports (see the dead-surface sweep);
- a test helper copy-pasted across specs;
- a name that disagrees with the spec's domain vocabulary;
- an import, dependency or `using`/`import` block left behind by the change;
- in shell: a missing `set -euo pipefail`, an unquoted expansion, a `mktemp` with no cleanup `trap`
  — these are green-lane fixes only when the script is already in the allowed-files table.

**Not on the list, and not an improvement:** simplifying a test double. A double is often shaped the
way it is precisely so it can express a failure — a real-typed or autospecced double, a stub that
reproduces the collaborator's non-zero exit codes, a mock stubbed to raise. Flattening it to
something more convenient is the weakening that lets the defect through. If a double looks
over-engineered, read its test's **name** before touching it. See test-double fidelity in
[VERIFICATION-MENU.md](VERIFICATION-MENU.md).

**Also not improvements:** removing a `set -euo pipefail`, widening an exception clause, replacing a
specific assertion with a looser one, or deleting a guard whose test you have not read. Each of those
reads as simplification and is a behaviour change.

---

## Reporting

The child reports under the report contract's **section 9, Improvements**: what it applied (🟢, with
the separate hunk named), what it is proposing (🟡, with the sketch), and what it is escalating (🔴,
with options and a recommendation).

The reviewer ratifies or rejects each 🟢 exactly as it ratifies a decision the brief did not fix —
**an applied improvement is an unreviewed change until someone reads it**, and it is the one part of
the diff no acceptance criterion covers.
