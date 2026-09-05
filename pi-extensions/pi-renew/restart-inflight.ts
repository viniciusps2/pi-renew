import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 * On-disk storage for the *in-flight* state of a `new-session` restart, keyed by the
 * parent session id. A session's record lives at `.pi/renew/restart-inflight-<sessionId>.json`
 * under the project's cwd. A replacement session has a different id, so it adopts its
 * predecessor's record by renaming the file onto its own id (the D3 "delivered"
 * handshake in `pi-renew.ts`'s `session_start` handler).
 *
 * This is deliberately a separate file from the renewal-context record
 * (`renewal-<sessionId>.json`): the in-flight state is keyed by the *parent* session
 * id, so it must exist whether or not a renewal context was ever registered for that
 * session (design D1: "a separate file exists whether or not a renewal context is
 * registered"), and it keeps the `RenewalState` schema and `RENEWAL_STATE_VERSION`
 * untouched (D-IN10: purely additive).
 *
 * Why a file at all: the extension is re-instantiated when the session is replaced, and
 * the in-flight flag must bridge old→new across that boundary. Only file-persisted state
 * survives it — an in-memory flag is lost exactly when it would be needed.
 */

/** Schema version of the on-disk in-flight record; the read refuses any other value. */
export const RESTART_INFLIGHT_VERSION = 1;

/**
 * A record whose `at` is older than this is treated as *absent* (D-IN5): it neither
 * blocks a new restart nor counts as delivered. 10 minutes — a backstop against a
 * permanently-stuck in-flight state (the driver's supervision window is the other
 * backstop; this one is the extension's own).
 */
export const RESTART_INFLIGHT_MAX_AGE_MS = 600_000;

/**
 * The on-disk in-flight restart record. `parentSessionId` is the session the restart is
 * restarting (the one about to be replaced); it is both the file's key and a stable
 * scoping label so two restarts in different sessions never share a record.
 *
 * `restartId` is a stable, monotonic-per-parent label taken from the ordinal the restart
 * claimed (`claimRestartOrdinal`); it only needs to differ between *distinct* restarts,
 * and within one parent a blocked repeat never reaches `beginRestart`, so it cannot
 * collide (D-IN3).
 */
export interface RestartInflight {
  version: number;
  /** Stable, monotonic-per-parent label (see interface note). */
  restartId: number;
  /** The parent session id this restart is scoped to; equals the file's key. */
  parentSessionId: string;
  /** The reason the restart was requested, stored verbatim. */
  reason: string;
  /** ISO-8601 timestamp of when the restart went in flight. */
  at: string;
  /** "in-flight" while the restart is pending; "delivered" once the replacement arrived. */
  state: "in-flight" | "delivered";
}

/**
 * The directory holding every in-flight record. Same directory as the renewal-context
 * records (`.pi/renew/`), so one `mkdirSync` covers both.
 */
export function getRestartInflightDir(cwd: string): string {
  return join(cwd, ".pi", "renew");
}

/**
 * The on-disk path of the in-flight record for `sessionId`:
 * `.pi/renew/restart-inflight-<sessionId>.json` under `cwd`.
 */
export function getRestartInflightPath(cwd: string, sessionId: string): string {
  return join(getRestartInflightDir(cwd), `restart-inflight-${sessionId}.json`);
}

/**
 * Reads a session's in-flight record. Returns the parsed record, or `null`.
 *
 * `null` (never a throw) for: a **missing** file, an **empty** file, a **corrupt-JSON**
 * file, or a record whose `version` is not `RESTART_INFLIGHT_VERSION` — the last two
 * log a `console.warn` naming the file (D-IN4). In addition, a record whose `at` is older
 * than `RESTART_INFLIGHT_MAX_AGE_MS` is treated as **absent** (D-IN5) and read as `null`:
 * an expired in-flight state neither blocks a new restart nor counts as delivered.
 *
 * The read is a plain disk read (not a cache), so a second extension instance — the
 * replacement session — re-discovers what the first one persisted (design D3).
 */
export function readRestartInflight(cwd: string, sessionId: string): RestartInflight | null {
  const path = getRestartInflightPath(cwd, sessionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // A read failure on a path that `existsSync` just saw as present is a race (e.g.
    // reaped between the two); it is a missing state, not a corrupt one — no warn, no throw.
    return null;
  }
  if (raw.trim() === "") return null;
  let parsed: { version?: number };
  try {
    parsed = JSON.parse(raw) as { version?: number };
  } catch {
    console.warn(`pi-renew: in-flight record at ${path} is not valid JSON; treating as absent`);
    return null;
  }
  if (parsed.version !== RESTART_INFLIGHT_VERSION) {
    console.warn(
      `pi-renew: in-flight record at ${path} has version ${String(parsed.version)}, expected ${RESTART_INFLIGHT_VERSION}; treating as absent`
    );
    return null;
  }
  const record = parsed as RestartInflight;
  // Expiry (D-IN5): a record whose in-flight moment is too old is a stuck state, not a
  // live block — treat it as absent so it neither blocks a new restart nor counts as
  // delivered. Parsed from the record's own `at`, not the file mtime, so the state is a
  // property of the record, not of the clock at write time.
  const atMs = Date.parse(record.at);
  if (!Number.isNaN(atMs) && Date.now() - atMs > RESTART_INFLIGHT_MAX_AGE_MS) {
    return null;
  }
  return record;
}

/**
 * Atomically persists a session's in-flight record: the JSON is serialised to a temp file
 * in the same directory, then renamed over the record. Rename within one directory is
 * atomic, so a crash mid-write can never leave a half-written record (the same idiom as
 * `writeRenewalState`). A second call for the same session overwrites the first.
 */
export function writeRestartInflight(cwd: string, parentSessionId: string, rec: RestartInflight): void {
  const dir = getRestartInflightDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getRestartInflightPath(cwd, parentSessionId);
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${path}.tmp-${suffix}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Flips a session's in-flight record to `state: "delivered"`. This is the D3 handshake on
 * the replacement side: the replacement session beginning to process its continuation is the
 * arrival proof, and marking the record delivered lifts the block.
 *
 * A **no-op** (no throw) when no record exists for `sessionId` — including when it is a
 * fresh/unknown id, or the record has already aged past `RESTART_INFLIGHT_MAX_AGE_MS`
 * (which `readRestartInflight` reads as absent). In every case the `at` timestamp is
 * preserved; only `state` changes.
 */
export function markRestartInflightDelivered(cwd: string, sessionId: string): void {
  const record = readRestartInflight(cwd, sessionId);
  if (record === null) return;
  writeRestartInflight(cwd, sessionId, { ...record, state: "delivered" });
}

/**
 * Renames the predecessor's in-flight record onto the current session's key, so a
 * replacement session re-discovers the record its predecessor left in flight. Atomic in the
 * same sense as `adoptRenewalState`: a crash mid-adoption leaves exactly one of the two
 * keys, never both, never neither. Contents are untouched (the `restartId` is not
 * re-minted; only the file's key changes).
 *
 * Returns `true` when a rename happened, `false` when the predecessor had no record to
 * adopt (a missing predecessor file is a normal state, not an error) or when the current
 * session already has its own record (which always wins and is never overwritten).
 */
export function adoptRestartInflight(cwd: string, fromId: string, toId: string): boolean {
  const src = getRestartInflightPath(cwd, fromId);
  const dest = getRestartInflightPath(cwd, toId);
  if (!existsSync(src)) return false;
  // The current session's own record always wins; never overwrite it.
  if (existsSync(dest)) return false;
  renameSync(src, dest);
  return true;
}

/**
 * Deletes `restart-inflight-*.json` records whose mtime is older than
 * `RESTART_INFLIGHT_MAX_AGE_MS`. Never deletes a record the caller is currently acting on
 * is not tracked here (the caller passes the live cwd only), never touches non-matching
 * files (`.pi/renew/` also holds the renewal-context records), and never throws.
 */
export function reapRestartInflight(cwd: string): void {
  const dir = getRestartInflightDir(cwd);
  if (!existsSync(dir)) return;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // e.g. `.pi/renew` exists but is not a directory. A sweep is housekeeping; it must
    // never take the session down with it.
    return;
  }
  for (const entry of entries) {
    const base = basename(entry);
    if (!base.startsWith("restart-inflight-") || !base.endsWith(".json")) continue;
    try {
      const mtime = statSync(join(dir, entry)).mtimeMs;
      if (now - mtime > RESTART_INFLIGHT_MAX_AGE_MS) {
        unlinkSync(join(dir, entry));
      }
    } catch {
      // A sweep must never take the session down with it.
    }
  }
}

/**
 * Mints the in-flight record for a restart about to be dispatched: takes the restart's
 * claimed ordinal as its `restartId` (D-IN3) and writes it with `state: "in-flight"`. This
 * is called in the command handler *immediately after* the ordinal is claimed and
 * *before* the (possibly aborting) session replacement, so the flag is persisted before the
 * replace and a mid-write crash never leaves the ordinal claimed but the flag absent
 * (D-IN7).
 */
export function beginRestart(cwd: string, parentSessionId: string, reason: string, ordinal: number): void {
  writeRestartInflight(cwd, parentSessionId, {
    version: RESTART_INFLIGHT_VERSION,
    restartId: ordinal,
    parentSessionId,
    reason,
    at: new Date().toISOString(),
    state: "in-flight",
  });
}

/**
 * The idempotent stand-down guard (D-IN6). Returns whether a `new-session` restart request
 * for `parentSessionId` should be **blocked** — i.e. whether there is a non-expired,
 * non-`delivered` in-flight record for that parent — together with the record that drove
 * the decision (so a caller can name the offending `restartId`). A missing, empty,
 * malformed, unknown-`version`, expired, or `delivered` record all yield `blocked: false`.
 */
export function checkRestartInFlight(
  cwd: string,
  parentSessionId: string,
): { blocked: boolean; record: RestartInflight | null } {
  const record = readRestartInflight(cwd, parentSessionId);
  if (record === null) return { blocked: false, record: null };
  return { blocked: record.state === "in-flight", record };
}

/**
 * §3.3: the observable "handoff delivered?" predicate. Returns `true` only
 * when the in-flight record for `parentSessionId` exists and its state is
 * `"delivered"` — i.e. the replacement session's extension instance has
 * observed its own processing begin (D3). Returns `false` for a missing
 * record, an expired record, and an `"in-flight"` record.
 *
 * Exported so the reminder (§2.3) and the driver (§4) can import one stable
 * boolean without re-implementing the read.
 */
export function wasHandoffDelivered(cwd: string, parentSessionId: string): boolean {
  return readRestartInflight(cwd, parentSessionId)?.state === "delivered";
}
