/**
 * Task 3.8 — the FIRST non-mocked, live end-to-end regression test for the `pi-renew`
 * restart primitive, scoped to the `new-session` strategy only (D-H84).
 *
 * Unlike every other test in this package (which mocks the extension `pi` and the session
 * context), this test drives a **real `pi` process** and observes the restart for real:
 *
 *   1. Pre-seed a hand-built **v3** session file (a single `parentId` chain: a `session`
 *      header, one `model_change`, then four user/assistant `message` pairs whose assistant
 *      `usage.input` *ramps up*), into a **fresh temp `--session-dir`**. The ramp means the
 *      seed's *largest* assistant `usage.input` is clearly above a fresh-session input floor,
 *      so "the input dropped" is actually provable.
 *   2. Spawn `pi --session-dir <dir> --session <dir>/<seed>.jsonl --mode rpc -nc -e <ext>`
 *      (extension loaded with an explicit `-e`, and crucially **without** `-ne` — see F125),
 *      with `cwd` at the repo root.
 *   3. Confirm the extension actually loaded (a `get_commands` round-trip returns a
 *      `pi-renew` entry), then write the **whole-message** prompt
 *      `{"type":"prompt","message":"/pi-renew e2e-restart"}` to stdin (F126).
 *   4. After the prompt is sent, wait for the restart's on-disk *artifact*: a `.jsonl` in the
 *      temp `--session-dir` other than the seed that parses and contains at least one assistant
 *      `message` whose `usage.input` is a number. We poll the directory every 2 s (F133: the
 *      state effect is readable ~4 s after the prompt) and bound the wait with a hard 300 s
 *      watchdog — not with the `agent_settled` event, which under a loaded tool surface is a
 *      model performance we do not need and cannot bound (13 s / 245 s / >300 s on three
 *      consecutive runs of the same restart, on the same pin — F134/F139). Once the artifact
 *      lands we hold the stream open a further 10 s (a plain bounded sleep) to widen the
 *      extension_error net before closing stdin.
 *   5. Read the persisted session file(s) in the temp `--session-dir` and assert on them:
 *      a second session file was created, its header's `parentSession` is the seed's
 *      absolute path (the lineage link D3 requires), its first assistant turn's
 *      `usage.input` is strictly below the seed's largest and > 0 (dropped to the floor),
 *      the stream contains **no** `extension_error`, and — after stdin is closed — the
 *      process exits with code 0.
 *
 * Why the assertions key off the session files and not the model's reply: the restart's
 * new session is handed an assembled prelude as its first user message, and whatever the
 * model then does (a short answer, or a burst of tool calls) is irrelevant to whether the
 * *restart* landed. The session file is the artifact that records it (F127).
 *
 * The `compact` strategy is deliberately **not** exercised here: it is reachable only
 * through the `renew_session` tool (the model must emit the call) and runs
 * fire-and-forget after the run settles (F128), so it has no deterministic raw-RPC trigger.
 * It is covered by `test/restart-compact-payload.test.ts` and lands live in the full-loop
 * batches (7.1 / 7.2) — see D-H84.
 *
 * NOTE ON THE "SESSION IS UP" GATE — a deliberate, documented adaptation (see the report):
 * the brief's reference skeleton waits for an initial `{"type":"session"}` event on stdout.
 * On the installed `pi` (v0.84.x) **no such event is ever emitted on the RPC stream**: the
 * startup `session_start` is delivered only to the extension runner, not to the stdout
 * subscriber (verified: the first lines on stdout are other extensions' `setStatus`
 * `extension_ui_request`s, then command `response`s). Instead we gate on the same, stronger
 * signal the repo's own production driver uses (F125/O32): a `get_commands` round-trip whose
 * response lists `pi-renew`. That is model-free, deterministic, and directly confirms the
 * precondition this test exists to guard — that the extension is loaded via an explicit `-e`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// --- Portable paths (computed from this file's own location, never hardcoded to /data/...) ---
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** The extension entry point, loaded into `pi` with an explicit `-e` (F125). */
const EXTENSION_PATH = resolve(TEST_DIR, "..", "pi-renew.ts");
/** `pi` is spawned from the repo root (its `cwd`), matching the brief. */
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..");

// --- Tuning ---
/**
 * Hard watchdog (decision 3): fail the test if the restart's on-disk *artifact* never lands,
 * so the suite can never hang. This is a *bound on how long we wait for a real model call to
 * produce the first assistant turn we assert on*, not a model SLA — the restart's new session is
 * handed the assembled prelude as its first user message, so a model round-trip is required
 * before the new session file can hold an assistant `usage.input`. That first turn is slow under
 * a loaded tool surface and its settle latency is extreme and non-deterministic (measured 13 s /
 * 245 s / over 300 s on three consecutive runs of the same restart, on the same pin — F139), so
 * this is set generously (300 s) to keep a legitimate-but-slow restart from turning into a
 * false failure, while still firing long before the vitest `it`/hook timeout (360 s) so the
 * watchdog — not the runner — is always the active guard. We deliberately do NOT gate on the
 * `agent_settled` event (F133/F134/F139): the artifact we assert on is readable on disk long
 * before the turn settles, so the completion condition is wall clock, never settlement.
 */
const ARTIFACT_TIMEOUT_MS = 300_000;
/**
 * How long, once the artifact has landed, we hold the event stream open before closing stdin —
 * a plain bounded sleep that purely widens the `extension_error` net (decision 4). It is NOT a
 * settle wait and no assertion depends on it: assertion (E) covers only the stream up to close.
 */
const DRAIN_AFTER_ARTIFACT_MS = 10_000;
/** Grace period for a *clean* (stdin-closed) exit after the run has resolved on its on-disk artifact. */
const EXIT_WAIT_MS = 30_000;
/** How often the readiness gate re-issues `get_commands` until it confirms the extension. */
const GATE_POLL_MS = 2_000;

/**
 * The pre-seed ramp: one `parentId` chain, four user/assistant pairs, each assistant turn's
 * `usage.input` rising so the LAST (largest, 35000) sits well above a fresh-session input
 * floor. A flat or tiny seed could not prove "the input dropped to the floor".
 */
const SEED_ID = "aaaa1111aaaa";
const SEED_INPUTS = [20_000, 22_000, 27_000, 35_000];
const SEED_FILE = `${SEED_ID}.jsonl`;

interface ParsedAssistant {
  usage?: { input?: number; output?: number; totalTokens?: number };
  stopReason?: string;
}

/**
 * Parse a persisted v3 session JSONL into the two things this test asserts on: the `session`
 * header (first line) and the FIRST assistant `message` entry. Returns the raw `usage` of that
 * first assistant turn; `null` if the file has no assistant message (the failure case we guard
 * against — a restart that produced no assistant turn cannot demonstrate "the input dropped").
 */
function readSessionFile(file: string): {
  header: { type?: string; id?: string; parentSession?: string };
  firstAssistant: ParsedAssistant | null;
} {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
  let firstAssistant: ParsedAssistant | null = null;
  for (const line of lines) {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; usage?: ParsedAssistant["usage"]; stopReason?: string };
    };
    if (entry.type === "message" && entry.message?.role === "assistant") {
      firstAssistant = { usage: entry.message.usage, stopReason: entry.message.stopReason };
      break;
    }
  }
  return { header, firstAssistant };
}

/** The largest assistant `usage.input` recorded in a session file (the seed's "ceiling"). */
function maxAssistantInput(file: string): number {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  let max = 0;
  for (const line of lines) {
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { input?: number } } };
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const inp = entry.message.usage?.input;
      if (typeof inp === "number" && inp > max) max = inp;
    }
  }
  return max;
}

/**
 * True iff `sessionDir` holds a session file other than the seed that parses and contains at
 * least one assistant `message` whose `usage.input` is a number — i.e. the restart's on-disk
 * artifact has landed (F133). Parsed line-by-line, so a single malformed or half-flushed line
 * can never throw out of the poll. The predicate is deliberately as strong as the assertion (C)
 * it gates: it returns true only once an assistant turn with a real numeric usage.input is
 * present, so the poll can never succeed on a partially-flushed entry.
 */
function sessionDirHasAssistantArtifact(sessionDir: string): boolean {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl") && f !== SEED_FILE);
  } catch {
    return false;
  }
  for (const f of files) {
    const file = join(sessionDir, f);
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue; // not readable yet — treat as not landed
    }
    for (const line of lines) {
      if (line.length === 0) continue;
      let entry: { type?: string; message?: { role?: string; usage?: { input?: number } } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        entry?.type === "message" &&
        entry?.message?.role === "assistant" &&
        typeof entry?.message?.usage?.input === "number"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Write the v3 seed (a single valid `parentId` chain) into `sessionDir` as `<seedId>.jsonl`.
 * Mirrors the brief's reference seed exactly: header → model_change → 4 user/assistant pairs.
 */
function writeSeed(sessionDir: string): string {
  const ts = "2026-08-27T00:00:00.000Z";
  const lines: string[] = [];
  lines.push(
    JSON.stringify({ type: "session", version: 3, id: SEED_ID, timestamp: ts, cwd: REPO_ROOT })
  );
  let parent: string | null = null;
  const mc = "aaaa2222aaaa";
  lines.push(
    JSON.stringify({
      type: "model_change",
      id: mc,
      parentId: null,
      timestamp: ts,
      provider: "llm-1",
      // The seed names a model explicitly, so the resumed session is not at the mercy of whatever
      // `defaultModel` the machine happens to hold. It must be a row the box actually ANSWERS on:
      // this pin flipped to Qwen3.8-Flash-Next on 2026-08-28 because the 27b endpoint went silent
      // (F131), and flipped back when the same control prompt answered in ~1s (F139, D-H87 —
      // user instruction). If this row goes dead again the run fails as `restart artifact never
      // landed: no new session file with a numeric assistant usage.input within the watchdog
      // window` — a model problem, not a restart defect; check the control probe before
      // touching the restart code.
      modelId: "qwen3.8-27b",
    })
  );
  parent = mc;
  SEED_INPUTS.forEach((inp, i) => {
    const uid = "aaaa" + (3000 + i).toString(16).padStart(8, "0");
    lines.push(
      JSON.stringify({
        type: "message",
        id: uid,
        parentId: parent,
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text: `turn ${i} user` }] },
      })
    );
    parent = uid;
    const aid = "bbbb" + (3000 + i).toString(16).padStart(8, "0");
    lines.push(
      JSON.stringify({
        type: "message",
        id: aid,
        parentId: parent,
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `turn ${i} assistant` }],
          usage: {
            input: inp,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: inp + 50,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        },
      })
    );
    parent = aid;
  });
  const seedPath = join(sessionDir, SEED_FILE);
  writeFileSync(seedPath, `${lines.join("\n")}\n`, "utf8");
  return seedPath;
}

/**
 * Drive one live restart: spawn `pi`, confirm the extension is loaded (via `get_commands`),
 * send the whole-message `/pi-renew <reason>` prompt, and resolve once the restart's on-disk
 * artifact (a new session file carrying a numeric assistant usage.input) has landed, holding
 * the stream open a further 10 s to widen the extension_error net — or reject on the hard
 * watchdog. Returns the collected event stream plus the still-live child so the caller can
 * close stdin and assert on the exit code.
 */
function driveRestart(
  sessionDir: string,
  seedPath: string,
  onChild: (child: ChildProcess) => void
): Promise<{ events: any[]; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--session-dir", sessionDir,
      "--session", seedPath,
      "--mode", "rpc",
      "-nc",
      "-e", EXTENSION_PATH, // F125: explicit -e loads the extension; deliberately NO -ne
    ];
    const child = spawn("pi", args, { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    onChild(child);

    const events: any[] = [];
    let promptSent = false;
    let sawRenewCommand = false;
    let finished = false;
    let artifactLanded = false;
    let artifactPoll: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      clearInterval(gate);
      clearInterval(artifactPoll);
      clearTimeout(drainTimer);
      if (ok) resolve({ events, child });
      else
        reject(
          new Error(
            sawRenewCommand
              ? "restart artifact never landed: no new session file with a numeric assistant usage.input " +
                "within the watchdog window (the on-disk restart artifact F133 makes ~4 s readable)"
              : "extension did not load: `pi-renew` was never listed by get_commands " +
                "(points at F125 — the -e/-ne mechanic); refusing to proceed"
          )
        );
    };

    // Hard watchdog (decision 3): if the on-disk restart artifact never lands within
    // ARTIFACT_TIMEOUT_MS, fail. Bounded by wall clock — never by a settle event (F133/F134/F139).
    const watchdog = setTimeout(() => finish(false), ARTIFACT_TIMEOUT_MS);

    // Readiness gate: the RPC stream emits no `{"type":"session"}` event in 0.84.x, so we
    // gate on a model-free `get_commands` round-trip and require it to list `pi-renew`
    // before we are allowed to send the restart prompt (see the file-header note).
    let gateCount = 0;
    const gate = setInterval(() => {
      if (promptSent || !child.stdin.writable) return;
      gateCount += 1;
      child.stdin.write(`${JSON.stringify({ id: `gate-${gateCount}`, type: "get_commands" })}\n`);
    }, GATE_POLL_MS);
    // First poll shortly after spawn (the stdin reader attaches during session bootstrap).
    setTimeout(() => {
      if (!promptSent && child.stdin.writable) {
        gateCount += 1;
        child.stdin.write(`${JSON.stringify({ id: `gate-${gateCount}`, type: "get_commands" })}\n`);
      }
    }, 500);

    // Artifact poll (decision 2/3/4): once the prompt is sent, check the session dir every 2 s
    // for the on-disk restart artifact — a new session file that parses and carries a numeric
    // assistant usage.input (F133: readable ~4 s after the prompt). When it lands we stop
    // polling and, per decision 4, hold the stream open a further 10 s (a plain bounded sleep)
    // purely to widen the extension_error net before returning. This is NOT a settle wait and no
    // assertion depends on the 10 s; assertion (E) covers only the stream up to close.
    const startArtifactPoll = () => {
      const tick = () => {
        if (!artifactLanded && sessionDirHasAssistantArtifact(sessionDir)) {
          artifactLanded = true;
          clearInterval(artifactPoll);
          drainTimer = setTimeout(() => finish(true), DRAIN_AFTER_ARTIFACT_MS);
        }
      };
      artifactPoll = setInterval(tick, 2_000);
      tick(); // check immediately, then every 2 s
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

        // Readiness gate fires on a successful get_commands that lists our extension command.
        if (
          !promptSent &&
          event?.type === "response" &&
          event?.command === "get_commands" &&
          event?.success === true &&
          Array.isArray(event?.data?.commands) &&
          event.data.commands.some((c: any) => c?.name === "pi-renew")
        ) {
          sawRenewCommand = true;
          clearInterval(gate);
          // The ENTIRE message is the command (F126 / decision 2): no leading prose, or `pi`
          // answers it as chat instead of dispatching. Any reason string works; use a marker.
          child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "/pi-renew e2e-restart" })}\n`);
          promptSent = true;
          // The prompt is sent: begin polling for the on-disk restart artifact (decision 2).
          startArtifactPoll();
        }
        // NOTE: we deliberately do NOT branch on the `agent_settled` event here (F133/F134/F139).
        // Under a loaded tool surface the new session's first turn is a full agent run whose settle
        // is extreme and non-deterministic (13 s / 245 s / >300 s on the same pin); the artifact we
        // assert on is readable on disk long before it settles, so the completion condition is the
        // artifact poll above, bounded by wall clock — never a settle. `agent_settled` appears in
        // this file only in this comment: nothing below branches control flow on it.
      }
    });

    child.on("error", (err) => {
      // e.g. `pi` not on PATH — a spawn error means the run never happened; fail the test.
      reject(new Error(`failed to spawn pi: ${err.message}`));
    });
    // If the child exits before the run has resolved (a crash or kill), fail now rather than
    // waiting out the whole watchdog window. Once we've resolved (finish(true)), a later exit is
    // expected — we close stdin on purpose in closeAndWaitExit — and is ignored.
    child.on("exit", () => {
      if (!finished) finish(false);
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
      stdin.end(); // a clean stdin-close makes the rpc-mode host shut down with code 0
    } else {
      // stdin is already unavailable (the child died before we got here) — report the exit
      // state it already has, so a crash is not mistaken for a clean exit.
      finish(child.exitCode, child.signalCode);
    }
  });
}

describe("task 3.8 — live end-to-end `new-session` restart (`pi --mode rpc`, extension via -e, no -ne)", () => {
  let sessionDir = "";
  let seedPath = "";
  let child: ChildProcess | null = null;

  // Cleanup on EVERY exit path: a live `pi` must never be left held by the suite, and the
  // temp session dir must be removed. Runs on pass, on fail, and if the watchdog fired.
  afterAll(() => {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (sessionDir) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 360_000);

  it(
    "restart lands: a second session file, parentSession=seed, first turn at the input floor, clean exit, no extension_error",
    async () => {
      // 1. Fresh temp --session-dir (isolated from any real session store on this machine).
      sessionDir = mkdtempSync(join(tmpdir(), "pi-renew-e2e-"));
      // 2. Write the ramped v3 seed; record the seed's ceiling before anything runs.
      seedPath = writeSeed(sessionDir);

      // 3–5. Spawn, gate on the extension being present, send the prompt, then wait for the
      //      restart's on-disk artifact (see the file-header note on the artifact gate).
      const { events, child: liveChild } = await driveRestart(sessionDir, seedPath, (c) => {
        child = c;
      });

      // 6. Assertions read the persisted session file(s) in the temp --session-dir — not the
      //    model's reply to the delivered payload (F127).
      const allFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      const newFiles = allFiles.filter((f) => f !== SEED_FILE);

      // (A) A second session file was created by the restart — EXACTLY one, beyond the seed.
      //     (This is the non-vacuity anchor: if the restart did not happen, this array is empty.)
      expect(
        newFiles,
        `expected exactly one new session file beyond the seed in ${sessionDir}; found ${JSON.stringify(newFiles)}`
      ).toHaveLength(1);

      const newFile = join(sessionDir, newFiles[0]);
      const { header, firstAssistant } = readSessionFile(newFile);

      // (B) The new session's header records the seed as its parent — the lineage link D3
      //     (and the spec's "Restart strategies" requirement) demands be passed explicitly.
      expect(header.parentSession, "new session's parentSession must equal the seed's absolute path").toBe(
        seedPath
      );

      // (C) The new session's FIRST assistant turn's usage.input dropped to the baseline floor:
      //     strictly below the seed's largest assistant usage.input, and > 0.
      const seedMax = maxAssistantInput(seedPath);
      expect(
        typeof firstAssistant?.usage?.input,
        "the new session must contain at least one assistant turn carrying a numeric usage.input"
      ).toBe("number");
      expect(firstAssistant!.usage!.input, "first assistant turn's usage.input must be > 0").toBeGreaterThan(0);
      expect(
        firstAssistant!.usage!.input,
        `first assistant turn's usage.input (${firstAssistant!.usage!.input}) must be strictly below the seed's largest (${seedMax})`
      ).toBeLessThan(seedMax);

      // (E) No `extension_error` appears anywhere in the captured stream — a failed restart
      //     (a throwing newSession, a cancelled switch, a dropped send) surfaces one by design.
      const extensionErrors = events.filter((e) => e?.type === "extension_error");
      expect(
        extensionErrors,
        "no extension_error may appear in the stream for a restart that landed cleanly"
      ).toHaveLength(0);

      // 7. Close stdin and wait for the child to exit; assert a clean exit (code 0, not a
      //    signal). A hung spawn is what the watchdog above already turned into a failure.
      const exit = await closeAndWaitExit(liveChild);
      expect(exit.code, `expected a clean exit (code 0); got code=${exit.code} signal=${exit.signal}`).toBe(0);
      expect(exit.signal, "a clean stdin-close exit must not be a signal").toBeNull();
    },
    360_000
  );
});
