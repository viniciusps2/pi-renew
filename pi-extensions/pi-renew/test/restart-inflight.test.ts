import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESTART_INFLIGHT_VERSION,
  RESTART_INFLIGHT_MAX_AGE_MS,
  type RestartInflight,
  getRestartInflightPath,
  getRestartInflightDir,
  writeRestartInflight,
  readRestartInflight,
  markRestartInflightDelivered,
  adoptRestartInflight,
  reapRestartInflight,
  beginRestart,
  checkRestartInFlight,
  wasHandoffDelivered,
} from "../restart-inflight";

/**
 * §1 (task 1.1, 1.2) — the persisted in-flight restart record and its read/write/clear
 * helpers, driven against a real `mkdtemp` directory (the helpers take `cwd`, so no live
 * `pi` is needed). This is the pure/mocked-fs half of the restart guard; the two
 * integration tests that drive it through the `pi`/`ctx` mock live in
 * `test/restart-guard.test.ts`.
 *
 * D-IN4 contract under test: `readRestartInflight` returns `null` — never throws — for a
 * missing, empty, corrupt-JSON, or unknown-`version` file, and (D-IN5) for a record whose
 * `at` has aged past RESTART_INFLIGHT_MAX_AGE_MS.
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "restart-inflight-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function freshRecord(over: Partial<RestartInflight> = {}): RestartInflight {
  return {
    version: RESTART_INFLIGHT_VERSION,
    restartId: 1,
    parentSessionId: "parent-a",
    reason: "context usage too high",
    at: new Date().toISOString(),
    state: "in-flight",
    ...over,
  };
}

describe("readRestartInflight / writeRestartInflight round-trip (task 1.1)", () => {
  it("write→read round-trip returns the same record", () => {
    const rec = freshRecord({ restartId: 7, reason: "round-trip reason" });
    writeRestartInflight(cwd, "parent-a", rec);
    expect(readRestartInflight(cwd, "parent-a")).toEqual(rec);
  });

  it("missing file reads as null (no throw)", () => {
    expect(readRestartInflight(cwd, "never-written")).toBeNull();
  });

  it("an empty file reads as null (no throw)", () => {
    const path = getRestartInflightPath(cwd, "parent-empty");
    mkdirSync(getRestartInflightDir(cwd), { recursive: true });
    writeFileSync(path, "", "utf-8");
    expect(() => readRestartInflight(cwd, "parent-empty")).not.toThrow();
    expect(readRestartInflight(cwd, "parent-empty")).toBeNull();
  });

  it("a corrupt-JSON file reads as null and no exception escapes", () => {
    const path = getRestartInflightPath(cwd, "parent-corrupt");
    mkdirSync(getRestartInflightDir(cwd), { recursive: true });
    // Feed a deliberately non-JSON string — the assertion is that it is parsed, found not
    // to be JSON, and the read degrades to null instead of throwing.
    writeFileSync(path, "this is { not json at all", "utf-8");
    expect(() => readRestartInflight(cwd, "parent-corrupt")).not.toThrow();
    expect(readRestartInflight(cwd, "parent-corrupt")).toBeNull();
  });

  it("an unknown `version` reads as null and no exception escapes", () => {
    const path = getRestartInflightPath(cwd, "parent-wrongver");
    mkdirSync(getRestartInflightDir(cwd), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 99, restartId: 1, parentSessionId: "parent-wrongver", reason: "r", at: new Date().toISOString(), state: "in-flight" }) + "\n",
      "utf-8"
    );
    expect(() => readRestartInflight(cwd, "parent-wrongver")).not.toThrow();
    expect(readRestartInflight(cwd, "parent-wrongver")).toBeNull();
  });

  it("a second writeRestartInflight overwrites the first", () => {
    const first = freshRecord({ restartId: 1, reason: "first" });
    const second = freshRecord({ restartId: 2, reason: "second", state: "delivered" });
    writeRestartInflight(cwd, "parent-overwrite", first);
    writeRestartInflight(cwd, "parent-overwrite", second);
    expect(readRestartInflight(cwd, "parent-overwrite")).toEqual(second);
  });
});

describe("markRestartInflightDelivered (task 1.1 clear / 2.2 flip)", () => {
  it("flips a record from in-flight to delivered", () => {
    writeRestartInflight(cwd, "parent-deliver", freshRecord({ state: "in-flight" }));
    markRestartInflightDelivered(cwd, "parent-deliver");
    expect(readRestartInflight(cwd, "parent-deliver")!.state).toBe("delivered");
  });

  it("on an unknown id is a no-op (no throw)", () => {
    expect(() => markRestartInflightDelivered(cwd, "no-such-session")).not.toThrow();
    expect(readRestartInflight(cwd, "no-such-session")).toBeNull();
  });
});

describe("adoptRestartInflight (task 1.1 integration: bridges the replacement)", () => {
  it("renames predecessor→new and the new id reads back the same record", () => {
    const rec = freshRecord({ parentSessionId: "predecessor", reason: "predecessor reason" });
    writeRestartInflight(cwd, "predecessor", rec);
    const renamed = adoptRestartInflight(cwd, "predecessor", "replacement");
    expect(renamed).toBe(true);
    // The predecessor's key is gone; the new key holds the same record.
    expect(readRestartInflight(cwd, "predecessor")).toBeNull();
    expect(readRestartInflight(cwd, "replacement")).toEqual(rec);
  });

  it("returns false and does not touch the dest when the predecessor has no record", () => {
    const renamed = adoptRestartInflight(cwd, "ghost", "replacement");
    expect(renamed).toBe(false);
    expect(readRestartInflight(cwd, "replacement")).toBeNull();
  });
});

describe("expiry (task 1.2 / D-IN5): an old record is absent, a fresh one is not", () => {
  it("a record aged past RESTART_INFLIGHT_MAX_AGE_MS reads as absent (neither blocks nor delivers)", () => {
    const agedAt = new Date(Date.now() - (RESTART_INFLIGHT_MAX_AGE_MS + 1000)).toISOString();
    writeRestartInflight(cwd, "parent-aged", freshRecord({ at: agedAt, state: "in-flight" }));

    expect(readRestartInflight(cwd, "parent-aged")).toBeNull();
    // ...and therefore neither blocks a new restart nor counts as delivered:
    expect(checkRestartInFlight(cwd, "parent-aged")).toEqual({ blocked: false, record: null });
  });

  it("a fresh record does not expire", () => {
    writeRestartInflight(cwd, "parent-fresh", freshRecord({ state: "in-flight" }));
    expect(readRestartInflight(cwd, "parent-fresh")?.state).toBe("in-flight");
    expect(checkRestartInFlight(cwd, "parent-fresh")).toEqual({ blocked: true, record: expect.anything() });
  });
});

describe("scoping (task 1.2): the key is the parent session id", () => {
  it("two different parents yield two independent records", () => {
    const a = freshRecord({ parentSessionId: "parent-a", restartId: 1 });
    const b = freshRecord({ parentSessionId: "parent-b", restartId: 2, reason: "b" });
    writeRestartInflight(cwd, "parent-a", a);
    writeRestartInflight(cwd, "parent-b", b);
    expect(readRestartInflight(cwd, "parent-a")).toEqual(a);
    expect(readRestartInflight(cwd, "parent-b")).toEqual(b);
    // Deleting one does not affect the other.
    writeRestartInflight(cwd, "parent-a", { ...a, state: "delivered" });
    expect(readRestartInflight(cwd, "parent-b")).toEqual(b);
  });
});

describe("beginRestart mints a live in-flight record (task 1.2)", () => {
  it("writes state in-flight with the ordinal as restartId and a fresh at", () => {
    beginRestart(cwd, "parent-mint", "context usage too high", 3);
    const rec = readRestartInflight(cwd, "parent-mint");
    expect(rec).not.toBeNull();
    expect(rec!.restartId).toBe(3);
    expect(rec!.parentSessionId).toBe("parent-mint");
    expect(rec!.state).toBe("in-flight");
    expect(checkRestartInFlight(cwd, "parent-mint")).toEqual({ blocked: true, record: expect.anything() });
  });
});

describe("reapRestartInflight (task 1.2 housekeeping): removes only stale files", () => {
  it("deletes stale restart-inflight-*.json, keeps fresh and non-matching files", () => {
    const dir = getRestartInflightDir(cwd);
    mkdirSync(dir, { recursive: true });

    const stale = join(dir, "restart-inflight-stale.json");
    const fresh = join(dir, "restart-inflight-fresh.json");
    const unrelated = join(dir, "renewal-unrelated.json");
    writeFileSync(stale, "{}\n", "utf-8");
    writeFileSync(fresh, "{}\n", "utf-8");
    writeFileSync(unrelated, "{}\n", "utf-8");

    // Age only the `stale` file by its mtime (the reap keys on mtime, not the `at` field).
    const old = new Date(Date.now() - (RESTART_INFLIGHT_MAX_AGE_MS + 1000));
    utimesSync(stale, old, old);

    expect(() => reapRestartInflight(cwd)).not.toThrow();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe("§3.3 wasHandoffDelivered: the observable 'handoff delivered?' predicate", () => {
  it("is false before anything is written (missing record)", () => {
    expect(wasHandoffDelivered(cwd, "never-written")).toBe(false);
  });

  it("is false while a record is in-flight (not yet delivered)", () => {
    beginRestart(cwd, "inflight-parent", "r", 1);
    expect(readRestartInflight(cwd, "inflight-parent")?.state).toBe("in-flight");
    expect(wasHandoffDelivered(cwd, "inflight-parent")).toBe(false);
  });

  it("is true after markRestartInflightDelivered flips the record", () => {
    beginRestart(cwd, "delivered-parent", "r", 1);
    expect(wasHandoffDelivered(cwd, "delivered-parent")).toBe(false);
    markRestartInflightDelivered(cwd, "delivered-parent");
    expect(readRestartInflight(cwd, "delivered-parent")?.state).toBe("delivered");
    expect(wasHandoffDelivered(cwd, "delivered-parent")).toBe(true);
  });

  it("is false for an unknown/never-written parent (even when another parent is delivered)", () => {
    beginRestart(cwd, "other-parent", "r", 1);
    markRestartInflightDelivered(cwd, "other-parent");
    expect(wasHandoffDelivered(cwd, "unknown-parent")).toBe(false);
  });
});
