import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import {
  readRestartInflight,
  beginRestart,
  checkRestartInFlight,
} from "../restart-inflight";

/**
 * §2.1 + §2.2 of the restart guard, driven through the same mocked `pi`/`ctx` idiom the
 * rest of this package's suite uses (see `test/renew-command.test.ts`,
 * `test/restart-strategy.test.ts`): the tool's dispatch and the `session_start`
 * handshake each run in a separate extension instance, so neither actually calls the
 * other — each half is driven directly against a real `mkdtemp` cwd.
 *
 * The load-bearing D1 assertion (§2.1): with an in-flight record seeded, a repeat
 * `new-session` request returns the stand-down result and the send spy is NOT called;
 * with no in-flight record the sender IS called exactly once. The D3 handshake
 * (§2.2): the replacement's `session_start` adopts the predecessor's in-flight record and
 * marks it delivered, after which a later, distinct restart in the replacement is not
 * blocked by the now-delivered record.
 */
function makeMockPi(commands: any[] = []): any {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getCommands: vi.fn().mockReturnValue(commands),
  };
}

function getRenewSessionTool(mockPi: any) {
  return mockPi.registerTool.mock.calls[0][0];
}

function getSessionStartHandler(mockPi: any) {
  return mockPi.on.mock.calls.find((c: any) => c[0] === "session_start")?.[1];
}

/**
 * A tool `ctx` that carries the `cwd` + `sessionManager.getSessionId` the new-session
 * guard consults, plus the fields the (skipped-on-this-path) dispatch already reads.
 */
function makeMockToolCtx(cwd: string, sessionId: string) {
  return {
    mode: "tui" as const,
    compact: vi.fn(),
    cwd,
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: () => sessionId,
    },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    ui: { notify: vi.fn() },
  };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "restart-guard-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("§2.1 idempotent stand-down guard at the tool dispatch", () => {
  it("with an in-flight record seeded, a second new-session request stands down and does NOT send (the load-bearing D1 assertion)", async () => {
    const sessionId = "guard-session";
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);

    // Seed the in-flight record for this session's parent key, as a first (now-in-flight)
    // restart would have done.
    beginRestart(cwd, sessionId, "the first restart reason", 1);
    expect(checkRestartInFlight(cwd, sessionId).blocked).toBe(true);

    const result: any = await tool.execute(
      "call-1",
      { reason: "repeat the restart", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeMockToolCtx(cwd, sessionId)
    );

    // The send spy was NOT called — no second send is issued.
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    // ...and the tool returned the distinct stand-down result naming the in-flight restart.
    expect(typeof result?.content?.[0]?.text).toBe("string");
    const text = result.content[0].text as string;
    expect(text).toContain("A restart is already in progress");
    expect(text).toContain("Stand down");
    expect(text).toContain("restartId 1");
  });

  it("with no in-flight record, the first new-session request sends exactly once and proceeds", async () => {
    const sessionId = "guard-session-2";
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);

    // Nothing seeded — the guard sees no in-flight record for this parent.
    expect(checkRestartInFlight(cwd, sessionId).blocked).toBe(false);

    await tool.execute(
      "call-1",
      { reason: "first restart", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeMockToolCtx(cwd, sessionId)
    );

    // Exactly one command-channel send (the /pi-renew restart command).
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage.mock.calls[0][0]).toBe("/pi-renew -- first restart");
  });

  // §3.2: the blocked-repeat tool result carries details.status === "stand-down"
  // and details.restartId = the in-flight record's id.
  it("a blocked repeat returns details.status === 'stand-down' with the record's restartId (3.2 stand-down token)", async () => {
    const sessionId = "guard-standdown-token";
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);

    beginRestart(cwd, sessionId, "original restart", 5);
    expect(checkRestartInFlight(cwd, sessionId).blocked).toBe(true);

    const result: any = await tool.execute(
      "call-1",
      { reason: "repeat", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeMockToolCtx(cwd, sessionId)
    );

    expect(result.details.status).toBe("stand-down");
    expect(result.details.restartId).toBe(5);
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  // §3.2: a fresh new-session dispatch carries details.status === "pending".
  it("a fresh new-session dispatch returns details.status === 'pending' (3.2 pending token)", async () => {
    const sessionId = "guard-pending-token";
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);

    expect(checkRestartInFlight(cwd, sessionId).blocked).toBe(false);

    const result: any = await tool.execute(
      "call-1",
      { reason: "fresh dispatch", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeMockToolCtx(cwd, sessionId)
    );

    expect(result.details.status).toBe("pending");
    expect(result.details.restartId).toBeUndefined();
    // The send still happened (one dispatch):
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe("§2.2 the delivered handshake in the replacement's session_start", () => {
  it("a replacement adopting a predecessor's in-flight record marks it delivered, and a later restart in the replacement is not blocked", async () => {
    const predecessorId = "predecessor";
    const replacementId = "replacement";

    // The predecessor went in-flight (as its command handler's beginRestart would have).
    beginRestart(cwd, predecessorId, "predecessor restart reason", 1);
    expect(readRestartInflight(cwd, predecessorId)?.state).toBe("in-flight");

    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const handler = getSessionStartHandler(mockPi);
    expect(typeof handler).toBe("function");

    // The replacement begins: its previousSessionFile names the predecessor.
    const previousSessionFile = `/sessions/2026-08-24T00-00-00-000Z_${predecessorId}.jsonl`;
    await handler(
      { type: "session_start", reason: "new", previousSessionFile },
      { cwd, sessionManager: { getSessionId: () => replacementId }, ui: { notify: vi.fn() } }
    );

    // The record moved from the predecessor's key to the replacement's key ...
    expect(readRestartInflight(cwd, predecessorId)).toBeNull();
    // ...and was marked delivered (the arrival proof / D3 handshake).
    expect(readRestartInflight(cwd, replacementId)?.state).toBe("delivered");

    // A later, distinct restart in the replacement is NOT blocked by the delivered record.
    expect(checkRestartInFlight(cwd, replacementId).blocked).toBe(false);
    beginRestart(cwd, replacementId, "a later restart", 2);
    const fresh = readRestartInflight(cwd, replacementId);
    expect(fresh?.state).toBe("in-flight");
    expect(fresh?.restartId).toBe(2);
  });

  it("a missing predecessor file is a no-op: the handshake does not throw and leaves no delivered record", async () => {
    const replacementId = "replacement-nop";
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const handler = getSessionStartHandler(mockPi);

    // No in-flight record was ever written for the (absent) predecessor.
    const previousSessionFile = `/sessions/2026-08-24T00-00-00-000Z_ghost-predecessor.jsonl`;
    await expect(
      handler(
        { type: "session_start", reason: "new", previousSessionFile },
        { cwd, sessionManager: { getSessionId: () => replacementId }, ui: { notify: vi.fn() } }
      )
    ).resolves.toBeUndefined();

    expect(readRestartInflight(cwd, replacementId)).toBeNull();
  });
});
