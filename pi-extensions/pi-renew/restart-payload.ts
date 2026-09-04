/**
 * Pure assembly of the restart payload: the provenance line every restart
 * opens with, and the ordered prelude (provenance, then the agent-supplied
 * summary and next steps, each gated by its toggle) that accompanies the
 * separately-delivered delegate context.
 *
 * Non-obvious fact: the payload is deliberately NOT one string.
 * `assembleRestartPayload` returns `{ prelude, context }` because `pi`'s
 * expander only expands a slash command when it is the *entire* message —
 * `expandPromptTemplate` opens with `if (!text.startsWith("/")) return
 * text;` and then matches `/^\/([^\s]+)(?:\s+([\s\S]*))?$/`, anchored at
 * both ends (`@earendil-works/pi-coding-agent@0.84.2`,
 * `prompt-templates.js:222-224`). Provenance is unconditional, so any single
 * string that puts it before a slash-command delegate context reaches the
 * model as literal, unexpanded prose; putting the context first instead
 * expands it but swallows the provenance into `$@`. Delivering `prelude`
 * and `context` as two separate messages (task 3.3, a later batch) is the
 * only ordering that satisfies both "provenance first" and "the context
 * expands" — see the change's handover doc, decision D-H7 and finding F25.
 * Do not join these two fields back into one string: there is no separator
 * that survives both constraints.
 */

export interface ProvenanceInput {
  /** The ordinal of THIS restart: 1 for the first. Supplied by the caller; never computed here. */
  ordinal: number;
  /** Already-formatted timestamp, reproduced verbatim. Never parsed, never reformatted. */
  timestamp: string;
  /** Opaque caller-supplied reason. Never interpreted. */
  reason: string;
}

export interface RestartPayloadInput extends ProvenanceInput {
  summary?: string;
  nextSteps?: string;
  context?: string;
  includeSummary: boolean;
  includeNextSteps: boolean;
}

export interface RestartPayload {
  /** Provenance, then the summary and next steps that survived the toggles. Never empty. */
  prelude: string;
  /** The registered delegate context, alone, or null when none is registered. */
  context: string | null;
}

/**
 * Renders the one unconditional line every restart payload opens with: the
 * restart ordinal, the timestamp, and the reason. It is the only signal
 * that lets a delegate context — replayed with no memory of its own —
 * distinguish restart 1 from restart 5, and therefore the only guard
 * against replaying forever.
 *
 * Pure: never calls `Date`, never parses or reformats the timestamp, and
 * never branches on the reason's content beyond deciding — via `.trim()` —
 * whether it is empty. The reason is otherwise emitted verbatim: quotes,
 * `$@`, `#`, backticks and newlines included. Sanitising it would be
 * interpreting it, which the spec forbids.
 */
export function buildProvenance(input: ProvenanceInput): string {
  const { ordinal, timestamp, reason } = input;
  const displayReason = reason.trim() === "" ? "(none given)" : reason;
  return `[pi-renew restart #${ordinal} at ${timestamp}] reason: ${displayReason}`;
}

/**
 * Assembles the restart payload from provenance, the agent-supplied summary
 * and next steps (each gated by its toggle), and the registered delegate
 * context. Returns the two parts split for delivery as two messages (see
 * the file header): `prelude` is provenance + [summary] + [next steps],
 * joined by a blank line; `context` is the delegate context alone, trimmed,
 * or `null` when none is registered.
 *
 * A section is present iff it is a string non-empty after `.trim()`;
 * `undefined` and whitespace-only strings are both absent. When no context
 * is present, both toggles are forced `true` regardless of the values
 * passed in — they are then the only payload the fresh session gets. Every
 * emitted section is trimmed at its edges only; interior whitespace
 * (including blank lines) is preserved verbatim. This does not contradict
 * the delegate context's "stored verbatim" contract — storage
 * (`delegate-state.ts`) is untouched by this module; trimming here is a
 * delivery-time normalisation of surrounding whitespace only, done because
 * the context is delivered as its own message and must satisfy
 * `startsWith("/")` for the runtime to expand it.
 */
export function assembleRestartPayload(input: RestartPayloadInput): RestartPayload {
  const provenance = buildProvenance(input);
  const context = present(input.context) ? input.context.trim() : null;

  // No registered context means nothing else survives the restart, so both
  // sections are forced on regardless of the stored toggles.
  const includeSummary = context === null ? true : input.includeSummary;
  const includeNextSteps = context === null ? true : input.includeNextSteps;

  const sections = [provenance];
  if (includeSummary && present(input.summary)) {
    sections.push(`## Summary\n\n${input.summary.trim()}`);
  }
  if (includeNextSteps && present(input.nextSteps)) {
    sections.push(`## Next steps\n\n${input.nextSteps.trim()}`);
  }

  return { prelude: sections.join("\n\n"), context };
}

/** True iff `value` is a string that is non-empty after trimming. */
function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
