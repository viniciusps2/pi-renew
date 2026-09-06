/**
 * Task 2.5 (live, O5) — the deferred *live* half of the renewal-context state contract.
 *
 * Every other test in this package mocks `pi` and the session context. This one, like
 * `test/restart-e2e.test.ts`, drives a **real `pi --mode rpc` process** and asserts on what it
 * actually wrote to disk. The property it proves is the one 2.5 exists to protect: a registered
 * renewal context **survives a real session replacement** (the extension is re-instantiated across
 * the replacement, so nothing in memory carries over — only the record, re-keyed by `rename()`),
 * and the restart counter increments 0 → 1 across a **single** `/pi-renew` restart.
 *
 * WHY THE COMPLETION GATE IS THE DISK, NOT `agent_settled` (F133/F134/F139):
 *   A replacement session's first turn is a full agent run whose settle latency is extreme and
 *   non-deterministic (measured 13 s / 245 s / over 300 s on three consecutive runs of the same
 *   restart, on the same pin), so a live test that waits for `agent_settled` is a coin flip. The
 *   restart's whole *state* effect — the record renamed onto the new session id with
 *   `restartCount` incremented — is readable on disk ~4 s after the prompt (F133), long before any
 *   settle. So the restart step below gates on the on-disk *record*, bounded by a wall-clock
 *   poll (240 s), never by settlement. `agent_settled` appears in this file only inside
 *   comments; nothing here branches control flow on it.
 *
 * WHY REGISTRATION IS WRITTEN TO DISK RATHER THAN TOOL-CALLED (decision 8):
 *   The extension registers a renewal context only through the `set_renewal_context` *tool*
 *   (`pi-renew.ts` registers it as a tool; there is no command path), so a test that made the
 *   model emit that call would make a state-survival test depend on model behaviour. Instead we
 *   write the record straight to `<proj>/.pi/renew/renewal-<seedId>.json` — exactly the shape the
 *   tool would persist — keyed to the seed's session id. Registration *semantics* (input
 *   validation, the reset-to-0 on a fresh registration) are already covered by the mocked
 *   `test/registration.test.ts` and `test/renewal-reinstantiation.test.ts`; this test asserts
 *   survival, not input validation.
 *
 * WHY THIS RUNS IN A TEMP PROJECT DIR (F137):
 *   `.pi/renew/` is created under the **spawned process's cwd**, so the records land in
 *   `<proj>/.pi/renew`, not in the repo. Spawning with `cwd = <proj>` (a fresh temp dir) keeps every
 *   artifact — session files *and* records — inside `<base>`, which `afterAll` removes, so nothing
 *   pollutes the repo.
 *
 * THE GATE IS ACTUALLY TWO STAGES, NOT ONE (F145):
 *   The restart has two on-disk effects and they land at very different times. The **record**
 *   (`renewal-<sessionId>.json`) is re-keyed onto the new session id within ~1-4 s of the restart
 *   prompt (F133) — that is what `pollRecord` above waits for. The **replacement session file**
 *   itself is written lazily by `pi`, only on the first assistant response (`session-manager.js`
 *   creates it then, matching the `newSession()` contract) — tens of seconds later, and gated by the
 *   same non-deterministic settle latency described above. Asserting on the session file right after
 *   the record poll resolves is a race: the file provably does not exist yet. So the test waits for
 *   each artifact **separately**, with its own bounded poll (`pollReplacementSessionFile`, gated by
 *   `REPLACEMENT_FILE_TIMEOUT_MS`) — still never on `agent_settled`, still purely on wall clock and
 *   the disk.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { discoverDefaultModel } from "./default-model";

// --- Portable paths (computed from this file's own location, never hardcoded to /data/...) ---
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** The extension entry point, loaded with an explicit `-e` (F125). Absolute, in the repo. */
const EXTENSION_PATH = resolve(TEST_DIR, "..", "pi-renew.ts");

// --- The model: discovered from `pi`'s own settings, never pinned here (see default-model.ts).
// The seed's `model_change` entry and the `--model` this test spawns `pi` with both come from
// this one read, so they cannot disagree — which is the only thing the fixture actually needs.
// Discovery throws rather than guessing: a live run against an unintended model would report a
// pass that means nothing.
const { id: MODEL_ID, provider: MODEL_PROVIDER, modelId: MODEL_ID_SHORT } = discoverDefaultModel();

// --- Seed + registration constants ---
const SEED_ID = "aaaa1111aaaa";
const SEED_FILE = `${SEED_ID}.jsonl`;
const SEED_RECORD_KEY = `renewal-${SEED_ID}.json`;
/**
 * The registered renewal context. A single opaque string that (a) cannot occur by accident,
 * (b) survives a JSON round-trip byte-for-byte, (c) has no leading/trailing whitespace, and
 * (d) has no leading `/` — a leading slash would engage the expander / registration-validation
 * semantics this test is deliberately not trying to exercise.
 */
const CTX = "PROBE-CTX-7A-STATE-SURVIVAL-VERBATIM";
/** The reason the restart is sent with. */
const REASON_R1 = "probe-r1";

// --- Tuning ---
/** Readiness-gate and record-poll interval. */
const POLL_MS = 2_000;
/** Bound on EACH record poll (decision 9): 240 s; the it-timeout (600 s) is the runner's guard. */
const POLL_TIMEOUT_MS = 240_000;
/**
 * Bound on the replacement-session-file poll (F145): `pi` writes this file lazily, only on the
 * first assistant response (`session-manager.js` creates it then, matching the `newSession()`
 * contract), so it lands long after the record does. 3.8's `ARTIFACT_TIMEOUT_MS` uses the same
 * 300 s bound for the same reason — see `restart-e2e.test.ts`.
 */
const REPLACEMENT_FILE_TIMEOUT_MS = 300_000;
/** Grace for a clean (stdin-closed) exit; a hung child is SIGKILLed. */
const EXIT_WAIT_MS = 30_000;

interface ParsedRecord {
  version?: number;
  context?: string;
  includeSummary?: boolean;
  includeNextSteps?: boolean;
  restartCount?: number;
  registeredAt?: string;
  lastReason?: string;
}

/** The `<cwd>/.pi/renew` directory the spawned process writes its renewal records into (F137). */
function renewDir(projDir: string): string {
  return join(projDir, ".pi", "renew");
}

/**
 * Write the v3 seed: one `parentId` chain — a `session` header, one `model_change` to the pin,
 * then two user/assistant pairs. No input ramp is needed here (Part B asserts no "input dropped"
 * property — that is 3.8's); two pairs are enough, mirroring the measured probe.
 */
function writeSeed(sessionsDir: string, projDir: string): string {
  const ts = "2026-08-28T00:00:00.000Z";
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id: SEED_ID, timestamp: ts, cwd: projDir }));
  let parent: string | null = null;
  const mc = "aaaa2222bbbb";
  lines.push(
    JSON.stringify({
      type: "model_change",
      id: mc,
      parentId: null,
      timestamp: ts,
      provider: MODEL_PROVIDER,
      modelId: MODEL_ID_SHORT,
    })
  );
  parent = mc;
  // Two user/assistant pairs, modest usage; Part B does not read the seed's usage values.
  [20_000, 22_000].forEach((inp, i) => {
    const uid = "aaaa" + (5000 + i).toString(16).padStart(8, "0");
    lines.push(
      JSON.stringify({
        type: "message",
        id: uid,
        parentId: parent,
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text: `seed turn ${i} user` }] },
      })
    );
    parent = uid;
    const aid = "bbbb" + (5000 + i).toString(16).padStart(8, "0");
    lines.push(
      JSON.stringify({
        type: "message",
        id: aid,
        parentId: parent,
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `seed turn ${i} assistant` }],
          usage: {
            input: inp,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: inp + 40,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        },
      })
    );
    parent = aid;
  });
  const seedPath = join(sessionsDir, SEED_FILE);
  writeFileSync(seedPath, `${lines.join("\n")}\n`, "utf8");
  return seedPath;
}

/**
 * Write the registered renewal-context record straight to disk (decision 8) — the same shape the
 * `set_renewal_context` tool would persist, keyed to the seed's session id, so the extension's
 * session_start adoption and the first restart's `claimRestartOrdinal` find exactly this record.
 */
function writeRegistration(projDir: string, sessionId: string): void {
  const dir = renewDir(projDir);
  mkdirSync(dir, { recursive: true });
  const record: ParsedRecord = {
    version: 1,
    context: CTX,
    includeSummary: true,
    includeNextSteps: true,
    restartCount: 0,
    registeredAt: "2026-08-28T00:00:00.000Z",
  };
  writeFileSync(join(dir, `renewal-${sessionId}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
}

/** All `renewal-*.json` record filenames currently in the renew dir (may be empty). */
function listRenewalKeys(projDir: string): string[] {
  const dir = renewDir(projDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("renewal-") && f.endsWith(".json"));
}

/** Read and parse one record. Throws if it cannot be read — the poll treats that as "not yet". */
function readRecord(projDir: string, key: string): ParsedRecord {
  const raw = readFileSync(join(renewDir(projDir), key), "utf8");
  return JSON.parse(raw) as ParsedRecord;
}

/**
 * Poll the renew dir every `POLL_MS` until `predicate(keys, readKey)` is true, or reject after
 * `POLL_TIMEOUT_MS`. A predicate that throws (a mid-write record) counts as "not yet" — the poll
 * keeps going; only the wall-clock bound can fail the run.
 */
function pollRecord(
  projDir: string,
  predicate: (keys: string[], readKey: (k: string) => ParsedRecord) => boolean,
  what: string
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      try {
        if (predicate(listRenewalKeys(projDir), (k) => readRecord(projDir, k))) {
          if (timer) clearTimeout(timer);
          resolveP();
          return;
        }
      } catch {
        /* a half-written record must not throw out of the poll */
      }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        rejectP(new Error(`timed out (${POLL_TIMEOUT_MS} ms) waiting for: ${what}`));
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

/**
 * Poll `sessionsDir` every `POLL_MS` until the replacement session file has fully landed, or
 * reject after `REPLACEMENT_FILE_TIMEOUT_MS` (F145). This is a SEPARATE poll from `pollRecord`
 * above — deliberately not folded into it (decision 2): the record and the session file are
 * different artifacts that land at very different times (record ~1-4 s; session file only on
 * `pi`'s first assistant response), so generalising `pollRecord` to cover both would put the
 * already-proven record half at risk for no gain.
 *
 * The predicate is deliberately as strong as assertion block (c) it gates — mirroring the
 * discipline `restart-e2e.test.ts` documents on `sessionDirHasAssistantArtifact` ("so the poll can
 * never succeed on a partially-flushed entry"). A candidate file only counts once ALL of:
 *   (a) it is a `.jsonl` in `sessionsDir` other than the seed, and its first line parses as a
 *       header whose `parentSession` === `seedAbs`;
 *   (b) it contains a `type === "custom_message"` entry with `customType === "pi-renew-restart"`;
 *   (c) it contains a `type === "message"` entry with `message.role === "user"` whose collected
 *       text === `CTX`.
 * Parsed file-by-file and line-by-line, so a half-flushed or unparseable line counts as "not yet"
 * and never throws out of the poll (mirrors `pollRecord`'s and `sessionDirHasAssistantArtifact`'s
 * try/catch-per-line discipline). Resolves with the matching filename — the caller uses it
 * directly rather than re-scanning the directory, which would re-introduce a (smaller) race and
 * duplicate the header-parsing logic (decision 4).
 */
function pollReplacementSessionFile(
  sessionsDir: string,
  seedAbs: string
): Promise<{ file: string; headerMatchCount: number }> {
  const findMatch = (): { file: string; headerMatchCount: number } | null => {
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl") && f !== SEED_FILE);
    } catch {
      return null; // sessionsDir not readable yet — not yet
    }
    let match: string | null = null;
    let headerMatchCount = 0;
    for (const f of files) {
      try {
        const lines = readFileSync(join(sessionsDir, f), "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        const header = JSON.parse(lines[0]) as { parentSession?: string };
        if (header.parentSession !== seedAbs) continue; // (a)
        // Counted for the CARDINALITY assertion the caller makes: this test drives exactly ONE
        // restart, so a second file whose header links to the seed would be a re-fire — the very
        // defect class 2.5 exists to catch. Counting here costs no extra I/O (the header is already
        // parsed) and restores the pre-F145 `toHaveLength(1)` check that the returned-filename
        // refactor would otherwise have dropped to a mere existence check.
        headerMatchCount++;
        let hasRestartMsg = false;
        let hasContext = false;
        for (const line of lines) {
          const entry = JSON.parse(line) as {
            type?: string;
            customType?: string;
            message?: { role?: string; content?: unknown };
          };
          if (entry.type === "custom_message" && entry.customType === "pi-renew-restart") {
            hasRestartMsg = true; // (b)
          }
          if (entry.type === "message" && entry.message?.role === "user" && collectText(entry.message.content) === CTX) {
            hasContext = true; // (c)
          }
        }
        if (hasRestartMsg && hasContext && match === null) match = f;
      } catch {
        continue; // a half-flushed or unparseable file/line counts as "not yet", never throws
      }
    }
    return match === null ? null : { file: match, headerMatchCount };
  };

  return new Promise((resolveP, rejectP) => {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      const match = findMatch();
      if (match) {
        if (timer) clearTimeout(timer);
        resolveP(match);
        return;
      }
      if (Date.now() - startedAt > REPLACEMENT_FILE_TIMEOUT_MS) {
        rejectP(
          new Error(
            `timed out (${REPLACEMENT_FILE_TIMEOUT_MS} ms) waiting for: the replacement session file ` +
              `(parentSession === seed, a pi-renew-restart custom_message, and the context verbatim)`
          )
        );
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

/**
 * Drive the whole O5 run: spawn `pi --mode rpc`, gate on the extension being loaded (F129),
 * then send one **whole-message** `/pi-renew <reason>` restart (F126 — the whole message is
 * the command, or `pi` answers it as chat), gated on the on-disk record (F133). Returns the
 * collected event stream, the still-live child, and the record snapshot taken at the hop so the
 * assertions can be made without re-reading.
 */
function driveRenewalState(
  sessionsDir: string,
  projDir: string,
  seedPath: string,
  onChild: (c: ChildProcess) => void
): Promise<{
  events: any[];
  child: ChildProcess;
  r1: { keys: string[]; record: ParsedRecord };
}> {
  return new Promise((resolveP, rejectP) => {
    const args = [
      "--session-dir", sessionsDir,
      "--session", seedPath,
      "--mode", "rpc",
      "-nc",
      "-nt", // F133/F134/F139: with tools the first turn can run past 300 s; the record is what we gate on
      "--model", MODEL_ID,
      "-e", EXTENSION_PATH, // F125: explicit -e loads the extension; deliberately NO -ne
    ];
    const child = spawn("pi", args, { cwd: projDir, stdio: ["pipe", "pipe", "pipe"] });
    onChild(child);

    const events: any[] = [];
    let finished = false;
    let gateCount = 0;

    const fail = (msg: string) => {
      if (finished) return;
      finished = true;
      rejectP(new Error(msg));
    };

    const send = (id: string, message: string) => {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
      }
    };

    // Readiness gate (F129): a resumed session emits no `{"type":"session"}` event on the RPC
    // stream, so we gate on a model-free `get_commands` round-trip that lists `pi-renew`, and
    // only then send the first restart prompt.
    const doGate = () => {
      if (!child.stdin.writable) return;
      gateCount += 1;
      child.stdin.write(`${JSON.stringify({ id: `gate-${gateCount}`, type: "get_commands" })}\n`);
    };
    const gateTimer = setInterval(doGate, POLL_MS);
    setTimeout(doGate, 500);

    const runRestarts = async (): Promise<void> => {
      try {
        // r1: dispatch the restart; the record is renamed onto the new session id and
        // `restartCount` is incremented *before* the replacement turn (F133).
        send("p1", `/pi-renew ${REASON_R1}`);
        await pollRecord(
          projDir,
          (keys) => {
            if (keys.length !== 1) return false;
            if (keys[0] === SEED_RECORD_KEY) return false; // still the pre-restart key
            const r = readRecord(projDir, keys[0]);
            return r.restartCount === 1 && r.lastReason === REASON_R1;
          },
          "r1: exactly one re-keyed record with restartCount 1"
        );
        const r1Keys = listRenewalKeys(projDir);
        const r1Record = r1Keys.length === 1 ? readRecord(projDir, r1Keys[0]) : {};

        if (finished) return;
        finished = true;
        clearInterval(gateTimer);
        resolveP({ events, child, r1: { keys: r1Keys, record: r1Record } });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // never let one malformed line kill the run
        }
        events.push(event);
        // On the first successful get_commands that lists our extension command, fire the run.
        if (
          event?.type === "response" &&
          event?.command === "get_commands" &&
          event?.success === true &&
          Array.isArray(event?.data?.commands) &&
          event.data.commands.some((c: any) => c?.name === "pi-renew")
        ) {
          clearInterval(gateTimer);
          void runRestarts();
        }
      }
    });

    child.on("error", (err) => {
      // e.g. `pi` not on PATH — a spawn error means the run never happened; fail the test.
      fail(`failed to spawn pi: ${err.message}`);
    });
    // A crash/kill before the run resolves fails now; a later exit after resolve is expected (we
    // close stdin on purpose in closeAndWaitExit) and is ignored by the finished guard.
    child.on("exit", () => {
      if (!finished) fail("the pi process exited before the restart completed");
    });
  });
}

/** Close stdin and wait for the child to exit on its own; report code + signal. */
function closeAndWaitExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveP) => {
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ code, signal });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, EXIT_WAIT_MS);
    child.on("exit", finish);
    const stdin = child.stdin;
    if (stdin && stdin.writable) {
      stdin.end(); // a clean stdin-close makes the rpc-mode host shut down with code 0 (F138)
    } else {
      // stdin is already unavailable (the child died before we got here) — report the exit
      // state it already has, so a crash is not mistaken for a clean exit.
      finish(child.exitCode, child.signalCode);
    }
  });
}

/** Join the text of a message content field (a string, or an array of `{type,text}` blocks). */
function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text) : ""))
      .join("");
  }
  return "";
}

describe("task 2.5 (live, O5) — renewal state survives a real session replacement (pi --mode rpc)", () => {
  let baseDir = "";
  let sessionsDir = "";
  let projDir = "";
  let child: ChildProcess | null = null;

  // Cleanup on EVERY exit path: a live `pi` must never be left held by the suite, and the temp
  // base (session files + records) must be removed. Runs on pass, on fail, and on a watchdog
  // timeout. Mirrors the twin in `test/restart-e2e.test.ts`.
  afterAll(() => {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (baseDir) {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  }, 600_000);

  it(
    "one /pi-renew restart: one record, re-keyed, restartCount 0→1, context verbatim",
    async () => {
      // 1. Fresh isolated temp base: <base>/sessions (where session files land) and <base>/proj
      //    (the spawned process's cwd, so .pi/renew lands here — F137). Nothing touches the repo.
      baseDir = mkdtempSync(join(tmpdir(), "pi-renew-live-"));
      sessionsDir = join(baseDir, "sessions");
      projDir = join(baseDir, "proj");
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(projDir, { recursive: true });

      // 2. Write the v3 seed and the registered record (decision 8), both keyed to the seed id.
      const seedPath = writeSeed(sessionsDir, projDir);
      writeRegistration(projDir, SEED_ID);
      const seedAbs = seedPath; // absolute path as `pi` records it in the replacement header

      // 3. Drive: spawn, gate on the extension (F129), one restart (F126), gated on the on-disk
      //    record (F133) — never on agent_settled.
      const { events, child: liveChild, r1 } = await driveRenewalState(sessionsDir, projDir, seedPath, (c) => {
        child = c;
      });

      // (a) after the restart: exactly one record, re-keyed off the seed, restartCount 1, reason
      //     probe-r1. Proves the spec's "Context survives session replacement" + the D-H4 rename, live.
      expect(r1.keys, `exactly one renewal-*.json after the restart; found ${JSON.stringify(r1.keys)}`).toHaveLength(1);
      expect(r1.keys[0], "the record must have been re-keyed off the seed's id").not.toBe(SEED_RECORD_KEY);
      expect(r1.record.restartCount, "the record must have claimed ordinal 1").toBe(1);
      expect(r1.record.lastReason, "the record must record its reason").toBe(REASON_R1);

      // (b) the record is the SAME one after the restart: context byte-identical and toggles intact
      //     — "stored verbatim, meaning belongs to the caller" across the re-instantiation boundary.
      expect(r1.record.context, "the registered context must survive the restart byte-for-byte").toBe(CTX);
      expect(r1.record.includeSummary, "includeSummary must be preserved across the boundary").toBe(true);
      expect(r1.record.includeNextSteps, "includeNextSteps must be preserved across the boundary").toBe(true);

      // (c) the replacement's session file (the one whose header links to the seed): it carries
      //     the restart provenance as a `pi-renew-restart` custom message (text names restart #1
      //     + the reason) and the registered context verbatim as the user message that starts its
      //     one turn (D-H7/D-H14/F135).
      //
      //     F145: `pi` writes this file lazily, only on the first assistant response — long after
      //     the record above lands — so (unlike (a)/(b)) it needs its OWN bounded wait rather than
      //     an immediate read. `pollReplacementSessionFile`'s predicate is exactly as strong as
      //     what this block goes on to assert (parentSession===seed, the restart provenance, the
      //     context verbatim), so once it resolves we read the file it names directly — no
      //     re-scan, which would just re-introduce a (smaller) race and re-duplicate the
      //     header-parsing this poll already did (decision 4). Still never gated on
      //     `agent_settled` — see the file-header note.
      const replacement = await pollReplacementSessionFile(sessionsDir, seedAbs);
      expect(
        replacement.headerMatchCount,
        "exactly one replacement session file links back to the seed"
      ).toBe(1);
      const firstFile = join(sessionsDir, replacement.file);
      const entries: any[] = readFileSync(firstFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));

      const restartMsg = entries.find((e) => e?.type === "custom_message" && e?.customType === "pi-renew-restart");
      expect(restartMsg, "the first replacement must carry a pi-renew-restart custom message").toBeDefined();
      const preludeText =
        typeof restartMsg!.content === "string" ? restartMsg!.content : JSON.stringify(restartMsg!.content);
      expect(preludeText, "the provenance must name restart #1").toContain("restart #1");
      expect(preludeText, "the provenance must carry the r1 reason").toContain(REASON_R1);

      const userTexts = entries
        .filter((e) => e?.type === "message" && e?.message?.role === "user")
        .map((e) => collectText(e.message.content));
      expect(userTexts, "the first replacement must contain a user message carrying the context").toContain(CTX);

      // (d) no extension_error anywhere in the captured stream — a failed restart surfaces one by design.
      const extensionErrors = events.filter((e) => e?.type === "extension_error");
      expect(extensionErrors, "no extension_error may appear for a clean one-restart run").toHaveLength(0);

      // (e) close stdin → a clean exit (code 0, not a signal), which holds mid-turn too (F138).
      const exit = await closeAndWaitExit(liveChild);
      expect(exit.code, `expected a clean exit (code 0); got code=${exit.code} signal=${exit.signal}`).toBe(0);
      expect(exit.signal, "a clean stdin-close exit must not be a signal").toBeNull();
    },
    // F145: worst case is now record-poll 240 s + file-poll 300 s + EXIT_WAIT_MS 30 s, which no
    // longer fits under 600 s with any headroom.
    900_000
  );
});
