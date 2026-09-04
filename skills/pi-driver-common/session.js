// session.js — folding a parsed event stream into the state a driver reports on.
//
// This is the single place decisions about "settled", "died" and extension errors are
// implemented; a driver must read state through here rather than re-deriving any of these
// rules against the raw events itself (see CONTRACT.md).

/**
 * Extract the concatenated text of a message's text content blocks (mirrors the extraction
 * pi-agent.sh already uses for its own JSON-mode messages: join every `type:"text"` block's
 * `text`, in order, with no separator). A message whose content is only thinking and/or a
 * tool call — the shape a tool-calling assistant turn takes — yields "".
 * @param {Array<{type?: string, text?: string}>|undefined} content
 * @returns {string}
 */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Fold a sequence of parsed pi RPC events into the state a driver reports.
 *
 * Settle source (decision: "Settled is `agent_settled` and nothing else"): a run is settled
 * exactly when the most recent of {agent_start, agent_settled} seen so far is agent_settled.
 * Measured on a live one-tool run: a tool call produces a new assistant `message_end` 1.4s
 * before the run actually finishes (a tool call IS an assistant message); `turn_end` fires
 * mid-run, before the tool's result even comes back; `agent_end` fires but the protocol
 * allows a retry, a compaction retry or a queued continuation to follow it. None of those
 * three qualifies. Resetting on `agent_start` (rather than only ever setting `settled=true`
 * once) is what makes this correct across a long-lived session's SECOND and later turns —
 * without it, a session that settled once would read as "settled" forever, even while a
 * later `send` is actively streaming.
 *
 * A queued follow-up (`{"type":"prompt","streamingBehavior":"followUp",...}`) continues the
 * SAME agent run and produces no second `agent_settled` of its own — measured: one
 * `agent_settled`, at the very end, after the continuation's own turn completed. Folding
 * therefore needs no special-case bookkeeping for it: waiting for `agent_settled` already
 * waits through the continuation for free.
 *
 * Death detection (decision: "A death is EOF or process exit with no preceding
 * `agent_settled`"): measured, a SIGKILL mid-run gives `exit code=null, signal="SIGKILL"` and
 * a stream truncated after `message_start` — no `agent_settled` anywhere in it. That is the
 * only distinction between a death (exit 3) and a clean finish that happened to produce no
 * text (exit 4), and it is decidable from the event stream alone once the caller tells this
 * function whether the stream has actually ended (see `ended` below) — folding the events by
 * themselves can prove settled, but "died" additionally needs to know the process is really
 * gone, not just that we haven't read the next line yet.
 *
 * Extension errors (decision: "Extension errors are surfaced, not swallowed"): measured, a
 * throwing extension emits `{"type":"extension_error",...}` mid-run and the run then settles
 * SUCCESSFULLY — exit 0 — with nothing in the answer, the exit code, or the model's own view
 * recording the failure. So every `extension_error` seen is collected and returned
 * separately; it never changes `settled` or the text.
 *
 * @param {Array<{type?: string, message?: object, messages?: object[]}>} events Parsed
 *   events, in the order pi wrote them.
 * @param {object} [opts]
 * @param {boolean} [opts.ended] Has the underlying process/stream actually ended? While it
 *   is still open, "not settled yet" just means "still running" — only once the stream has
 *   ended does "not settled" become "died".
 * @returns {{settled: boolean, died: boolean, lastAssistantText: string,
 *   assistantTexts: string[], extensionErrors: object[], toolInFlight: boolean}}
 */
export function foldEvents(events, { ended = false } = {}) {
  let settled = false;
  let toolPending = 0;
  let lastAssistantText = '';
  /** @type {string[]} */
  const assistantTexts = [];
  /** @type {object[]} */
  const extensionErrors = [];

  const noteAssistantMessage = (message) => {
    if (!message || message.role !== 'assistant') return;
    const text = extractText(message.content);
    // A tool-call-only assistant message (thinking + toolCall, no text block) must NOT
    // overwrite the last real answer — that is exactly the "a tool call is an assistant
    // message too" trap the settle rule above also has to dodge.
    if (text !== '') {
      lastAssistantText = text;
      assistantTexts.push(text);
    }
  };

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    switch (event.type) {
      case 'agent_start':
        settled = false;
        break;
      case 'agent_settled':
        settled = true;
        break;
      case 'tool_execution_start':
        toolPending += 1;
        break;
      case 'tool_execution_end':
        toolPending = Math.max(0, toolPending - 1);
        break;
      case 'extension_error':
        extensionErrors.push(event);
        break;
      case 'message_end':
        noteAssistantMessage(event.message);
        break;
      default:
        break;
    }
  }

  return {
    settled,
    died: ended && !settled,
    lastAssistantText,
    assistantTexts,
    extensionErrors,
    toolInFlight: toolPending > 0,
  };
}

/**
 * Fold a `pi` **persisted session file** (JSONL under `--session-dir`, `type:"message"`
 * records) into the same shape `foldEvents` returns, for the tmux backend, which has no RPC
 * event stream to read and instead reads pi's own session transcript (see CONTRACT.md,
 * *Reading state, not the screen*, for why this lives here rather than being re-derived in
 * the tmux skill).
 *
 * Record types, measured across 60 real session files: `message` (4014), `thinking_level_
 * change` (65), `model_change` (61), `session` (60), `custom_message` (10), `session_info`
 * (3), `compaction` (1). There is no `agent_settled` anywhere in a persisted session file —
 * unlike the RPC event stream, a session file has no explicit "the whole run is done" event.
 * The turn boundary is instead read off the **last** `type:"message"` entry's `stopReason`.
 *
 * Settle rule: settled exactly when the last `message` entry is an **assistant** message
 * whose `stopReason` is one of `"stop"`, `"length"`, `"aborted"` — the complete `StopReason`
 * union is `"stop" | "length" | "toolUse" | "error" | "aborted"`
 * (`@mariozechner/pi-ai/dist/types.d.ts:130`), read from the installed type declarations, not
 * guessed. `"toolUse"` is not settled — the turn is mid-flight, a tool result is still to
 * come. `"error"` is deliberately **not** settled either, and this is the non-obvious call:
 * `pi` auto-retries, so another assistant message can follow an errored one, and reporting
 * settled at the error would report a settle in the middle of a retry — see
 * `erroredStopReasons` below for how the error is surfaced instead of swallowed. A trailing
 * `toolResult` or `user` message is not settled. Only four of the five union members appear
 * in the 60-file corpus (`toolUse` 530, `stop` 11, `error` 6, `aborted` 3); `"length"` never
 * appears but is in the union, so it is classified (settled) rather than left to fall through
 * a default. Any **unrecognised** `stopReason` is treated as **not settled** — a new value
 * must never silently read as "done".
 *
 * A mid-turn assistant message can itself carry a text block (thinking + text + a further
 * toolCall, all in one message, `stopReason:"toolUse"`) and it must not be reported as the
 * answer while the turn is unfinished — `settled` above already guards that; `lastAssistant
 * Text`/`assistantTexts` below are collected from every assistant message that has non-empty
 * text, exactly as `foldEvents` does, so a caller can still see it via `--all` without it
 * being mistaken for a finished answer.
 *
 * Fields with no analogue in a session file get their honest empty value: `extensionErrors`
 * is always `[]` — a session file records no `extension_error`; the RPC backend is the only
 * one that can surface them (see CONTRACT.md, *Extension and runtime errors are surfaced*,
 * which names the RPC driver specifically). `toolInFlight` is likewise always `false` here,
 * deliberately not inferred from "last message is an assistant toolUse with no reply yet" —
 * unlike `extensionErrors`, that inference would sometimes be right, but nothing in this
 * batch measures whether a session file always gets a toolResult entry flushed promptly
 * enough for the inference to be trustworthy, and no caller of this function currently reads
 * `toolInFlight`, so an honest `false` beats a guess (see the report for this decision).
 *
 * @param {Array<{type?: string, message?: {role?: string, content?: unknown, stopReason?: string}}>} entries
 *   Parsed session-file records, in file order.
 * @param {object} [opts]
 * @param {boolean} [opts.paneDead] Has the tmux pane backing this session exited? While it is
 *   still alive, "not settled" just means "still running" — only once the pane is confirmed
 *   dead does "not settled" become "died", mirroring `foldEvents`'s `ended` parameter.
 * @returns {{settled: boolean, died: boolean, lastAssistantText: string,
 *   assistantTexts: string[], extensionErrors: object[], toolInFlight: boolean,
 *   erroredStopReasons: object[]}}
 */
export function foldSessionEntries(entries, { paneDead = false } = {}) {
  const SETTLED_STOP_REASONS = new Set(['stop', 'length', 'aborted']);

  let lastAssistantText = '';
  /** @type {string[]} */
  const assistantTexts = [];
  /** @type {object[]} */
  const erroredStopReasons = [];
  let lastMessageEntry = null;

  for (const entry of entries) {
    if (!entry || entry.type !== 'message') continue;
    lastMessageEntry = entry;
    const message = entry.message;
    if (!message || message.role !== 'assistant') continue;

    const text = extractText(message.content);
    // Same trap `foldEvents` dodges: a tool-call-only assistant message must not overwrite
    // the last real answer, but one that DOES carry a text block (decision: a mid-turn
    // message can carry text) is still recorded here — settled is decided separately, below,
    // from the last message's stopReason, so recording the text here cannot make an
    // unfinished turn look done.
    if (text !== '') {
      lastAssistantText = text;
      assistantTexts.push(text);
    }
    if (message.stopReason === 'error') {
      erroredStopReasons.push({
        timestamp: entry.timestamp,
        stopReason: message.stopReason,
        rawStopReason: message.rawStopReason,
      });
    }
  }

  const lastMessage = lastMessageEntry?.message;
  const settled = Boolean(
    lastMessage && lastMessage.role === 'assistant' && SETTLED_STOP_REASONS.has(lastMessage.stopReason),
  );

  return {
    settled,
    died: paneDead && !settled,
    lastAssistantText,
    assistantTexts,
    extensionErrors: [], // no analogue in a session file — see the doc comment above
    toolInFlight: false, // no analogue in a session file — see the doc comment above
    erroredStopReasons,
  };
}

/**
 * Classify a folded state into the three outcomes exit-codes.js maps to numbers. Only
 * meaningful once the stream has ended (settled or died) — a still-running session has no
 * outcome yet, by design; callers must not force one.
 * @param {{settled: boolean, died: boolean, lastAssistantText: string}} folded
 * @returns {"settled-with-text"|"settled-no-text"|"died"|null}
 */
export function outcomeForFold(folded) {
  if (folded.settled) {
    return folded.lastAssistantText !== '' ? 'settled-with-text' : 'settled-no-text';
  }
  if (folded.died) return 'died';
  return null;
}
