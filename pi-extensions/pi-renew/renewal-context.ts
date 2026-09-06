import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/**
 * Pure logic for renewal-context registration: validating a leading slash
 * command against the runtime's resolvable commands, and parsing the
 * `/pi-renew` restart command's flags. Kept out of `pi-renew.ts`
 * because both functions are independently testable and have nothing to do
 * with the factory closure.
 *
 * Non-obvious fact: validation must happen at registration time, not at
 * delivery time. `AgentSession.prompt()`'s expansion path
 * (`_expandSkillCommand`, `expandPromptTemplate`) silently returns an
 * unresolved name's text unchanged rather than failing, so a renewal
 * context whose slash command cannot resolve would otherwise be delivered
 * to the model as literal prose, every restart, with no error anywhere.
 */

const CLOSEST_MATCH_MIN_PREFIX = 3;
const CLOSEST_MATCH_LIMIT = 5;

/**
 * True iff `name` is an invocation name of this extension's own `/pi-renew`
 * restart command: either the unsuffixed `pi-renew`, or a collision-renamed
 * `pi-renew:<n>` (`resolveRegisteredCommands`, `runner.js:413-429`, F14).
 *
 * Exported so the dispatch-name resolution in `pi-renew.ts` (which of the
 * possibly several matching `getCommands()` entries to send the restart to)
 * and the self-referential rejection below (which contexts must never be
 * registered) test the exact same pattern. Keeping it in one place means the
 * two can never drift apart — a context this function accepts as safe is,
 * by construction, never a name the dispatcher would also resolve to.
 */
export function isPiRenewRestartCommandName(name: string): boolean {
  return name === "pi-renew" || /^pi-renew:\d+$/.test(name);
}

/**
 * Rejects a renewal context whose leading slash command does not resolve
 * against `commands` (as returned by `pi.getCommands()`), or that resolves to
 * this extension's own restart command. An empty (after trimming) context is
 * also rejected. A context that does not start with `/` is not a command at
 * all and is always valid — no further check runs.
 *
 * Throws `Error` on rejection; returns normally on acceptance. The context
 * itself is never modified here — trimming is used only to decide whether
 * it is empty or a command.
 */
export function validateRenewalContext(context: string, commands: SlashCommandInfo[]): void {
  const trimmed = context.trim();
  if (trimmed === "") {
    throw new Error("Renewal context not registered: the context is empty.");
  }
  if (!trimmed.startsWith("/")) return;

  // Split on a literal space, not on `\s`. pi's three resolvers disagree here:
  // `_tryExecuteExtensionCommand` and `_expandSkillCommand` both use `indexOf(" ")`,
  // while `expandPromptTemplate` matches `/^\/([^\s]+)/`. Taking the strictest rule
  // means this check can only ever reject something the runtime would have expanded
  // (loud, at registration) — never accept something it would silently deliver as
  // prose, which is the failure this validation exists to prevent.
  const afterSlash = trimmed.slice(1);
  const spaceIdx = afterSlash.indexOf(" ");
  const token = spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx);

  const resolved = commands.find((command) => command.name === token);

  // O13 / D-H13: a context that resolves to this extension's own restart command would
  // restart forever — sendPayload deliberately never inspects its payload, and prompt()
  // dispatches a leading extension command before expansion runs, so nothing downstream
  // would ever stop it. Scoped to source === "extension": a same-named prompt template or
  // skill is a different, ordinary command and stays valid.
  if (resolved && resolved.source === "extension" && isPiRenewRestartCommandName(resolved.name)) {
    throw new Error(
      `Renewal context not registered: /${token} is this extension's own restart command, so replaying it would restart forever. Register the work you want replayed, not the restart itself.`
    );
  }

  if (resolved) return;

  throw new Error(
    `Renewal context not registered: /${token} does not resolve to any extension command, prompt template or skill. Closest matches: ${closestMatches(token, commands)}.`
  );
}

/**
 * Deterministic "closest match" list for the rejection message: a name
 * matches when it contains the token, the token contains it, or they share
 * a same-case-folded prefix of at least 3 characters. Comparison is
 * case-insensitive; the names in the output keep their original case.
 * Deduplicated, sorted with plain `Array.prototype.sort()`, capped at 5,
 * joined with ", ". An empty result renders as the bare word "none" so the
 * surrounding sentence still reads correctly.
 */
function closestMatches(token: string, commands: SlashCommandInfo[]): string {
  const lowerToken = token.toLowerCase();
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const { name } of commands) {
    if (seen.has(name)) continue;
    const lowerName = name.toLowerCase();
    const isMatch =
      lowerName.includes(lowerToken) ||
      lowerToken.includes(lowerName) ||
      commonPrefixLength(lowerName, lowerToken) >= CLOSEST_MATCH_MIN_PREFIX;
    if (!isMatch) continue;
    seen.add(name);
    matches.push(name);
  }

  matches.sort();
  const top = matches.slice(0, CLOSEST_MATCH_LIMIT);
  return top.length === 0 ? "none" : top.join(", ");
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Parses the `/pi-renew` command's raw argument string. Leading tokens
 * that start with `--` are flags; scanning stops at the first token that
 * does not, so a `--`-looking token appearing after payload text is treated
 * as payload, not a flag — the reason string is opaque and may contain
 * anything. `--after-turn` may repeat (idempotent).
 *
 * A bare `--` is the end-of-flags marker: it is consumed, flag scanning
 * stops unconditionally, and everything after it is `rest` — even a token
 * that itself looks like `--something`. Without this, a reason string that
 * happens to start with `--` (e.g. `--rerun after failure`) would throw
 * "unknown flag" instead of restarting; the tool always emits the marker
 * (`/pi-renew -- <reason>` or `/pi-renew --after-turn -- <reason>`) for
 * exactly this reason, and a human typing the command may omit it, in which
 * case behaviour is unchanged from before this marker existed.
 *
 * Any other leading `--`-prefixed token throws.
 *
 * `rest` is the remainder of the original string after the consumed flags
 * (and the `--` marker, if present), with only leading whitespace stripped —
 * internal spacing and trailing content are preserved untouched, because
 * `rest` becomes the opaque reason string passed through to the restart flow.
 */
export function parseRenewCommandArgs(args: string): { afterTurn: boolean; rest: string } {
  let afterTurn = false;
  let index = 0;

  while (index < args.length) {
    let start = index;
    while (start < args.length && /\s/.test(args[start])) start++;
    if (start >= args.length) {
      index = start;
      break;
    }

    let end = start;
    while (end < args.length && !/\s/.test(args[end])) end++;
    const token = args.slice(start, end);

    if (!token.startsWith("--")) {
      index = start;
      break;
    }

    if (token === "--") {
      index = end;
      break;
    }

    if (token === "--after-turn") {
      afterTurn = true;
      index = end;
      continue;
    }

    throw new Error(`/pi-renew: unknown flag ${token}. The only supported flag is --after-turn.`);
  }

  return { afterTurn, rest: args.slice(index).replace(/^\s+/, "") };
}
