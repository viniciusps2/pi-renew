# The improvement budget

What an agent may improve **on its own authority** while implementing or reviewing a batch, what it
must propose instead, and what it must escalate — plus, in the 🔧 lane at the end, the one thing it
may **repair outside its allowed files**, because the unit cannot land until somebody does. Shared by
`subagent-brief` (which states the budget as a constraint), `subagent-review` (which triages what
came back), and the `/renew-loop` driver (which decides where an escalation goes).

The problem it solves: without a sanctioned path, a real improvement either gets **smuggled into the
functional diff** — where it destroys the review surface, because you can no longer tell the feature
from the cleanup — or gets **dropped**, because nobody had authority to act on it.

**The design in the spec always wins.** Nothing in this file authorises a change to a decision the
spec, the design document or the brief has fixed. An "improvement" that contradicts one of those is
a design change; it goes to 🔴 regardless of its size. This governs the 🔧 repair lane too: being
blocked earns an agent the right to **fix a broken tree**, never the right to **redesign the
solution** in order to get itself moving again.

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

## Where a 🔴 goes — it depends on who is watching

This is the one place the lane depends on how the run is being driven, and it is deliberately the
only such place.

| How the run is driven | What happens to a 🔴 improvement |
|---|---|
| A person is about to see the turn — the run pauses between turns, this is its last turn, or it is a one-off delegation | Surface it at the turn's natural stopping point, as numbered options with a recommendation. |
| **Unattended** — the run restarts into the next turn by itself | **Do not stop the run.** Append it to the handover's `## Decisions pending` section and name it in the turn's progress/report line. Continue to the next turn. |

**On an unattended run, a 🔴 improvement is never a hard stop.** It is optional work by definition —
it is never on the critical path of the unit in hand, so deferring it cannot make the unit wrong.
Halting an unattended run for an opportunity is the wrong trade.

**This carve-out covers opportunistic improvements only.** It does **not** touch the existing hard
stops, and must never be used to keep an unattended loop moving past one:

- a **correctness finding** in the unit's own work still stops the loop;
- a **blocked deliverable** — something the unit needs that you cannot do — stops the loop **unless
  the 🔧 repair lane below clears it first**. Being blocked and needing a decision are not the same
  state, and only the second is a question for a person;
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

## 🔧 The repair lane — blocked is not the same as undecidable

The three lanes above triage work that is **optional**. This one triages work that is not: a defect
**outside** the unit's allowed files that stops the unit being verified or landed at all. It is the
only rule here that authorises changing a file the brief forbade, and it exists because two states
get conflated that need completely different things:

| The unit cannot proceed until… | What it needs |
|---|---|
| something **mechanical** is repaired | the repair. Nobody has a decision to make |
| someone **chooses between designs** | the user. Stop, however the run is driven — unattended included |

**The shape it covers.** The unit's own work is right; the gate is red for something the unit did not
introduce — a duplicate registration that only fails once a consumer resolves it by type, a fixture
an earlier unit left broken, a neighbouring module that no longer compiles, a stale wiring nobody has
exercised since it landed. The repair almost always lives in files belonging to a unit already
ticked, or to one not yet reached. **That is not a reason to stop.** The allowed-files table exists
to keep a review surface readable, not to make a broken tree somebody else's problem.

**A red gate is not the only shape.** The same triage runs when nothing has executed yet: the analyse
half, sizing a unit, finds that the approach the handover recorded cannot work — it would fail the
unit's own acceptance criteria, or it contradicts the design document the unit implements. There is
no failing command to paste, so step 1 takes its other form: name the mechanism that would break and
the source that settles it, held to the same standard of evidence. Steps 2 and 3 are unchanged. A
plan defect is still a defect the unit did not introduce, and finding it before execution is not a
reason to stop where finding it after would not have been.

### Step 1 — Prove it is pre-existing, before repairing anything

An agent that "unblocks" its own bug has laundered a correctness finding, which is a hard stop. So
establish, with evidence you can paste into the handover, that the failure is **not** the unit's:

- reproduce it on something that references **none** of the unit's code — a test from an earlier unit
  is the strongest form available;
- or reproduce it on a clean tree: stash the change including untracked files, run the gate, restore;
- and name the **first** failing thing in the chain. If that is the unit's own code, you have a
  correctness finding, not a blocker, and the loop stops.

Without that evidence, treat the failure as the unit's own. The asymmetry is deliberate — repairing
what you just broke and calling it a repair is the one failure this lane could otherwise introduce.

**A child's blocked verdict is an input to this step, never the output of it.** The claim needing
independent proof is precisely the one the child is least able to make about itself. If it also wrote
its blockage into a tracking document it was told not to touch — a banner in the handover, a note in
the task list — revert that edit and restate the finding in your own words from your own run. The
handover is the driver's; a child that edits it has crossed a constraint, and that stays worth noting
in the review even when its technical claim turns out to be right.

### Step 2 — Apply the design-neutrality test

Ask it of the **shortest correct repair**, not of the repair you would prefer. Every trigger is a 🔴
trigger, in the same words:

- does it change a decision the **spec, the design document or the brief** fixes?
- does it change the **public surface** — an export, a `public`/`protected` member, a tool parameter,
  a CLI flag or command name, an environment variable, a persisted or wire shape?
- does it add or upgrade a **dependency**?
- does it touch the **protocol or the state machine** — restart, handshake, guard, lifecycle?
- would it require a **spec delta update** to be correct?
- does it **weaken a test** — a deleted assertion, a loosened matcher, a `skip`, a simplified double?

**All six "no" → repair it.** Outside the allowed-files table, in another unit's files, without
asking, whoever is watching. It is mechanical; there is no decision in it for anyone to
make, and stopping an unattended loop to be told "yes, fix the build" is the same wrong trade as
stopping it for a 🔴 improvement.

**Any "yes" → the repair *is* the decision.** Stop and report, in every mode, with the step-1 evidence
and the options you can see. This is the line the lane must never cross.

**Two candidate repairs are not automatically a "yes".** Ask what actually differs between them:

- **Different spellings of the same mechanical fix** — `@Primary` on the config's bean or
  `@Qualifier` on the one consumer; the guard in the caller or in the callee — is **not** a decision.
  Take the narrower, more local one, or the one matching what the surrounding code already does, and
  record which and why in the `RP-` entry. Stopping to be asked "which annotation?" is the same wrong
  trade as stopping to be asked "may I fix the build?".
- **Repairs that imply different designs, or different behaviour** — one restores the intended wiring
  and the other changes which implementation wins in production — **is** a decision. Stop.

The question is never "is there more than one way to do this", it is "do the ways disagree about the
design".

### When the repair lands in a unit already ticked

The lane already expects the files — "the repair almost always lives in files belonging to a unit
already ticked". What needs its own rule is the sharper case: the repair changes that unit's
**acceptance evidence** rather than only its code. An assertion an earlier unit pinned now describes
behaviour the design says is wrong.

**The tick stands.** A repair never re-opens a unit, un-ticks it, or amends its commit. It lands in
front of the current unit as its own `fix:`, exactly like any other repair, and the earlier unit's
history keeps meaning what its review said it meant.

**One extra question, and it is the whole decision:** read what fixed the assertion you are about to
change.

- the earlier unit's **brief or the design fixed it** — the pinned value was a decision somebody made
  → trigger 1, the repair *is* the decision, stop;
- it merely **recorded the behaviour of the day**, because nothing consumed the value yet → it is
  incidental, and updating it to track the corrected behaviour is part of the repair.

Name which of the two in the `RP-` entry, with the line of the brief or design that settles it. "I
could not find one" is not the fallback answer: an assertion whose provenance you cannot establish is
treated as fixed, and you stop.

**Changing an assertion is not the same as weakening one.** Trigger 6 is *weaken* — a deleted
assertion, a loosened matcher, a `skip`, a simplified double. Replacing one with an assertion that is
equal or stronger, tracking behaviour the design specifies, does not trip it. That does not get you
past the question above: they are separate gates and both have to pass.

### Step 3 — Land it as a repair, not as part of the unit

- **The smallest change that removes the blockage.** Not the neighbourhood's cleanup, not the
  refactor you would do if those files were your unit. Anything beyond the blockage is 🟡: record it,
  do not do it.
- **Its own commit** (`fix:`), **before** the unit's, carrying the step-1 evidence in the message.
  Re-run the gate after the repair and again after the unit. The unit's own diff must still read as
  the unit.
- **Do it yourself, or brief a new child** whose allowed-files table names exactly the repair's
  files. Never widen the original child's table mid-run — a child already told to stop and report is
  the wrong place to re-open scope.
- **Add the cheapest check that would have caught it**, where the tier and the defect allow. Often
  the test from step 1 already is that check, once something actually runs it. If you add none, say
  why.
- **Record it in the handover** as an `RP-` entry, and name it in the turn's report line. A repair
  nobody mentions reads as scope creep in the next reviewer's diff.

### When to stop anyway

- the repair does not turn the gate green — you are debugging a broken baseline, not executing a
  unit;
- a second, unrelated blocker surfaces in the same unit;
- the repair grows to roughly the size of the unit itself. At that point it **is** a unit: stop, and
  let it be scheduled as one.

### The `## Repairs` entry

One block per repair, in the handover, beside `## Decisions pending`:

```markdown
### RP-<n>. <one-line title> — 🔧 repaired during <unit>, <date>
**Symptom:** <the failure, and the exact command that printed it>.
**Pre-existing because:** <step-1 evidence — what reproduced it with none of the unit's code>.
**Root cause:** <where it actually is, and which unit landed it>.
**Repair:** <the change>, in `<files outside the allowed-files table>`. Commit `<sha>`.
**Design-neutral because:** <the six triggers, answered>.
**Touches a ticked unit's evidence:** <which assertions, and what fixed them — or "none">.
**Affects later units:** <whose scope this shrank or changed — or "none">.
```

**The last line is the one that gets forgotten.** A repair inside a not-yet-reached unit's files
changes what that unit still has to do, while its brief will be written from a task document that
still describes the work as pending. Carry `RP-` entries forward exactly like `DP-` entries, and run
the staleness sweep against them when that unit comes up.

### What a repair is never a licence to do

**Widen the gate.** A latent defect that survived several units usually means the gate has a blind
spot — a suite that never starts a real context, a module nothing type-checks, an integration test
no ticked unit ever ran. Repairing the defect is mechanical; changing what "done" measures is a
decision about the project's standard of proof. Record the blind spot as a 🔴 in `## Decisions
pending`, with the evidence, and carry on.

**Narrow the unit.** The tempting alternative to a repair is always the same: tick the unit on the
part of the gate that *is* green and defer the failing criterion to a later unit. That is the mirror
image of a repair, and unlike a repair it is always a decision — it changes what "done" means for a
unit somebody specified. When a design-neutral repair exists, take it. When it does not, **stop**.
Never lower a unit's acceptance criteria to keep the loop moving.

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
