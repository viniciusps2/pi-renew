# Why the review is shaped this way

Rationale for [SKILL.md](SKILL.md).

## What the review is actually looking for

Re-running the suite proves the acceptance criteria were satisfied. It says nothing about the space
just outside them, which is where delegated defects concentrate: an assertion too weak to see the
bug it was written for, and a decision the brief left open that the agent settled silently and
presented as settled. Phases 3 and 4 exist entirely to find those two.

## Why the scope applies beyond sub-agents

The same checks fit any agent-authored change — another session working in the same repo, a cloud
agent, a PR you did not write. What varies is only whether a report exists to audit; without one,
every section of the report contract is simply unanswered, and you run the checks with no map.

## Why the snapshot before mutating

The brief tells the sub-agent to leave the tree dirty so the diff is the review surface. That makes
`git checkout -- <file>` — the reflex revert — destroy the entire delegated change, because it
reverts to HEAD rather than to the state you are reviewing. The baseline you want lives in the
working tree, so the snapshot has to live outside git. If the work *is* committed, `git checkout --`
is safe, but the snapshot costs one command and removes the need to decide.

## Why lint is measured as a delta

A total tells you nothing: the interesting signal is one new warning in non-test source hiding among
a dozen innocuous house-style ones in test code. Only stash-measure-restore separates them.

## Why the review is sized before it starts

The checks are not free, and a review that costs more than the work it checks is a sizing error
rather than diligence. The tier decides the depth; declaring it — including what was *not* run — is
what stops a skipped check from being indistinguishable from a forgotten one. The asymmetry is
deliberate: raise a tier freely on seeing the diff, lower one only in writing.

## Why the reviewer picks their own mutant

An author's kill-mutant tests the author's model of their own test. It was chosen, consciously or
not, because they already knew it was caught — so it confirms what they believed and nothing else.
A mutant drawn independently from the operator menu tests the assertion instead. The author's mutant
stays useful as a second data point, and a criterion whose mutant *cannot* be named is still the
cheapest signal in the report.

## Why a red improvement does not stop an unattended loop

An opportunistic improvement is by definition not on the unit's critical path: deferring one cannot
make the unit wrong, so halting an unattended run to ask about an opportunity trades a working loop
for a question that could have waited. Recording it in the handover keeps it from being lost, which
is the actual risk. The carve-out is narrow on purpose — a correctness finding, a blocked
deliverable, or an ambiguity about intent still stops the loop, because each of those *does* make the
unit wrong if guessed at.

## Why your own numbers, always

Quoting the agent's numbers — even in notes written afterwards — launders an unverified claim into
the project's record, where the next reader has no way to tell it apart from a measurement.
