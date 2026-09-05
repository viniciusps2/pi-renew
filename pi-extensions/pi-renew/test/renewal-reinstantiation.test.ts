import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import { getRenewalStatePath, readRenewalState } from "../renewal-state";

/**
 * Task 2.5, storage half. The property under test: no in-memory value
 * crosses a session replacement. Two genuinely separate extension instances
 * (mockPiA, mockPiB) stand in for "the factory ran again after the
 * extension was torn down" — nothing is shared between them except the
 * real filesystem under `cwd`.
 */
function getSetRenewalContextTool(mockPi: any) {
  const call = mockPi.registerTool.mock.calls.find(
    (c: any) => c[0].name === "set_renewal_context"
  );
  return call?.[0];
}

function getSessionStartHandler(mockPi: any) {
  const call = mockPi.on.mock.calls.find((c: any) => c[0] === "session_start");
  return call?.[1];
}

function makeMockPi(commands: any[] = []): any {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getCommands: vi.fn().mockReturnValue(commands),
  };
}

function writeRawFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Mirrors `makeSessionFile` in test/renewal-state.test.ts. */
function makeSessionFile(
  dir: string,
  timestamp: string,
  id: string,
  parentSession?: string
): string {
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

describe("renewal context survives re-instantiation across a session replacement (task 2.5, storage half)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "renewal-reinstantiation-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("adopts the predecessor's record by rename: a cold instance B reads it after session_start, and session-A's record is gone", async () => {
    // Step 1: instance A registers a context under session-A.
    const mockPiA = makeMockPi();
    extensionFactory(mockPiA);
    await getSetRenewalContextTool(mockPiA).execute(
      "call-1",
      { context: "carried across a restart" },
      undefined,
      undefined,
      { cwd, sessionManager: { getSessionId: () => "session-A" } }
    );

    // Step 2: a separate, cold instance B.
    const mockPiB = makeMockPi();
    extensionFactory(mockPiB);

    // The teeth of "no in-memory value crosses the boundary": instance B has done
    // nothing yet, so session-B's record must not exist before its own
    // session_start handler runs — the value can only appear via on-disk adoption.
    expect(readRenewalState(cwd, "session-B")).toBeNull();

    // Step 3: a real session file for session-A, then session_start for session-B.
    const previousFile = makeSessionFile(
      join(cwd, "sessions"),
      "2026-08-08T18-58-40-399Z",
      "session-A"
    );
    const notify = vi.fn();
    const handler = getSessionStartHandler(mockPiB);
    await handler(
      { type: "session_start", reason: "new", previousSessionFile: previousFile },
      { cwd, sessionManager: { getSessionId: () => "session-B" }, ui: { notify } }
    );

    const state = readRenewalState(cwd, "session-B");
    expect(state).not.toBeNull();
    expect(state!.context).toBe("carried across a restart");
    expect(existsSync(getRenewalStatePath(cwd, "session-A"))).toBe(false);
  });

  it("finds the record through a live parentSession walk, not a dead one (F16 regression guard)", async () => {
    const mockPiA = makeMockPi();
    extensionFactory(mockPiA);
    await getSetRenewalContextTool(mockPiA).execute(
      "call-1",
      { context: "found via the parent chain" },
      undefined,
      undefined,
      { cwd, sessionManager: { getSessionId: () => "session-A" } }
    );

    const mockPiB = makeMockPi();
    extensionFactory(mockPiB);
    const handler = getSessionStartHandler(mockPiB);

    // A -> B -> C: C's header names B as parent, B's header names A as parent.
    // The record lives only under session-A, so resolving it for session-D
    // (whose previousSessionFile is C) requires walking two hops.
    const sessionDir = join(cwd, "sessions");
    const fileA = makeSessionFile(sessionDir, "2026-08-08T18-00-00-001Z", "session-A");
    const fileB = makeSessionFile(sessionDir, "2026-08-08T18-00-00-002Z", "session-B", fileA);
    const fileC = makeSessionFile(sessionDir, "2026-08-08T18-00-00-003Z", "session-C", fileB);

    const notify = vi.fn();
    await handler(
      { type: "session_start", reason: "new", previousSessionFile: fileC },
      { cwd, sessionManager: { getSessionId: () => "session-D" }, ui: { notify } }
    );

    const state = readRenewalState(cwd, "session-D");
    expect(state).not.toBeNull();
    expect(state!.context).toBe("found via the parent chain");
  });

  it("does not throw and reports a warning naming the file when the on-disk record is corrupt", async () => {
    const mockPiB = makeMockPi();
    extensionFactory(mockPiB);
    const handler = getSessionStartHandler(mockPiB);

    const corruptPath = getRenewalStatePath(cwd, "session-B");
    writeRawFile(corruptPath, "{not json");

    const notify = vi.fn();
    await expect(
      handler(
        { type: "session_start", reason: "startup" },
        { cwd, sessionManager: { getSessionId: () => "session-B" }, ui: { notify } }
      )
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith(expect.stringContaining(corruptPath), "warning");
  });

  it("sends nothing: sendUserMessage and sendMessage are never called by the session_start handler", async () => {
    const mockPiA = makeMockPi();
    extensionFactory(mockPiA);
    await getSetRenewalContextTool(mockPiA).execute(
      "call-1",
      { context: "no injection expected" },
      undefined,
      undefined,
      { cwd, sessionManager: { getSessionId: () => "session-A" } }
    );

    const mockPiB = makeMockPi();
    extensionFactory(mockPiB);
    const handler = getSessionStartHandler(mockPiB);

    const previousFile = makeSessionFile(
      join(cwd, "sessions"),
      "2026-08-08T18-58-40-399Z",
      "session-A"
    );
    await handler(
      { type: "session_start", reason: "new", previousSessionFile: previousFile },
      { cwd, sessionManager: { getSessionId: () => "session-B" }, ui: { notify: vi.fn() } }
    );

    expect(mockPiB.sendUserMessage).not.toHaveBeenCalled();
    expect(mockPiB.sendMessage).not.toHaveBeenCalled();
  });
});
