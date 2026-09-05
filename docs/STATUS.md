# Status

What is proven, what is outstanding, and which decisions are still open. Written for whoever picks
this up next — read it before trusting any "it works" claim elsewhere in the docs.

> **Provenance.** This project was developed in another repository under the name `pi-delegate`,
> planned as two OpenSpec changes. Those planning artifacts were **not** carried over; this file is
> the distilled record of where they had got to, reconciled against a verification run made in this
> repo. Where a number below comes from that plan, it is labelled as such.

---

## Verified here

A full verification run of this repo, on `pi` **0.85.0**, Node 22:

| Suite | How | Result |
|---|---|---|
| Extension unit tests | `cd pi-extensions/pi-renew && npx vitest run` (excluding the two live files) | **263 passed**, 27 files |
| Extension typecheck | `npx tsc --noEmit` | **clean** |
| Live restart e2e (`new-session`) | `npx vitest run test/restart-e2e.test.ts` | **passed** — a real `pi --mode rpc`, a pre-seeded session, one `/pi-renew` restart, a second session file with `parentSession` = seed, the first turn back at the input floor, clean exit, no `extension_error` |
| Live renewal-state | `npx vitest run test/renewal-state-live.test.ts` | **passed** |
| Driver library | `cd .claude/skills/pi-driver-common && node --test` | **50 passed** |
| tmux driver | `cd .claude/skills/pi-subagent-tmux && node --test` | **11 passed** |

**Re-verified after the `delegate_*` → `renew_*` rename and the development-skill move**, on `pi`
**0.85.1**: the unit suite (263 passed, 27 files), the typecheck, the driver library (**53** passed —
three new `readDefaultModelId` cases) and the tmux driver (11 passed) are all green; a live
`pi --mode json` session loads the extension and reports exactly `renew_session`,
`renew_from_handover` and `set_renewal_context` with no `extension_error`; and **both live tests
pass**, run against an isolated agent directory (see precondition 2 below).

**No model is pinned anywhere.** The driver skills pass no `--model` unless a caller supplies one,
so `pi` resolves the default from its own settings; the two live tests read the same
`defaultProvider`/`defaultModel` pair (`test/default-model.ts`) so a seed session file names exactly
the model the spawned `pi` will pick. Every previous hardcoded pin in this repo eventually went
stale — twice — and each time the failure read as a restart defect rather than a model problem.

Two environment preconditions, both of which produce a *silent* failure when unmet — the live tests
report "extension did not load" and nothing says why:

1. **The checkout must be trusted.** `pi`'s non-interactive modes never prompt for trust and quietly
   ignore project-local resources without it. Add the checkout to `~/.pi/agent/trust.json`, or run
   `/trust` once in an interactive session in it.
2. **No second copy of this extension may be installed.** The live tests load the extension with an
   explicit `-e` *without* `-ne`, so anything in `~/.pi/agent/settings.json` loads alongside it. A
   second copy — an older checkout, the pre-rename `pi-delegate` — registers the same three tool
   names, and `pi` refuses the loser with `Tool "renew_session" conflicts with …`. Whichever copy
   loses, the test's readiness gate then reports the extension as absent.

   **This bites whenever `pi-renew` is installed from the checkout you are testing**, which is the
   normal development setup. The fix that needs no change to the real environment is a throwaway
   agent directory with `packages: []`:

   ```bash
   D=$(mktemp -d)
   python3 - "$D" <<'EOF'
   import json, os, sys, shutil
   src = os.path.expanduser("~/.pi/agent")
   s = json.load(open(f"{src}/settings.json")); s["packages"] = []
   json.dump(s, open(f"{sys.argv[1]}/settings.json", "w"), indent=2)
   for f in ("auth.json", "models.json", "models-store.json", "trust.json"):
       shutil.copy(f"{src}/{f}", sys.argv[1])
   EOF
   PI_CODING_AGENT_DIR=$D npx vitest run test/restart-e2e.test.ts test/renewal-state-live.test.ts
   ```

   `auth.json` and `models.json` matter: without them the run reaches the model with no credentials
   and fails as `usage.input: 0`, which looks nothing like a configuration problem.

## Outstanding

### Workstream A — the restart primitive and the `/renew-loop` protocol

The plan recorded **37 of 42** items done. All the open items are *live-run* items; none is unwritten
code. The list below is restated in the vocabulary of the current protocol — turns and a budget, with
brief-and-review as an opt-in mode — which changed what a live run has to cover, not how much of it
is outstanding.

| Item | What it needs |
|---|---|
| Non-mocked e2e, `compact` half | The `new-session` half is green (above). The `compact` scenario is model-gated and fire-and-forget, with no deterministic raw-RPC trigger; its payload is covered by `test/restart-compact-payload.test.ts`, and its live run belongs to the full-loop runs below |
| Live run in No-restart mode | The cheapest first validation of the *workflow*: one ordinary session, no extension, no harness — so loop bugs and restart bugs cannot be confused for each other |
| Live run of the plain loop, `ask me between turns` | turn → handover → restart → turn; the fresh session's `usage.input` at the baseline floor; answering "yes" starts the next turn and increments the restart ordinal |
| Live run that ends on its budget | A run whose work outlasts `max N turns` must stop **at** N, report the budget as spent rather than as an error, and hand back a handover the next run adopts. The budget is the only bound every run has, and it has never been exercised live |
| Live run on a deliberately unclosable unit | The no-progress guard must fire within one turn and stop with a report naming the unit, with no commit for the failed unit. **This guard has never fired in anger** — see the recommendation in [`renew-loop.md`](renew-loop.md#how-a-run-ends) |
| Live run in brief-and-review mode | Both halves of a unit across a restart, in each of the two runner lanes the mode falls through — the `subagent` tool, and this session |
| Final reconciliation of [`renew-loop.md`](renew-loop.md) | The banner is honest, and every example and the under-the-hood diagram are reconciled against `prompts/renew-loop.md`. What is left is folding in any troubleshooting entry the live runs surface — a close-out obligation on them |

### Workstream B — restart reliability

Motivated by an on-disk failure (the `product-master` session `01a04384 → 01a043ca`) analysed in
a research record kept outside this repo. Two defects:

- **D1 — unbounded success signal.** The tool returned an unqualified "restart is pending" with no
  in-flight state, so the model re-fired the trigger (five times in the instance) until the run was
  aborted.
- **D2 — unverified payload arrival.** The replacement session never received the assembled payload;
  the handoff only "worked" because an external driver re-prompted and the model chose to read the
  handover file itself.

The plan recorded **9 of 14** items done — the whole extension side:

- a persisted in-flight restart record, scoped and max-aged, that survives the extension being
  re-instantiated on the replacement session;
- an idempotent trigger: a repeat request inside the same live run is a no-op returning a distinct
  "a restart is already in progress — stand down" result, with no second send;
- a pre-dispatch resolvable check that routes an undispatchable restart into the existing
  `reportRestartFailure` channel instead of a silent "pending";
- a "pending, never done" result contract with a machine-readable status token;
- an observable "handoff delivered?" surface — the D2 proof;
- stand-down wording carried in the high-context reminder and the tool result.

Open — all of it **driver-side**:

| Item | State |
|---|---|
| Supervision rule: a restart with no settled continuation turn inside a bounded window is a distinct, reported failure | The pure verdict core exists and is unit-tested: `.claude/skills/pi-driver-common/supervision.js` (`success` / `no-continuation` / `already-processing` / `pending`, a bounded window, and the "already processing" classifier). **The live wiring is not built** — no driver yet detects a real restart, delimits the post-restart event slice, or emits the signal against a running session |
| Classify the "already processing" `extension_error` as a restart failure | Classifier written and unit-tested; not wired |
| Bounded, non-blocking supervision with a stable outcome | Same |
| e2e reproducing the failing shape: one send, no re-fire, loud-not-silent | Not started |
| e2e for the healthy path: one call → one settled continuation turn → reported success | Not started |

## Open decisions

**1. `renew_session`'s default `strategy` is still `compact`.** The intended eventual default is
`new-session`; the flip was held back until the `new-session` path had a verified live run. That run
is now green (above), so the flip is unblocked — but it is a **breaking change** for any caller
relying on the current default and has not been made. `/renew-loop` is unaffected either way: it passes
`new-session` explicitly on every call, and must keep doing so, because `compact` does not replay a
registered renewal context.

**2. Which `pi` version the live proofs are pinned to.** The history is worth knowing, because it
produced two wrong diagnoses:

| | |
|---|---|
| The extension was written and typechecked against | `pi` 0.84.2 |
| A downgrade to 0.84.0 turned the live e2e red | diagnosed as a version regression — a whole-message `/pi-renew` no longer dispatching |
| An upgrade to 0.84.4 left it red, throwing `Cannot read properties of undefined (reading 'sessionId')` | diagnosed as an SDK incompatibility, and escalated as a blocker |
| The actual cause | **neither.** An unbound `getSessionId` call introduced in this project's own restart-guard work was killing the restart on *every* version. With it fixed, 0.84.4 went green |
| Verified in this repo | green on **0.85.0**, the version currently installed here, with `devDependencies` still pinned at 0.84.4 |

The lesson is the one worth carrying: **a red live test is not evidence about the runtime version
until the code path has been read.** The pin in `devDependencies` and the runtime version have drifted
apart and should be reconciled deliberately, not by assuming either one is the problem.

**3. The plan's numbering does not live here.** If this project resumes under a spec-driven workflow,
the two workstreams above are the change proposals to re-create; nothing in this repo depends on them.
