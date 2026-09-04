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
 * On-disk storage for a registered delegate context, keyed by session id.
 * A session's record lives at `.pi/loop/delegate-<sessionId>.json` under the
 * project's cwd. A replacement session has a different id, so it adopts its
 * predecessor's record by renaming the file onto its own id.
 */
export const DELEGATE_STATE_VERSION = 1;

/** Records whose mtime is older than this are reaped; 14 days. */
export const DELEGATE_STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Cap on parent-chain hops when resolving a record through `parentSession`
 * headers, so a malformed or cyclic chain cannot loop forever.
 */
const PARENT_WALK_MAX_HOPS = 20;

export interface DelegateState {
  version: number;
  /** Free text stored verbatim; its meaning belongs entirely to the caller. */
  context: string;
  includeSummary: boolean;
  includeNextSteps: boolean;
  restartCount: number;
  /** ISO-8601 timestamp of registration. */
  registeredAt: string;
  /** Written by the restart flow; absent at registration time. */
  lastReason?: string;
}

export function getDelegateStateDir(cwd: string): string {
  return join(cwd, ".pi", "loop");
}

export function getDelegateStatePath(cwd: string, sessionId: string): string {
  return join(getDelegateStateDir(cwd), `delegate-${sessionId}.json`);
}

/**
 * A session file is named `<timestamp>_<sessionId>.jsonl`; the id is the
 * filename with the leading `<timestamp>_` prefix stripped. This needs no
 * file access, so it works before the file has been flushed.
 */
export function sessionIdFromSessionFile(filePath: string): string {
  const stem = basename(filePath).replace(/\.jsonl$/, "");
  const idx = stem.indexOf("_");
  return idx === -1 ? stem : stem.slice(idx + 1);
}

/**
 * Reads the header (first line) of a session `.jsonl` and returns its
 * `parentSession` absolute path, or undefined for a root session or a
 * missing file.
 */
function readParentSession(sessionFile: string): string | undefined {
  if (!existsSync(sessionFile)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf-8").split("\n", 1)[0];
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let header: { parentSession?: string };
  try {
    header = JSON.parse(raw) as { parentSession?: string };
  } catch {
    return undefined;
  }
  return header.parentSession;
}

/**
 * Renames the predecessor's record onto the current session's key.
 * The rename is atomic: a crash mid-adoption leaves exactly one of the two
 * keys, never both, never neither. Contents are untouched — in particular
 * `restartCount` is not incremented here; that belongs to the restart.
 */
function adoptDelegateState(
  cwd: string,
  predecessorId: string,
  currentId: string
): boolean {
  const src = getDelegateStatePath(cwd, predecessorId);
  const dest = getDelegateStatePath(cwd, currentId);
  if (!existsSync(src)) return false;
  // The current session's own record always wins; never overwrite it.
  if (existsSync(dest)) return false;
  renameSync(src, dest);
  return true;
}

/**
 * Resolves the delegate state record to read for a session, adopting a
 * predecessor's record when the session was replaced (and its id changed).
 *
 * Order: (1) a record under the current id; (2) adoption from
 * `previousSessionFile` when supplied; (3) a bounded walk up the
 * `parentSession` chain in session file headers; (4) nothing — a missing
 * record is a normal state, not an error.
 */
export function resolveDelegateState(
  cwd: string,
  sessionId: string,
  previousSessionFile?: string
): DelegateState | null {
  const ownPath = getDelegateStatePath(cwd, sessionId);
  if (existsSync(ownPath)) return readDelegateState(cwd, sessionId);

  if (previousSessionFile !== undefined) {
    const predecessorId = sessionIdFromSessionFile(previousSessionFile);
    if (predecessorId !== sessionId && adoptDelegateState(cwd, predecessorId, sessionId)) {
      return readDelegateState(cwd, sessionId);
    }
  }

  let currentFile = previousSessionFile;
  // `seen` starts empty and is filled as each file is visited. Pre-seeding it
  // with the starting file makes the first `seen.has` check fire immediately,
  // which silently disables the whole walk.
  const seen = new Set<string>();
  for (let hop = 0; hop < PARENT_WALK_MAX_HOPS; hop++) {
    if (!currentFile || seen.has(currentFile)) break;
    seen.add(currentFile);
    const ancestorId = sessionIdFromSessionFile(currentFile);
    const ancestorRecord = getDelegateStatePath(cwd, ancestorId);
    if (existsSync(ancestorRecord) && adoptDelegateState(cwd, ancestorId, sessionId)) {
      return readDelegateState(cwd, sessionId);
    }
    currentFile = readParentSession(currentFile);
  }

  return null;
}

/**
 * Reads a session's delegate state record. Returns null when no record
 * exists. Throws — naming the file — on corrupt JSON or on a missing or
 * unknown `version`; no silent defaulting, coercion or migration.
 */
export function readDelegateState(
  cwd: string,
  sessionId: string
): DelegateState | null {
  const path = getDelegateStatePath(cwd, sessionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read delegate state at ${path}: ${err}`);
  }
  let parsed: { version?: number };
  try {
    parsed = JSON.parse(raw) as { version?: number };
  } catch {
    throw new Error(`Delegate state at ${path} is not valid JSON`);
  }
  if (parsed.version !== DELEGATE_STATE_VERSION) {
    throw new Error(
      `Delegate state at ${path} has version ${String(parsed.version)}, expected ${DELEGATE_STATE_VERSION}`
    );
  }
  return {
    version: DELEGATE_STATE_VERSION,
    context: (parsed as DelegateState).context,
    // Absent toggles default to true; an explicit stored value is kept.
    includeSummary:
      (parsed as DelegateState).includeSummary === undefined
        ? true
        : (parsed as DelegateState).includeSummary,
    includeNextSteps:
      (parsed as DelegateState).includeNextSteps === undefined
        ? true
        : (parsed as DelegateState).includeNextSteps,
    restartCount: (parsed as DelegateState).restartCount,
    registeredAt: (parsed as DelegateState).registeredAt,
    lastReason: (parsed as DelegateState).lastReason,
  };
}

/**
 * Atomically persists a session's delegate state: the JSON is serialised to
 * a temp file in the same directory, then renamed over the record. Rename
 * within one directory is atomic, so a restart mid-write can never leave a
 * half-written record (whereas writing the target in place can).
 */
export function writeDelegateState(
  cwd: string,
  sessionId: string,
  state: DelegateState
): void {
  const dir = getDelegateStateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getDelegateStatePath(cwd, sessionId);
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${path}.tmp-${suffix}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Claims the next restart ordinal for a session, atomically from the caller's point of
 * view: reads the record, computes `ordinal = (record?.restartCount ?? 0) + 1`, and — only
 * when a record exists — persists it back with `restartCount: ordinal` and
 * `lastReason: reason` before returning. O25: extracted from the `/pi-renew` command
 * handler (previously `pi-renew.ts:789-796`) so the `compact` restart path can claim the
 * same counter without duplicating the increment — two independent increments would let the
 * two strategies disagree about how many restarts have happened, which silently defeats an
 * outer `/loop` protocol's `max N restarts` bound (the only thing that bound reads is this
 * counter). No record on disk means nothing was ever registered: the ordinal is still 1 (the
 * first restart is always #1), but there is no record to write back, so nothing is written —
 * callers that need to know whether a record existed get it back in `record`.
 *
 * Never rolls the counter back: this function is called and its write lands before the
 * restart is even attempted, and no caller is expected to undo it on a later failure
 * (D-H15). Over-counting on a failed restart fails in the safe direction; under-counting
 * does not, since it would let a replayed delegate context under-report how many restarts
 * have already happened against an outer loop's budget.
 *
 * Throws exactly what `readDelegateState` throws (corrupt JSON, missing/unknown `version`),
 * naming the file; this function adds no try/catch of its own — each caller decides what a
 * throw here means for it (the command handler reports it via `reportRestartFailure`; the
 * `compact` path lets it propagate as an ordinary tool error, since nothing has been
 * attempted yet at that point).
 */
export function claimRestartOrdinal(
  cwd: string,
  sessionId: string,
  reason: string
): { ordinal: number; record: DelegateState | null } {
  const record = readDelegateState(cwd, sessionId);
  const ordinal = (record?.restartCount ?? 0) + 1;
  if (record) {
    writeDelegateState(cwd, sessionId, {
      ...record,
      restartCount: ordinal,
      lastReason: reason,
    });
  }
  return { ordinal, record };
}

/**
 * Deletes `delegate-*.json` records whose mtime is older than
 * DELEGATE_STATE_MAX_AGE_MS. Never deletes the current session's own
 * record, never touches non-matching files (`.pi/loop/` also holds
 * caller-supplied handover documents), and never throws.
 */
export function reapDelegateStates(cwd: string, currentSessionId: string): void {
  const dir = getDelegateStateDir(cwd);
  if (!existsSync(dir)) return;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // e.g. `.pi/loop` exists but is not a directory. A sweep is housekeeping;
    // it must never take the session down with it.
    return;
  }
  for (const entry of entries) {
    const base = basename(entry);
    if (!base.startsWith("delegate-") || !base.endsWith(".json")) continue;
    const sessionId = base.slice("delegate-".length, -".json".length);
    if (sessionId === currentSessionId) continue;
    try {
      const mtime = statSync(join(dir, entry)).mtimeMs;
      if (now - mtime > DELEGATE_STATE_MAX_AGE_MS) {
        unlinkSync(join(dir, entry));
      }
    } catch {
      // A sweep must never take the session down with it.
    }
  }
}
