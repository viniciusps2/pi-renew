import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  DELEGATE_STATE_VERSION,
  DELEGATE_STATE_MAX_AGE_MS,
  getDelegateStateDir,
  getDelegateStatePath,
  readDelegateState,
  writeDelegateState,
  sessionIdFromSessionFile,
  resolveDelegateState,
  reapDelegateStates,
  claimRestartOrdinal,
  type DelegateState,
} from "../delegate-state";

const OLD_MTIME = new Date("2026-01-01T00:00:00Z").getTime();

describe("delegate-state", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "delegate-state-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function stateFile(sessionId: string): string {
    return getDelegateStatePath(cwd, sessionId);
  }

  /**
   * Writes a fixture file, creating its directory first. Fixtures are written
   * behind the module's back (raw JSON, session headers), so nothing else has
   * created `.pi/loop/` or the session dir for them yet.
   */
  function writeRawFile(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    return path;
  }

  function makeSessionFile(dir: string, timestamp: string, id: string, parentSession?: string): string {
    const path = join(dir, `${timestamp}_${id}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: `${timestamp.replace(/-/g, "")}T00:00:00.000Z`,
      cwd: dir,
      ...(parentSession !== undefined ? { parentSession } : {}),
    });
    writeRawFile(path, header + "\n");
    return path;
  }

  function setMtime(path: string, timeMs: number): void {
    const t = new Date(timeMs);
    utimesSync(path, t, t);
  }

  function oldFile(name: string, content: string): string {
    const path = join(getDelegateStateDir(cwd), name);
    writeRawFile(path, content);
    setMtime(path, OLD_MTIME);
    return path;
  }

  describe("readDelegateState", () => {
    it("round-trips a record with the context byte-for-byte, whitespace and newlines included", () => {
      const id = "019fe2bd-d88f-7571-a595-6f5b930f66d8";
      const context = "  前置：keep leading tabs\tand trailing space \nline two\n  indented line  ";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context,
        includeSummary: true,
        includeNextSteps: false,
        restartCount: 3,
        registeredAt: "2026-08-08T18:58:40.399Z",
      });
      const state = readDelegateState(cwd, id);
      expect(state).not.toBeNull();
      expect(state!.context).toBe(context);
      expect(state!.includeSummary).toBe(true);
      expect(state!.includeNextSteps).toBe(false);
      expect(state!.restartCount).toBe(3);
      expect(state!.registeredAt).toBe("2026-08-08T18:58:40.399Z");
      expect(state!.version).toBe(DELEGATE_STATE_VERSION);
    });

    it("defaults absent toggles to true when reading a valid record", () => {
      const id = "019fe2be-1111-7571-a595-6f5b930f66d8";
      // Written raw: the toggle keys must be genuinely absent on disk, which a
      // full DelegateState passed to writeDelegateState can never produce.
      writeRawFile(
        stateFile(id),
        JSON.stringify(
          {
            version: DELEGATE_STATE_VERSION,
            context: "ctx",
            restartCount: 0,
            registeredAt: "2026-08-08T19:00:00.000Z",
          },
          null,
          2
        ) + "\n"
      );
      const state = readDelegateState(cwd, id);
      expect(state!).toMatchObject({ includeSummary: true, includeNextSteps: true });
    });

    it("keeps an explicitly stored false false", () => {
      const id = "019fe2bf-2222-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context: "ctx",
        includeSummary: false,
        includeNextSteps: false,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const state = readDelegateState(cwd, id);
      expect(state!.includeSummary).toBe(false);
      expect(state!.includeNextSteps).toBe(false);
    });

    it("throws, naming the file and both versions, for an unknown version", () => {
      const id = "019fe2c0-3333-7571-a595-6f5b930f66d8";
      const path = stateFile(id);
      writeRawFile(path, JSON.stringify({ version: 9, context: "ctx" }, null, 2) + "\n");
      expect(() => readDelegateState(cwd, id)).toThrow(path);
      expect(() => readDelegateState(cwd, id)).toThrow("9");
      expect(() => readDelegateState(cwd, id)).toThrow(String(DELEGATE_STATE_VERSION));
    });

    it("throws, naming the file and both versions, for a missing version", () => {
      const id = "019fe2c1-4444-7571-a595-6f5b930f66d8";
      const path = stateFile(id);
      writeRawFile(path, JSON.stringify({ context: "ctx" }, null, 2) + "\n");
      expect(() => readDelegateState(cwd, id)).toThrow(path);
      expect(() => readDelegateState(cwd, id)).toThrow("undefined");
      expect(() => readDelegateState(cwd, id)).toThrow(String(DELEGATE_STATE_VERSION));
    });

    it("throws, naming the file, for corrupt JSON", () => {
      const id = "019fe2c2-5555-7571-a595-6f5b930f66d8";
      const path = stateFile(id);
      writeRawFile(path, "{ not json at all");
      expect(() => readDelegateState(cwd, id)).toThrow(path);
    });

    it("returns null, not a throw, when no record exists", () => {
      const id = "019fe2c3-6666-7571-a595-6f5b930f66d8";
      expect(readDelegateState(cwd, id)).toBeNull();
    });

    it("keeps records of two distinct session ids fully independent", () => {
      const a = "019fe2c4-7777-7571-a595-6f5b930f66d8";
      const b = "019fe2c5-8888-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, a, {
        version: DELEGATE_STATE_VERSION,
        context: "context A",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      writeDelegateState(cwd, b, {
        version: DELEGATE_STATE_VERSION,
        context: "context B",
        includeSummary: false,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:01:00.000Z",
      });
      const before = readFileSync(stateFile(b), "utf-8");
      writeDelegateState(cwd, a, {
        version: DELEGATE_STATE_VERSION,
        context: "context A, rewritten",
        includeSummary: false,
        includeNextSteps: false,
        restartCount: 2,
        registeredAt: "2026-08-08T19:02:00.000Z",
      });
      expect(readFileSync(stateFile(b), "utf-8")).toBe(before);
      expect(readDelegateState(cwd, b)).toMatchObject({ context: "context B", includeSummary: false, restartCount: 0 });
    });
  });

  describe("writeDelegateState", () => {
    it("leaves no temp file behind after a successful write", () => {
      const id = "019fe2c6-9999-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context: "ctx",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const entries = readdirSync(getDelegateStateDir(cwd));
      expect(entries).toEqual([`delegate-${id}.json`]);
    });
  });

  describe("sessionIdFromSessionFile", () => {
    it("extracts the id from a realistic filename and returns nothing timestamp-shaped", () => {
      const id = "019fe2bd-d88f-7571-a595-6f5b930f66d8";
      const parsed = sessionIdFromSessionFile(
        "/abs/path/2026-08-08T18-58-40-399Z_019fe2bd-d88f-7571-a595-6f5b930f66d8.jsonl"
      );
      expect(parsed).toBe(id);
      expect(parsed).not.toContain("2026-08-08");
      expect(parsed).not.toContain("18-58-40");
    });
  });

  describe("resolveDelegateState", () => {
    it("returns the session's own record when one exists, with no previous file", () => {
      const id = "019fe2c7-aaaa-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context: "own",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const state = resolveDelegateState(cwd, id);
      expect(state).toMatchObject({ context: "own" });
    });

    it("adopts a predecessor's record given a previousSessionFile, by rename, not copy", () => {
      const predecessorId = "019fe2c8-bbbb-7571-a595-6f5b930f66d8";
      const currentId = "019fe2c9-cccc-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, predecessorId, {
        version: DELEGATE_STATE_VERSION,
        context: "carried over",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 1,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const previousFile = makeSessionFile(
        join(cwd, "sessions"),
        "2026-08-08T18-58-40-399Z",
        predecessorId
      );
      const state = resolveDelegateState(cwd, currentId, previousFile);
      expect(state).toMatchObject({ context: "carried over", restartCount: 1 });
      expect(existsSync(stateFile(currentId))).toBe(true);
      expect(existsSync(stateFile(predecessorId))).toBe(false);
    });

    it("finds a predecessor's record through a real two-deep parentSession chain", () => {
      const grandId = "019fe2ca-dddd-7571-a595-6f5b930f66d8";
      const parent = "019fe2cb-eeee-7571-a595-6f5b930f66d8";
      const child = "019fe2cc-ffff-7571-a595-6f5b930f66d8";
      const sessionDir = join(cwd, "sessions");
      const grandFile = makeSessionFile(sessionDir, "2026-08-08T18-00-00-001Z", grandId);
      const parentFile = makeSessionFile(sessionDir, "2026-08-08T18-00-00-002Z", parent, grandFile);
      makeSessionFile(sessionDir, "2026-08-08T18-00-00-003Z", child, parentFile);
      writeDelegateState(cwd, grandId, {
        version: DELEGATE_STATE_VERSION,
        context: "chain context",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const state = resolveDelegateState(cwd, child, parentFile);
      expect(state).toMatchObject({ context: "chain context" });
      expect(existsSync(stateFile(child))).toBe(true);
      expect(existsSync(stateFile(grandId))).toBe(false);
    });

    it("returns null when no record can be found", () => {
      const id = "019fe2cd-0000-7571-a595-6f5b930f66d8";
      expect(resolveDelegateState(cwd, id)).toBeNull();
    });

    it("does not overwrite an existing record under the current id when adopting", () => {
      const predecessorId = "019fe2ce-1111-7571-a595-6f5b930f66d8";
      const currentId = "019fe2cf-2222-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, predecessorId, {
        version: DELEGATE_STATE_VERSION,
        context: "predecessor",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      writeDelegateState(cwd, currentId, {
        version: DELEGATE_STATE_VERSION,
        context: "current wins",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 7,
        registeredAt: "2026-08-08T19:05:00.000Z",
      });
      const previousFile = makeSessionFile(
        join(cwd, "sessions"),
        "2026-08-08T18-58-40-399Z",
        predecessorId
      );
      const state = resolveDelegateState(cwd, currentId, previousFile);
      expect(state).toMatchObject({ context: "current wins", restartCount: 7 });
      expect(readDelegateState(cwd, predecessorId)).toMatchObject({ context: "predecessor" });
    });

    it("leaves restartCount untouched by the adoption itself", () => {
      const predecessorId = "019fe2d0-3333-7571-a595-6f5b930f66d8";
      const currentId = "019fe2d1-4444-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, predecessorId, {
        version: DELEGATE_STATE_VERSION,
        context: "ctx",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 4,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      const previousFile = makeSessionFile(
        join(cwd, "sessions"),
        "2026-08-08T18-58-40-399Z",
        predecessorId
      );
      const state = resolveDelegateState(cwd, currentId, previousFile);
      expect(state).toMatchObject({ restartCount: 4 });
      expect(readFileSync(stateFile(currentId), "utf-8")).toContain('"restartCount": 4');
    });

    it("stops a parentSession cycle without throwing or hanging", () => {
      const a = "019fe2d2-5555-7571-a595-6f5b930f66d8";
      const b = "019fe2d3-6666-7571-a595-6f5b930f66d8";
      const sessionDir = join(cwd, "sessions");
      const fileA = makeSessionFile(sessionDir, "2026-08-08T18-00-00-001Z", a);
      const fileB = makeSessionFile(sessionDir, "2026-08-08T18-00-00-002Z", b);
      // Close the cycle: each header names the other as its parent.
      writeFileSync(fileA, JSON.stringify({ type: "session", version: 3, id: a, timestamp: "t", cwd: sessionDir, parentSession: fileB }) + "\n", "utf-8");
      writeFileSync(fileB, JSON.stringify({ type: "session", version: 3, id: b, timestamp: "t", cwd: sessionDir, parentSession: fileA }) + "\n", "utf-8");
      const state = resolveDelegateState(cwd, a, fileB);
      expect(state).toBeNull();
    });

    it("stops a parentSession chain at the hop bound without throwing or hanging", () => {
      const sessionDir = join(cwd, "sessions");
      const n = 40;
      const ids: string[] = [];
      let prev: string | undefined;
      for (let i = 0; i < n; i++) {
        const id = `019fe2d4-aaaa${i.toString(16).padStart(2, "0")}-a595-6f5b930f66d8`;
        const file = makeSessionFile(sessionDir, `2026-08-08T18-${i.toString(16).padStart(2, "0")}-00-000Z`, id, prev);
        if (prev === undefined) {
          // Root header must name no parent; give the first hop a parent so the walk starts from there.
          writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: sessionDir, parentSession: file }) + "\n", "utf-8");
        }
        ids.push(id);
        prev = file;
      }
      const state = resolveDelegateState(cwd, "019fe2dd-9999-7571-a595-6f5b930f66d8", prev);
      expect(state).toBeNull();
    });
  });

  describe("reapDelegateStates", () => {
    it("deletes only stale delegate records, sparing the current session, fresh records and foreign files", () => {
      const currentId = "019fe2de-aaaa-7571-a595-6f5b930f66d8";
      const oldId = "019fe2df-bbbb-7571-a595-6f5b930f66d8";
      const freshId = "019fe2e0-cccc-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, currentId, {
        version: DELEGATE_STATE_VERSION,
        context: "current",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      setMtime(stateFile(currentId), OLD_MTIME); // old mtime, but it is the current session's own
      writeDelegateState(cwd, oldId, {
        version: DELEGATE_STATE_VERSION,
        context: "old",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      });
      setMtime(stateFile(oldId), OLD_MTIME);
      writeDelegateState(cwd, freshId, {
        version: DELEGATE_STATE_VERSION,
        context: "fresh",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-08T19:00:00.000Z",
      }); // recent mtime
      const handover = oldFile("handover.md", "# handover\n");
      const strayTmp = oldFile("delegate-old.json.tmp-4242-abcd1234", "partial");

      reapDelegateStates(cwd, currentId);

      expect(existsSync(stateFile(oldId))).toBe(false);
      expect(existsSync(stateFile(currentId))).toBe(true);
      expect(existsSync(stateFile(freshId))).toBe(true);
      expect(existsSync(handover)).toBe(true);
      expect(existsSync(strayTmp)).toBe(true);
    });

    it("does not throw when the state directory cannot be listed", () => {
      // `.pi/loop` exists but is a file, so readdir fails with ENOTDIR.
      // A sweep is housekeeping and must never take the session down.
      writeRawFile(join(cwd, ".pi", "loop"), "not a directory");
      expect(() =>
        reapDelegateStates(cwd, "019fe2e0-0000-7571-a595-6f5b930f66d8")
      ).not.toThrow();
    });
  });

  describe("DELEGATE_STATE_MAX_AGE_MS", () => {
    it("is exactly 14 days in milliseconds", () => {
      expect(DELEGATE_STATE_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    });
  });

  // O25: claimRestartOrdinal is the read-increment-persist sequence extracted from the
  // /pi-renew command handler (D-H51) so the compact restart path can share it rather
  // than duplicating the increment — two independent increments would let the two
  // strategies disagree about how many restarts have happened. Tested directly here,
  // against three consecutive calls rather than two, because two calls cannot distinguish
  // "returns the ordinal" from "returns the ordinal but persists the old value" — only a
  // third call, checked against the persisted value from the second, catches that.
  describe("claimRestartOrdinal", () => {
    it("returns 1, 2, 3 across three consecutive calls on one record, and the persisted record ends at 3", () => {
      const id = "019fe2e1-1111-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context: "/loop implement tasks.md",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-24T00:00:00.000Z",
      });

      const first = claimRestartOrdinal(cwd, id, "reason one");
      expect(first.ordinal).toBe(1);
      expect(readDelegateState(cwd, id)!.restartCount).toBe(1);

      const second = claimRestartOrdinal(cwd, id, "reason two");
      expect(second.ordinal).toBe(2);
      expect(readDelegateState(cwd, id)!.restartCount).toBe(2);

      const third = claimRestartOrdinal(cwd, id, "reason three");
      expect(third.ordinal).toBe(3);
      expect(readDelegateState(cwd, id)!.restartCount).toBe(3);
    });

    it("persists each call's reason as lastReason, and the third (distinct) reason is what survives", () => {
      const id = "019fe2e2-2222-7571-a595-6f5b930f66d8";
      writeDelegateState(cwd, id, {
        version: DELEGATE_STATE_VERSION,
        context: "/loop implement tasks.md",
        includeSummary: true,
        includeNextSteps: true,
        restartCount: 0,
        registeredAt: "2026-08-24T00:00:00.000Z",
      });

      claimRestartOrdinal(cwd, id, "reason one");
      claimRestartOrdinal(cwd, id, "reason two");
      claimRestartOrdinal(cwd, id, "reason three, the final and distinct one");

      expect(readDelegateState(cwd, id)!.lastReason).toBe(
        "reason three, the final and distinct one"
      );
    });

    it("with no record on disk, returns { ordinal: 1, record: null } and writes nothing", () => {
      const id = "019fe2e3-3333-7571-a595-6f5b930f66d8";

      const result = claimRestartOrdinal(cwd, id, "no record was ever registered");

      expect(result).toEqual({ ordinal: 1, record: null });
      expect(existsSync(getDelegateStatePath(cwd, id))).toBe(false);
    });

    it("throws, naming the file, for a corrupt record", () => {
      const id = "019fe2e4-4444-7571-a595-6f5b930f66d8";
      const path = stateFile(id);
      writeRawFile(path, "{not json");

      expect(() => claimRestartOrdinal(cwd, id, "irrelevant reason")).toThrow(path);
    });
  });
});
