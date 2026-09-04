# Research: `delegate_context_high` fails with "Agent is already processing…" — root cause, scope, and where the hole is

- **Date:** 2026-08-27
- **Author:** unattended investigation
- **Status:** dated research record. It is carried into this repo as the evidence behind the
  restart-reliability work described in [`STATUS.md`](STATUS.md); it is **not** maintained as
  current documentation.
- **Follow-up (added 2026-08-27):** §14 records an **on-disk instance** of the failure (`product-master` session `01a04384 → 01a043ca`) and shows it reveals **two defects this document had not named** — **D1** (an unbounded "restart pending" success signal, no in-flight state, so the model re-fires the trigger) and **D2** (the replacement session's own handoff payload never arrives). That instance motivates a separate, independently-shippable change — the restart-reliability work tracked in [`STATUS.md`](STATUS.md).

> **Reading this after the rename.** This investigation predates the project's rename from
> `pi-delegate` to `pi-renew`. Every identifier below has been renamed to match today's code
> (`/pi-renew`, `~/.pi/agent/pi-renew.json`, `pi-extensions/pi-renew/pi-renew.ts`), with one
> deliberate exception: the literal on-disk session directory in evidence row **E20**, which is
> quoted as it actually existed. References to `openspec/changes/…`, `.agents/research/…` and other
> repositories (`codehub`) point at artifacts that stayed in the origin repo — they are cited as
> provenance, not as links you can follow from here.

---

## 1. Research brief and decision sought

**Question as raised.** A session called the `delegate_context_high` tool and it returned:

> `Extension <runtime> error: Agent is already processing. Specify streamingBehavior (steer or followUp) to queue the message.`

The user wants to understand (a) **what that error actually is** mechanistically, (b) **why the delegate path produced it** even though the extension's own send-shape discipline looks correct, and (c) **what the correct, durable fix is** — and whether that fix is already covered by the in-flight change or is a genuine gap.

**Decision sought (for the eventual proposal).** Whether to:
- treat this as an **environmental** failure (stale/duplicate `pi` runtime, session-replacement invalidation) that the *extension cannot* self-heal and only an *external harness* can detect, vs.
- add a **defence in the extension** (e.g., a fallback so a non-resolving restart command is never routed through the throw path, and/or surfacing the swallowed failure), and/or
- both, and where that requirement lives in the change.

---

## 2. Scope, assumptions, and exclusions

**In scope**
- The exact SDK throw site and the code path that reaches it.
- The delegate extension's three senders and the two "send shapes" they encode.
- Whether the `delegate_context_high` (i.e. `strategy: "new-session"`) path can produce *this* error, and under what preconditions.
- What the in-flight change already handles vs. what it does not.
- Prior art in the workspace (the tmux-loop spike; the codehub BUG-1).

**Out of scope**
- Any change to application code (this is a research write-up only; no implementation).
- The `pi-subagents` workflow runtime, MCP, or the general "how do I drive pi in tmux" material beyond where it is directly prior art for *this* error.
- Performance, cost, or UX of the high-context reminder threshold.

**Assumptions (stated; each has a recorded consequence)**
- **A1 — The failing send was the `/pi-renew` restart command, not a content payload.** Consequence if false: the failure is a *content* routed through the command channel (the classic "Case D" silent drop), which changes the fix from "protect the trigger" to "funnel the content through `deliverAs`." The evidence *favours* A1 (see §4, §5); **§14 located an on-disk instance and confirms it** — in that failure window the *only* thing the model sends is the `delegate_context_high` trigger. A1 is therefore a verified fact for that instance (though the *specific throw* stays event-only — §14.3).
- **A2 — The delegate extension is correctly loaded and its tool is present** (the tool ran, so its `registerTool` executed). Consequence if false: the whole analysis shifts to a load failure, which is a different (and more severe) class of bug.
- **A3 — `pi.getCommands()` and the session's dispatch `getCommand()` observe the same runner** in the normal, single-extension case. This is *verified* for a single runner (both call the same `resolveRegisteredCommands`); the throw requires them to observe *different* runners (see §5, §6).

**Exclusions / what I deliberately did NOT conclude**
- I did **not** conclude the extension's send-shape discipline is broken. On the contrary, it is *correct* for every send it documents; the failure is at an *assumption boundary* the SDK enforces with a hard throw rather than a fallback (see §4).

---

## 3. Executive findings

1. **The error is the SDK's own streaming guard, thrown from `prompt()`.** It is not a message the delegate extension composes. The exact line: `agent-session.js:833` — `if (this.isStreaming) { if (!options?.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."); … }`. (Verified fact.)

2. **`isStreaming` is true for the *entire* agent run, including while a tool's `execute()` is running** — `get isStreaming() { return this._isAgentRunActive; }` (`agent-session.js:591`). So *any* `sendUserMessage("/…", {expandPromptTemplates:true})` made from inside a tool, where the `/…` string does **not** resolve to a registered extension command, is *guaranteed* to hit this throw. (Verified fact + reasoned.)

3. **The delegate design is *correct on paper*.** It encodes two send shapes: *command mode* (`sendExtensionCommand`, no `deliverAs` — safe because real extension commands dispatch *before* the streaming check) and *payload mode* (`sendPayload`, `deliverAs:"followUp"` — safe because it queues instead of throwing). The design's *only* load-bearing assumption is: **"the string sent on the command channel is always a *registered* extension command at send time."** (Verified fact, `send-shapes.ts`; reasoned for the assumption's scope.)

4. **On the `new-session` path (the one `delegate_context_high` uses), the *only* throw-capable send is the restart trigger** `sendExtensionCommand(pi, "/pi-renew -- …")`. The prelude goes out as a *custom* message (`triggerTurn:false`, not `prompt()`, cannot throw this) and the delegate-context payload goes out with `deliverAs:"followUp"` (queues, cannot throw). So this specific error ⇒ **`getCommand("pi-renew")` returned undefined on the session that was actually handling the prompt.** (Reasoned conclusion; see §4–§5 for why a *single* runner cannot produce that, which localizes the cause to a stale/split runner — §6.)

5. **The precondition "the command resolves" is violated by a *stale or split extension runner / stale or duplicate `pi` process*, not by a naming desync.** `getCommand(name)` and `getCommands()` both call the *same* `resolveRegisteredCommands()` (`runner.js:403–444`), so within one runner they cannot disagree; a name *collision* renames (`pi-renew:2`) rather than removes, so a collision is a *misfire* (wrong handler runs), **not** this throw. The one structural way `getCommand` misses is when the dispatch session's runner ≠ the runner that resolved the name — exactly the condition pi itself warns about via `this._extensionRunner.invalidate("…stale after session replacement…")` (`agent-session.js:570`) and that the codehub spike labelled **BUG-1: "stale pi process blocks all subsequent invocations."** (Reasoned conclusion, strongly supported; the *specific* failing session is not on disk — T3.)

6. **The failure is *invisible by construction*.** `sendUserMessage` is fire-and-forget (returns `undefined`, not an `await`able promise) and the SDK swallows the throw into an `extension_error` event (`agent-session.js:1945–1946` `.catch`; the throw originates as an unhandled rejection of the returned promise). So the tool reports **success**, the model says **ACK**, and the *only* trace is the event. This is why it reads as a "silent failure," and it is why the fix cannot be "check the return value" — the extension genuinely cannot observe it. (Verified fact + reasoned.)

7. **This is a *gap*, not a queued task.** The 8 remaining tasks (2.5, 3.8, 5.9, 6.5, 7.1–7.4) are e2e/loop-verification work. `design.md`'s "command no longer resolves → passed through as prose" bullet is about the **content** slot (silent *prose*, a different symptom), and `validateDelegateContext` defends that slot at *registration* time. Nothing in the change plans a defence for the **restart-trigger** slot failing to resolve at send time, or for making a swallowed `extension_error` observable to the model. (Verified by reading the change artifacts.)

**One-sentence answer.** `delegate_context_high`'s restart trigger is the one send the design routes through the SDK's "no-`deliverAs` command channel"; it throws *this* string exactly when the session handling it can no longer resolve the `/pi-renew` command — i.e. under a stale/split runner or a stale/duplicate `pi` process (the codehub BUG-1 family) — and because that send is fire-and-forget with its throw swallowed into an `extension_error` event, the failure is silent to the tool and the model by design.

> **Revised by §14.** The on-disk instance (product-master `01a04384 → 01a043ca`) shows the *observable* failure is broader than the throw: the tool returns an **unqualified "restart pending"** on every call (no in-flight state, so the model re-fires it 5× until the run aborts), and the **replacement session's own handoff payload is a separate, unverified send that did not arrive**. The specific "already processing" throw is the *loudest* face of this class but is **event-only** — absent from the transcript. See §14.5 for the corrected one-sentence answer.

---

## 4. Current behavior / architecture

### 4.1 The SDK's `prompt()` — the actual throw site and its ordering

Verified from `@earendil-works/pi-coding-agent/dist/core/agent-session.js` (and the identical bundled copy in `dist/bundle/chunks/chunk-E5KXRMZK.js`):

```
async prompt(text, options) {
  if (options?.expandPromptTemplates && text.startsWith("/")
      && await this._tryExecuteExtensionCommand(text)) {   // ← (1) dispatch FIRST
    preflight?.(true);
    return;                                                 // ← early return, before any streaming check
  }
  …
  if (this.isStreaming) {                                   // ← (2) ONLY reached if (1) returned false
    if (!options?.streamingBehavior)
      throw new Error("Agent is already processing. Specify
        streamingBehavior ('steer' or 'followUp') to queue the message.");   // ← ★ THE ERROR
    options.streamingBehavior === "followUp"
      ? await this._queueFollowUp(…)
      : await this._queueSteer(…);
    return;
  }
  …  // normal turn start
}
```

`_tryExecuteExtensionCommand(text)` (`agent-session.js:932`) is:

```
let name = text.slice(1).split(/ /…)[0];          // first whitespace-delimited token
let command = this._extensionRunner.getCommand(name);
if (!command) return false;                       // ← falls through to (2) when the name does NOT resolve
try { return await command.handler(args, ctx); }
catch (err) { this._extensionRunner.emitError(…); return true; }
```

**Key structural facts** (all verified):
- `isStreaming` ≡ `_isAgentRunActive` (true throughout the run, including tool execution).
- The dispatch in (1) is gated on `getCommand(name)` *resolving*. **Resolution is the entire safety property** of the no-`deliverAs` command channel.
- `getCommand(name)` ≡ `resolveRegisteredCommands().find(c => c.invocationName === name)` (`runner.js:442`). `getRegisteredCommands()` ≡ `resolveRegisteredCommands()` (`runner.js:403`). **Both consult the *same* runner, recomputed fresh on every call.**

### 4.2 The delegate extension's three senders

From `pi-extensions/pi-renew/send-shapes.ts` (verified):

```
sendExtensionCommand(sender, "/…", onError?)
  → sender.sendUserMessage("/…", { expandPromptTemplates: true })     // NO deliverAs
  (throws locally if the string lacks a leading "/")

sendPayload(sender, payload, onError?)
  → sender.sendUserMessage(payload, { expandPromptTemplates: true, deliverAs: "followUp" })   // ALWAYS deliverAs

sendRestartPrelude(sender, prelude, onError?)
  → sender.sendMessage({ customType: "pi-renew-restart", content, display:true }, { triggerTurn: false })
```

The file's own header states the rule and its measured failure mode verbatim:

> "omitting `deliverAs` on a non-command payload sent while the agent is streaming delivers the message **nowhere at all**, while the caller still observes success; the only trace is an `extension_error` event."

**The asymmetry (this is the whole story):**

```
           send from INSIDE a tool  ⇒  session.isStreaming === TRUE
  ┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
  │ COMMAND channel  (no deliverAs)               │  │ PAYLOAD channel  (deliverAs:"followUp")    │
  │  dispatches in prompt() BEFORE the streaming  │  │  routes to _queueFollowUp ⇒ never throws  │
  │  branch.                                       │  │  (a real queued turn; one agent_settled)  │
  │   ✔ dispatches  ⇔  name RESOLVES              │  └──────────────────────────────────────────┘
  │   ✗  THROW "already processing"  ⇔  it DOESN'T│
  └──────────────────────────────────────────────┘
        ▲
        │  the /pi-renew restart trigger lives HERE.
        │  Its safety is a single assumption: "the name resolves."
```

### 4.3 The `delegate_context_high` path (the path that failed)

From `pi-extensions/pi-renew/pi-renew.ts` (verified):

```
delegate_context_high.execute({handoverPath})
  ├─ read + validate the handover file (throw if missing/empty)
  ├─ summary = <handover report> + <last_tasks_read>
  └─ return executeDelegation({ reason:"context usage too high",
                               nextSteps:`Continue from the handover report at ${handoverPath}`,
                               summary,
                               strategy: "new-session" },      // ← hard-coded, never "compact"
                       ctx)

executeDelegation(…, ctx)  [strategy === "new-session"]
  ├─ pendingRestart = { summary, nextSteps }
  ├─ commandName = resolveRestartCommandName(pi.getCommands())   // line 308
  │     └─ returns "pi-renew" (or the lowest "pi-delete:N" collision suffix) or null
  ├─ if (commandName === null) → reportRestartFailure(…)         // ← the ONE guard that exists
  │                                                                    (fires only if getCommands() has NO pi-renew* entry)
  └─ sendExtensionCommand(pi, `/${commandName} -- ${reason}`)     // ← THE send that can throw; no deliverAs
        │  ⇒ pi.sendUserMessage("/pi-renew -- …", {expandPromptTemplates:true})
        │  ⇒ session.prompt(…) ⇒ (1) dispatch if getCommand resolves; else (2) THROW (this error)
        └─ on success the handler runs ctx.newSession({ parentSession, withSession })
              ├─ newSession ⇒ this._extensionRunner.invalidate("…stale after session replacement…")   // line 570
              └─ withSession(c2):   // c2 is the REPLACEMENT session's context (createReplacedSessionContext)
                    ├─ sendRestartPrelude(c2, prelude)   // triggerTurn:false — not prompt(), can't throw
                    └─ sendPayload(c2, context)            // deliverAs:"followUp" — can't throw
```

**Consequence:** the restart trigger is the *one* outbound message on the **original** session's runner, and the *one* one sent without `deliverAs`. Everything the design cares about delivering to the *new* session is correctly rebound onto `c2` (post-replacement). So the design is self-consistent — **its single point of fragility is the trigger, and its single failure mode is silent.**

### 4.4 Why a *single* runner cannot be the cause (and what that localizes the bug to)

Because `getCommand` and `getCommands` share one `resolveRegisteredCommands`:

- **Single `pi-renew` extension** → invocation name `pi-renew`; `getCommand("pi-renew")` resolves → dispatches → **no throw.** (This is the Case-A control in the spike.)
- **Two extensions both named `pi-renew`** → invocation names `pi-renew` and `pi-renew:2`. The tool sends `/pi-renew`; `getCommand("pi-renew")` returns the *first-registered* one. If that is the wrong extension, you get a **misfire** (wrong handler runs), **not a throw.** ⇒ A collision is **ruled out** as the cause of *this* error.
- **Zero registered `pi-renew`** in the *dispatching* runner → `getCommand` undefined → falls through → **throw (this error).** This is the only single-runner-shape that throws, and it means the command genuinely isn't in the runner that `prompt()` uses.

Therefore a *throw* specifically (as opposed to a misfire or a clean dispatch) requires the name to be **resolvable by the runner the tool asked about** (`pi.getCommands()`) but **unresolvable by the runner the prompt dispatches through** (`prompt()._extensionRunner.getCommand`). Those are the *same* object in the normal case, so a throw implies they are **not** the same object — i.e. a **stale or split runner**, or a **stale/duplicate `pi` process** whose session runner has been invalidated/replaced out from under the captured `pi`.

---

## 5. Detailed evidence and source references

| # | Claim | Source (workspace-relative or absolute) |
|---|-------|-------------------------------------------|
| E1 | Exact throw string + condition | `@earendil-works/pi-coding-agent/dist/core/agent-session.js:833` (and `dist/bundle/chunks/chunk-E5KXRMZK.js`) |
| E2 | `isStreaming ≡ _isAgentRunActive` | `…/dist/core/agent-session.js:591` |
| E3 | `prompt()` dispatches extension commands *before* the streaming branch; throws iff unresolved | `…/dist/core/agent-session.js` `prompt()` body (~815–845) |
| E4 | `_tryExecuteExtensionCommand` returns `false` ⇔ `getCommand(name)` undefined | `…/dist/core/agent-session.js:932` |
| E5 | `getCommand` and `getRegisteredCommands` both call `resolveRegisteredCommands` (same runner, fresh each call) | `…/dist/core/extensions/runner.js:403–444` |
| E6 | Collision renames to `name:N` (does **not** remove the bare name for the first occurrence) | `…/dist/core/extensions/runner.js:403–431` |
| E7 | `sendUserMessage → this.prompt(…)`; returns `undefined`; `.catch` reports `extension_error` | `…/dist/core/agent-session.js:1110`, `:1945–1946` |
| E8 | After replacement the captured `pi`/command ctx is **invalidated** ("stale after session replacement") | `…/dist/core/agent-session.js:570` |
| E9 | Replacement context `c2` rebinds `sendUserMessage`/`sendMessage` to the **new** session | `…/dist/core/agent-session.js` `createReplacedSessionContext()` (~2736–2745) |
| E10 | Three senders + the two send shapes + the documented silent-drop failure | `pi-extensions/pi-renew/send-shapes.ts` |
| E11 | `delegate_context_high` ⇒ hard-coded `strategy:"new-session"` | `pi-extensions/pi-renew/pi-renew.ts` |
| E12 | `executeDelegation(new-session)` ⇒ `sendExtensionCommand(pi, "/… -- …")`; only guard is `resolveRestartCommandName === null` → `reportRestartFailure` | `pi-extensions/pi-renew/pi-renew.ts` (~300–320) |
| E13 | Name resolver is correct (returns `unsuffixed.name`, not an out-of-scope var) — *ruled out as a bug* | `pi-extensions/pi-renew/pi-renew.ts:174–175` |
| E14 | Content slot is defended at **registration** (`validateDelegateContext` rejects empty / unresolving / self-referential) | `pi-extensions/pi-renew/delegate-context.ts`; `design.md:178` |
| E15 | High-context reminder is on at 0.85× window (Q3.5-27B ≈ 260K ⇒ ~221K) — i.e. the trigger fires deep in a long streaming run | `~/.pi/agent/pi-renew.json`; `pi-extensions/pi-renew/config.ts:35–37` |
| E16 | Prior art **Case A vs Case D** and "silent failure #4" = this exact event (`extensionPath:"<runtime>","event":"send_user_message"`) | `.agents/research/2026-08-23-pi-renew-tmux-loop.md` §25 |
| E17 | Prior art **BUG-1: "stale pi process blocks all subsequent invocations"**; "re-spawning is what trips the 'Agent is already processing' lock"; "extension ctx is stale after session replacement" | `~/.pi/agent/sessions/--data-workspace-dev-support-projects-codehub--/2026-06-07…jsonl` (a `read` toolResult quoting that repo's `docs/…update-loop.md`) |
| E18 | The change's D5 documents the two send shapes + the "command resolves" assumption | `openspec/changes/pi-renew-context-restart-loop/design.md:89–103` |
| E19 | Remaining tasks are e2e/loop-verification only; none plans a defence for the trigger slot | `openspec/changes/pi-renew-context-restart-loop/tasks.md` (open list) |
| E20 | The pi-renew repo's own session files (5, Aug 23–24) contain **no** `already processing` / `extension_error` — the failing session is **not on disk** *in that repo* (it is, however, on disk under a **different** slug — E21) | `~/.pi/agent/sessions/--data-workspace-copilot-dev-pi-extensions-pi-delegate--/` |
| E21 | **On-disk instance located (closes T3):** `product-master` session `01a04384` (2026-08-27) makes **5× identical** `delegate_context_high` calls, each returning the *success* string, then `stopReason: aborted`; a **sibling replacement** `01a043ca` is born ~23 s later in the same cwd | `~/.pi/agent/sessions/--data-workspace-product-master--/2026-08-27T13-59-39-…-01a04384….jsonl` + `…-01a043ca….jsonl` |
| E22 | In that file the literal throw strings are **absent** (`already processing` = 0, `streamingBehavior` = 0, `extension_error` = 0) ⇒ the throw is **event-only** and not serialized to the transcript; **T12 (stale/split runner?) is not decidable from this file** | same file, `grep -c` |
| E23 | The **replacement** session's injected payload is **absent** ("Summary from Previous Agent" = 0, "Instructions for Next Agent" = 0, custom `pi-renew-restart` message = 0); its first line is a **user-role** `continue on <handover>` and the model `read` the handover file itself (**D2**) | `…01a043ca….jsonl` L4, L5–6 |
| E24 | In a harnessed/RPC deployment the extension's auto-continuation can be **bypassed** by the driver's own re-prompt ⇒ the in-extension payload is only as strong as "the next agent reads the file" (a scope fact the change must record) | `…01a043ca….jsonl` L4 (user-role), contrast with the extension's own templated next-steps text |

---

## 6. The candidate-cause tree (and what each would and wouldn't explain)

```
delegate_context_high error = "already processing… streamingBehavior"
  ⇒ a no-deliverAs "/…" send hit the isStreaming throw
  ⇒ that "/…" did NOT resolve to a registered extension command in the dispatch runner

      ┌─────────────────────────────────────────────────────────────────────┐
      │ (i)  name DESYNC: getCommands() sees it, getCommand() doesn't        │
      │      ✗ RULED OUT — both call one resolveRegisteredCommands();        │
      │         a collision RENAMEs, doesn't remove (E5, E6).                │
      ├─────────────────────────────────────────────────────────────────────┤
      │ (ii) misroute: a CONTENT payload sent on the command channel          │
      │      ✗ NOT on this path — new-session sends content only via          │
      │         sendPayload (deliverAs:"followUp") (E10, E12).               │
      │         (Would be a bug only if a future edit routes content here.)  │
      ├─────────────────────────────────────────────────────────────────────┤
      │ (iii) collision misfire: two "pi-renew" → wrong handler runs      │
      │      ✗ produces a misfire, not a throw (E6).                        │
      ├─────────────────────────────────────────────────────────────────────┤
      │ (iv) STALE / SPLIT RUNNER or stale+duplicate pi process:            │
      │      the tool's pi and prompt()._extensionRunner are different      │
      │      runners; dispatch runner lacks the command ⇒ getCommand miss    │
      │      ✔ CONSISTENT with E8 (invalidate), E17 (BUG-1), and with        │
      │         delegate_context_high firing only deep in a long run (E15)│
      │      ⚠ needs the actual failing session to confirm (T3)            │
      └─────────────────────────────────────────────────────────────────────┘
```

Working hypothesis: **(iv)**. The delegate flow is *correct*; it simply makes one fire-and-forget send on a session whose runner may have gone stale/duplicate, and that SDK throw is, by construction, silent.

---

## 7. Alternatives and tradeoffs (for the eventual fix)

- **Fix-A — "Don't be in the throw path": pre-validate the trigger against the *dispatching* runner and refuse/fall back.**
  - Shape: before `sendExtensionCommand`, confirm `pi.getCommands()` *and* that the *session actually handling the prompt* can resolve the name (e.g. via the same `getCommand` the dispatch uses); if it can't, either (a) report the failure *loudly through the transcript* (the existing `reportRestartFailure` channel) instead of sending, or (b) route the restart through a channel that *does* carry `deliverAs` when the trigger can't be proven resolvable.
  - Pro: turns a silent drop into a loud, model-visible failure at the exact point of risk. Consistent with the change's existing "restart failures are reported" requirement.
  - Con: "can't resolve *in the dispatch runner*" is hard to know from the tool, because the tool and the dispatch runner are normally the same object — you can only detect the *stale* case by the symptoms (an `extension_error` you can't see) or by not being in that state at all. So Fix-A is mostly *"detect and report"*, not *"make it work."*

- **Fix-B — "Make it observable from outside."** Rely on the RPC backend the change is already building: `extension_error` is a first-class RPC event, so a harness can catch exactly this class of silent send failure (`agent_settled` with no matching follow-up turn is also a tell). No extension code change; the *harness* enforces "a restart that produced no new turn is a failure."
  - Pro: matches what the design already assumes ("the only observable channel is the event stream"); no risk of over-constraining the extension. This is effectively what the spike's §25 conclusion #4 recommends.
  - Con: only as good as the harness being present; a bare interactive TUI run still swallows it.

- **Fix-C — "Never route the trigger through the fragile channel."** Send the restart as a *payload* with `deliverAs:"followUp"` (which never throws) and let the *replacement* session's turn be what carries the restart, or trigger the restart through `withSession` on a *new* session only. Removes the "must resolve on the old runner" dependency entirely.
  - Pro: eliminates the throw path structurally for the trigger.
  - Con: changes the restart semantics (the trigger currently *is* the extension-command dispatch that runs `newSession`); a large redesign; risk of regressing the working single-runner case. Likely overkill.

- **Do-nothing / accept** — document it as a known environmental failure mode and rely on the RPC harness. Defensible if (iv) is confirmed to be rare and harness-covered.

**Recommendation (opinion, for the proposal decision):** **Fix-A + Fix-B together.** Fix-A makes the *common* case (single, healthy runner) fail loudly *and* correctly — you already have `reportRestartFailure`; the change is to *route into it* when the trigger can't be proven resolvable rather than firing a send that will be silently swallowed. Fix-B is the *safety net* for the genuinely stale-runner case the extension cannot self-detect. Fix-C is noted but not recommended (high regression risk).

---

## 8. Risks, edge cases, and operational concerns

- **Silent by construction (highest risk).** `sendUserMessage` returns `undefined`; the throw becomes an `extension_error` event no in-process actor consumes. The model believes the restart succeeded. A user watching the TUI sees the tool "succeed," the session does *not* restart, and context keeps climbing — the very failure `delegate_context_high` exists to prevent. (E1, E7, E16.)
- **Threshold coupling.** The reminder fires at 0.85× window (E15). The *deeper* the run, the more likely the process/runner is in a state where the trigger can't dispatch — so the emergency path is correlated with the condition that breaks it.
- **Duplicate/stale `pi` process.** The codehub BUG-1 (E17) shows this is an *operational* reality in this workspace, not a theoretical one. Re-spawning `pi` (vs reusing the tmux session) is the trigger; a stale process can also hold the "already processing" lock so that *legitimate* follow-ups throw too.
- **Misfire masquerading as success.** The collision case (iii) doesn't throw but *can* run a different extension's `/pi-renew` handler — a subtle, equally-silent failure the current design does not guard.
- **`print`/`json` one-shot modes already refuse the delegate tool** (`executeDelegation` mode guard) — a partial mitigation, but RPC/TUI are the modes where (iv) lives, and they are *not* guarded.
- **No in-repo failing session.** The one on-disk occurrence is a *codehub* session (different repo); the delegate repo's own sessions are clean (E20). So there is currently no local repro to point a fix at.

---

## 9. Validation and test implications

- **Unit** (`test/send-shapes.test.ts` already asserts the two shapes): the natural new assertion is *"a command-channel send whose name does not resolve to `getCommand` is not fired silently"* — i.e., the trigger path has a branch that routes to `reportRestartFailure`. (Currently absent.)
- **Regression / e2e** (this is where the *real* validation lives, and it maps to the already-open tasks **3.8** "first non-mocked end-to-end regression test" and **7.1/7.2** "full loop under `continuation: ask/auto`"): the decisive e2e is *"force the restart trigger into a session whose runner cannot resolve it; assert the run surfaces a failure instead of a silent no-op."* That test does not exist and cannot exist until the failure is made observable (Fix-A or Fix-B).
- **RPC harness** (the change's `pi-driver-harness` spec): assert that a `send_user_message` whose `extension_error` is "already processing" **and** is followed by no new `agent_start`/turn within a bounded window is reported as a restart failure. This is the concrete, automatable form of Fix-B.
- **What a green run must show:** exactly **one** `agent_settled` per intended restart, no orphaned `extension_error` for the restart trigger, and the replacement session's header records the `parentSession` link (the existing design's F34/D-H10 expectations).

---

## 10. Thread ledger (all threads closed)

| ID | Thread | Status | Evidence / basis |
|----|--------|--------|------------------|
| T1 | Where exactly does the string come from? | **resolved** | E1 (SDK `prompt()` throw), E3 (ordering) |
| T2 | Is `isStreaming` true while a tool runs? | **resolved** (yes) | E2, E3 |
| T3 | Which session actually failed, and what was the exact failing `text`? | **resolved (revised)** — see **§14** | E21 — the instance *is* on disk under a different slug (`product-master`, `01a04384 → 01a043ca`). A1 is confirmed; the *specific throw* is event-only (E22), so "which exact string" is **not** recoverable from the transcript. §14 adds threads T14–T16. |
| T4 | Can `getCommand` and `getCommands` disagree within one runner? | **resolved** (no) | E5 |
| T5 | Does a name *collision* cause *this* throw? | **resolved** (no — it causes a misfire) | E6 |
| T6 | Is the name resolver (`resolveRestartCommandName`) buggy? | **resolved** (no — returns `unsuffixed.name`) | E13 |
| T7 | Is the content slot defended? | **resolved** (yes — registration-time validation + `deliverAs`) | E10, E14, E18 |
| T8 | Is the trigger slot (`/pi-renew` send) defended against non-resolution? | **resolved** (no — only a `null`-name guard that can't see a stale runner) | E12 |
| T9 | Is this failure observable to the tool/model? | **resolved** (no — fire-and-forget + swallowed throw) | E7 |
| T10 | Is this failure observable to an external harness? | **resolved** (yes — `extension_error` + missing turn, via the RPC backend) | E16, E17 |
| T11 | Is a defence for the trigger already planned in the change? | **resolved** (no — open tasks are e2e/loop only) | E19 |
| T12 | Is `pi` per-session or shared (can the tool's `pi` differ from the dispatch runner)? | **deferred** | *Missing:* a direct read of how the `pi` ExtensionAPI is bound per session vs shared across the process (the `bindExtensions`/`_extensionRunnerRef` wiring at `agent-session.js:107–223` was located but not fully traced). *Impact:* determines whether Fix-A can *detect* a split runner or only *report* it. *Best next action:* trace `createContext`/`bindExtensions` to confirm the tool's `ctx` and `pi` are the *same* runner as the dispatch `prompt()` uses. |
| T13 | Is the duplicate-load (F89) the operative cause? | **deferred** | The handover notes a double-load is "at worst silent" (F89) — consistent with T3/T12 but unconfirmed for this instance. *Best next action:* same as T3 (find the failing session) + check whether the extension's factory ran twice in it. |

---

## 11. Open questions (numbered, for the proposal)

1. **Q1 — Where should the restart-trigger failure be made loud?**
   - A. In the extension: when the trigger can't be proven resolvable on the dispatching runner, route to the existing `reportRestartFailure` channel (a user-visible transcript message + `ui.notify("error")`) instead of firing a send that will be silently swallowed. **(Recommended)**
   - B. Leave the extension as-is; rely solely on an external RPC harness to detect "restart requested but no new turn" via the `extension_error`/`agent_settled` event stream.
   - C. Both A and B.

   *Recommendation: **C** (Fix-A + Fix-B).* A gives a correct, model-visible failure in the common/healthy case at near-zero cost (the failure channel already exists); B is the safety net for the genuinely stale-runner case the extension cannot self-detect. A alone leaves the stale case silent; B alone leaves the TUI case silent.

2. **Q2 — Is fixing the *trigger channel* in scope for this change, or deferred to a follow-up?**
   - A. In scope: add the "trigger can't be resolved ⇒ fail loud" branch + the RPC assertion to the existing `pi-renew` spec (`context-restart`). **(Recommended)**
   - B. Out of scope: record as a known environmental failure and let the harness cover it; do not touch the send-shape contract.
   - C. Separate change dedicated to restart-trigger robustness.

   *Recommendation: **A** — it is small, it closes a gap the change's own "restart failures are reported" requirement implies, and the RPC assertion slots into the already-open 3.8/7.x e2e tasks rather than a new change.*

3. **Q3 — How do we get a reproducible failing session (to convert the deferred T3/T12/T13 into facts)?**
   - A. Search *all* of `~/.pi/agent/sessions/**` (every slug + tmp/RPC dirs) for `already processing` / `extension_error` and open the hit. **(Recommended)**
   - B. Reproduce under `--mode rpc` with the delegate extension loaded and a forced >0.85× context turn, capturing the event stream.
   - C. Trace `createContext`/`bindExtensions` statically to settle T12 without a live session.

   *Recommendation: **A** first (cheap, uses the only on-disk evidence), **B** if A finds nothing (builds the e2e test as a byproduct), **C** as a fast static backstop.*

---

## 12. Proposal-ready requirements / next steps

If the user wants to turn this into work, the minimal, self-consistent requirement set is:

- **R1 (spec `context-restart`).** *When the `new-session` restart trigger is dispatched, the extension MUST treat a non-resolution of the restart command as a reported restart failure (user-visible transcript message + error notify), not as a silent, fire-and-forget send.* Rationale: closes T8; satisfies the change's own "restart failures are reported" requirement for the one send that can currently fail invisibly.
- **R2 (spec `pi-driver-harness`).** *The RPC harness MUST surface a restart as failed when a restart trigger produces an `extension_error` of the "already processing" class and no subsequent new agent turn occurs within a bounded window.* Rationale: the observable safety net (Fix-B); automates what the spike's §25 concluded.
- **R3 (task, additive to 3.8 / 7.x).** *A non-mocked regression test that forces the trigger into a non-resolving runner and asserts a loud failure (per R1) or a harness-detected failure (per R2).* Rationale: converts the deferred T3/T12/T13 from "reasoned" to "verified."
- **R4 (design note, optional).** *Record that a name collision causes a misfire, not a throw, and that the content slot is defended at registration while the trigger slot is defended only by the SDK ordering guarantee* — so a future reader doesn't "fix" the wrong slot.

**Concrete next actions (research → proposal):**
1. Execute **Q3-A**: `grep -rl "already processing" /home/user/.pi/agent/sessions/**` (all slugs) to locate the real failing session; read its `extension_error` event to confirm the failing `text` (closes T3, A1).
2. Execute **Q3-C**: trace `createContext`/`bindExtensions` (`agent-session.js:107–223`, `1831`) to confirm the tool's `pi` and the dispatch `prompt()` share one runner in the healthy case (closes T12).
3. If R1/R2/R3 are accepted, they slot into the existing change's `context-restart` + `pi-driver-harness` specs and the open 3.8/7.x tasks — no new change required (per **Q2-A**).

---

## 13. Investigation log (what was already done, so this isn't repeated)

- Read the user's error and located the throw in the SDK: `agent-session.js:833` (+ bundled copy). Traced `prompt()` ordering (dispatch-before-streaming) and the `_tryExecuteExtensionCommand` → `getCommand` resolution gate.
- Read `agent-session.js` around `isStreaming` (`:591`), `sendUserMessage` (`:1110`, `:1945–1946`), `invalidate` (`:570`), `createReplacedSessionContext` (`~2736`); confirmed fire-and-forget + swallowed-throw semantics.
- Read the runner: `getCommand`/`getRegisteredCommands`/`resolveRegisteredCommands` (`runner.js:403–444`) — established the single-runner agreement and the rename-not-remove collision behaviour.
- Read the whole delegate extension: `pi-renew.ts` (`delegate_context_high` → `new-session`; `executeDelegation`; `resolveRestartCommandName`; the `/pi-renew` command handler; `session_before_compact`), `send-shapes.ts` (three senders + file-header failure note), `delegate-context.ts` (`validateDelegateContext`), `config.ts` + `~/.pi/agent/pi-renew.json` (0.85 threshold, models).
- Read the OpenSpec change: `design.md` (D4/D5 send-shapes; "command no longer resolves → prose" bullet at :178), `tasks.md` (3.6/3.7 send-shapes; open list), `…-implementation-handover.md` (F89 double-load; F75 etc.).
- Read the prior research: `.agents/research/2026-08-23-pi-renew-tmux-loop.md` §25 (Case A–F, "silent failure #4").
- Searched the session store: the only on-disk occurrence of the string is a **codehub** session (BUG-1 prior art); the **delegate** repo's own 5 sessions are clean.
- Ran `openspec list --json` / `store list --json` (no stores) / `status --change …` (repo-local, 34/42).

*Not yet done (deferred, see T12/T13):* tracing `bindExtensions` to confirm runner identity; a live reproduction under `--mode rpc`. *(Locating the failing session — old T3 — is now **done**: §14.)*

---

## 14. Session evidence: the on-disk instance (product-master, 2026-08-27)

T3 ("which session actually failed?") is **resolved — and it revises two conclusions in this document.** The failing session is on disk:

```
~/.pi/agent/sessions/--data-workspace-product-master--/
  2026-08-27T13-59-39-168Z_01a04384-…jsonl   ← the over-context run (189 lines)
  2026-08-27T15-15-51-654Z_01a043ca-…jsonl   ← its replacement (53 lines), born ~23 s later
```

### 14.1 The timeline (verbatim from the JSONL)

```
01a04384  (one continuous run, cwd=/data/workspace/product-master, ~240K tokens, thinkingLevel=medium)
  15:14:29  delegate_context_high  #1  → "🤖 Agent delegation requested — restart is pending"
  15:14:49  delegate_context_high  #2  → same success ack
  15:15:02  delegate_context_high  #3  → same success ack        (5× identical, ~12 s apart)
  15:15:14  delegate_context_high  #4  → same success ack
  15:15:26  delegate_context_high  #5  → same success ack
  15:15:28  stopReason = ABORTED                                             (old run torn down)
  ─────────── 23 s gap — nothing in either file  ───────────
01a043ca  (NEW session, same cwd)
  15:15:51  born
  15:16:10  first message, role=user:  "continue on  /tmp/handover-sync-collectors-bom.md"
  …          model `read`s the handover file itself, rebuilds context
  …          53 lines later: "Green. 80 tests, 0 failures … Done"
```

### 14.2 What the transcript confirms

- **A1 is now a verified fact, not an assumption** (§2): the *only* thing the model sends in the failure window is the `delegate_context_high` trigger (internally the no-`deliverAs` `/pi-renew` command send). There is no content-on-the-command-channel misroute here.
- **The failure is a *loop*, not a one-shot throw.** The tool returns the *identical success* string five times; the old run is only torn down (`aborted`) *after* the fifth call; the replacement appears 23 s later. This is the "silent failure" made concrete — the model believes it has triggered a restart and keeps asking for it.

### 14.3 What the transcript *cannot* confirm (correction to §3 and the one-sentence answer)

- The literal throw strings are **absent**: `already processing` = 0, `streamingBehavior` = 0, `extension_error` = 0 (E22). That is *expected* — the throw surfaces as an `extension_error` **event** (E7), and events are not serialized into the `.jsonl`. **So T12 (is the runner actually stale/split?) is not decidable from this file.** The "stale/split runner ⇒ *the* throw" hypothesis is **downgraded from *the* explanation to *one candidate micro-cause of the loop***. (Only a forced `--mode rpc` repro or reading the live event bus can settle it — the old Q3-B.)
- More important: the transcript **over-determines a defect this document did not name** (§14.4).

### 14.4 The two defects the instance actually shows

```
  (D1) unbounded success signal              (D2) replacement payload never arrived
  ┌────────────────────────────────┐       ┌───────────────────────────────────────────┐
  │ tool returns "restart pending"  │       │ new session's injected payload:             │
  │ as an unqualified FACT; no      │       │   "Summary from Previous Agent" = 0       │
  │ "in-flight / already delegating"│       │   "Instructions for Next Agent" = 0       │
  │ state → model re-fires 5×       │       │   custom pi-renew-restart msg  = 0     │
  └────────────────────────────────┘       │   → model had to `read` the file itself     │
                                            └───────────────────────────────────────────┘
```

- **D1 — unbounded success / no in-flight state.** The existing `context-restart` spec already asks for an *honest* "pending" message, but the implemented behaviour still returns a flat "requested / pending" with **no idempotent in-flight state**, so a well-meaning model re-issues the call until the run aborts. The guard that *does* exist (`resolveRestartCommandName === null → reportRestartFailure`) is the **wrong shape**: here the name *was* resolvable (`getCommands()` listed `pi-renew`), so that guard never fired — and the restart was still not a clean, single, confirmable event.
- **D2 — replacement-payload arrival is unverified (and here, absent).** The delegate's own `withSession(c2)` prelude + summary are **not present** in the replacement session; it received a thin **user-role** line ("continue on …") and self-served by reading the handover file (E23). The handoff only "worked" because an external driver re-prompted **and** the model chose to read the file. In a harnessed/RPC deployment the extension's auto-continuation can be **bypassed entirely** (E24) — a scope fact the change must record, because it bounds how much you can trust the in-extension payload vs. the harness.

### 14.5 Corrected one-sentence answer

`delegate_context_high` returns an **unqualified "restart is pending"** on every call and gives the model no way to tell *dispatched* from *pending* from *dropped*; when the restart does not cleanly complete in time, the model **re-issues the trigger** (here, five times) until the run aborts — while the **replacement session's** own context payload is a *separate, unverified* send that the tool likewise cannot confirm arrived. The specific SDK "already processing" throw is the *loudest* face of this class but is **event-only** and not observable in the transcript; the *loop* (D1) and the *missing handoff payload* (D2) are.

### 14.6 New / revised threads

| ID | Thread | Status | Basis |
|----|--------|--------|-------|
| T3  | Which session actually failed? | **resolved (revised)** | E21 — `01a04384 → 01a043ca`, on disk |
| T12 | Is the runner stale/split? | **unchanged: not decidable from the transcript** (event-only); keep as one candidate cause. Per design **D5**, this failure class is folded into driver-side supervision (see T16) rather than resolved at the extension — do not upgrade this row | E22, §14.3; `pi-renew-restart-reliability/design.md` D5 |
| T14 | Does the tool expose an in-flight / "already delegating" state? | **addressed by `pi-renew-restart-reliability` §1–§2 — two halves, not equally verified.** A persisted in-flight record (`.pi/loop/restart-inflight-<parentSessionId>.json`) plus an idempotent stand-down guard now exist. The record **is written on a real live restart**, observed on `pi` 0.84.4. The *stand-down on a repeat request* is **unit-verified only** (`test/restart-guard.test.ts`) — not yet exercised live. Both halves must be read together; see the F144/F145 note below | Req "Restart trigger is idempotent within a live run", "The model is told to stand down once a restart is in flight" (`specs/restart-reliability/spec.md`); `pi-extensions/pi-renew/restart-inflight.ts` |
| T15 | Did the replacement session actually receive its handoff payload? | **addressed by `pi-renew-restart-reliability` §1–§3, AND now live-verified — the strongest upgrade in this table.** §14.4's D2 recorded the payload as *absent* in the on-disk failure instance. A live RPC probe on `pi` 0.84.4 (post-F144) observed **both** the `pi-renew-restart` custom prelude **and** the registered context arriving as a user message in the replacement session. Task 2.5's live test (`test/delegate-state-live.test.ts`) now asserts exactly that and passes (verified green three times: 7.9 s / 6.3 s / 7.3 s). `wasHandoffDelivered()` (§3.3) additionally exposes this as a checkable predicate rather than an inferred absence | Req "Handoff-payload arrival is a confirmed outcome" (`specs/restart-reliability/spec.md`); `test/delegate-state-live.test.ts`; `pi-extensions/pi-renew/restart-inflight.ts` (`wasHandoffDelivered`) |
| T16 | Can the *driver* detect "restart requested, no settled continuation"? | **partially addressed by `pi-renew-restart-reliability` §4 — do not mark resolved.** The pure verdict core exists and is unit-tested: `skills/pi-driver-common/supervision.js` implements the four verdict tokens (`success` / `no-continuation` / `already-processing` / `pending`), the bounded supervision window, and the "already processing" classifier. The **live wiring is not built** — no driver yet detects a real restart, delimits the post-restart event slice, or emits the signal against a running session | Req "A restart with no settled continuation is a detected failure", "Supervision is bounded and does not hang the driver" (`specs/restart-supervision/spec.md`); `skills/pi-driver-common/supervision.js`; `pi-renew-restart-reliability/tasks.md` §4 |

**F144/F145 — read this table with one qualification.** The guard that closes T14 was **dead on every live
session for four commits**: the sibling change's own C2-GUARD batch (`aaddc52`) extracted `getSessionId` off
`ctx.sessionManager` into a local and called it **unbound**, so every guarded code path — the tool-path
guard, the `/pi-renew` command-handler guard, and the §2.3 high-context reminder — threw before reaching
the guard logic at all (silently, in the reminder's case: its throw was swallowed by the runner's own
`catch`). The entire mocked suite stayed green over it — **26 files / 258 tests passing with the live
restart path completely dead** — because every mocked `sessionManager.getSessionId` in the suite is an
arrow function, which ignores the unbound `this` that broke the real, prototype-bound method. The defect was
fixed the same day (F144, new regression test `test/restart-guard-binding.test.ts`) and is what unblocked
T15's live verification above; a separate test-side gating race (F145) was fixed immediately after, landing
T15's live proof. The point for a future reader of this table: **in this area, a unit-verified fix is not
evidence of a live-working fix** — which is exactly why T14's and T16's verdicts above distinguish
"unit-verified" from "live-verified" instead of collapsing them into one word. See the implementation
handovers' `F144`/`F145` sections (`pi-renew-restart-reliability-implementation-handover.md`, and the
sibling change's handover) for the full account.
