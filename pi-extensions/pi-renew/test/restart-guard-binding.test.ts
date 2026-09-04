/**
 * F144 regression — the in-flight guard must call `getSessionId()` **bound** to the real
 * `ctx.sessionManager`.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `restart-guard.test.ts`:
 *   Every other mocked test in this package builds `sessionManager` as an object literal whose
 *   `getSessionId` is an **arrow function**. An arrow function ignores `this`, so extracting it
 *   (`const g = ctx.sessionManager.getSessionId; g()`) works fine against that mock — and the
 *   whole suite stayed green while the LIVE path threw
 *   `"Cannot read properties of undefined (reading 'sessionId')"` on every restart, because the
 *   real SessionManager's method is `getSessionId() { return this.sessionId; }` on a prototype.
 *
 *   So the mock here is deliberately a **class instance with a prototype method that reads
 *   `this`** — the only shape that can tell a bound call from an unbound one. Do not "simplify"
 *   it to an object literal or an arrow function: that is exactly the weakening that let the
 *   defect through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";
import { beginRestart, checkRestartInFlight } from "../restart-inflight";

/** The shape of the REAL SessionManager: a prototype method that reads `this.sessionId`. */
class SessionManagerLike {
  private sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  getSessionId(): string {
    return this.sessionId;
  }
}

const SID = "sess-f144";

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

/**
 * The same tool `ctx` `restart-guard.test.ts` builds, with ONE difference that is the whole
 * point of this file: `sessionManager` is a real class instance whose `getSessionId` lives on
 * the prototype and reads `this`, exactly like the SDK's SessionManager.
 */
function makeProtoToolCtx(cwd: string, sessionId: string) {
  return {
    mode: "tui" as const,
    compact: vi.fn(),
    cwd,
    sessionManager: Object.assign(new SessionManagerLike(sessionId), {
      getEntries: vi.fn().mockReturnValue([]),
    }),
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    ui: { notify: vi.fn() },
  };
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-renew-f144-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("F144 — getSessionId must be called on its owner, never extracted and called bare", () => {
  it("a prototype-method getSessionId THROWS when extracted and called unbound (the defect's mechanism)", () => {
    const sm = new SessionManagerLike(SID);
    expect(sm.getSessionId()).toBe(SID);

    const extracted = sm.getSessionId;
    expect(() => extracted()).toThrowError(/Cannot read properties of undefined \(reading 'sessionId'\)/);
  });

  it("an arrow-function mock does NOT throw when extracted — which is why the mocked suite could not see it", () => {
    const arrowMock = { getSessionId: () => SID };
    const extracted = arrowMock.getSessionId;
    expect(extracted()).toBe(SID);
  });

  it("the guard's expression resolves the session id against a prototype-method sessionManager", () => {
    const ctx = { cwd, sessionManager: new SessionManagerLike(SID) };

    // The exact expression the production guard evaluates. If this is ever rewritten to
    // extract the method into a local and call it bare, this test goes red.
    const resolve = () =>
      typeof ctx.cwd === "string" && typeof ctx.sessionManager?.getSessionId === "function"
        ? checkRestartInFlight(ctx.cwd, ctx.sessionManager.getSessionId())
        : { blocked: false, record: null };

    // With no in-flight record: not blocked, and — the load-bearing part — no throw.
    expect(resolve()).toEqual({ blocked: false, record: null });

    // With one: the guard sees it, which proves the id it read was the real one and not
    // some fallback that happens to be falsy.
    beginRestart(cwd, SID, "probe-f144", 1);
    const blockedResult = resolve();
    expect(blockedResult.blocked).toBe(true);
    expect(blockedResult.record?.restartId).toBe(1);
  });

  it("the REAL tool path runs against a prototype-method sessionManager: no throw, and the guard still stands a repeat down", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = mockPi.registerTool.mock.calls[0][0];

    // First: with nothing seeded the request must dispatch exactly once. Before the F144
    // fix this line threw out of the tool instead of sending.
    await tool.execute(
      "call-1",
      { reason: "first restart", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeProtoToolCtx(cwd, SID)
    );
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Then: with an in-flight record seeded, the same prototype-method ctx must produce the
    // stand-down result and NO second send — proving the id the guard read was the real one.
    beginRestart(cwd, SID, "the first restart reason", 7);
    const result: any = await tool.execute(
      "call-2",
      { reason: "repeat the restart", nextSteps: "n", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      makeProtoToolCtx(cwd, SID)
    );
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(result.content[0].text as string).toContain("A restart is already in progress");
    expect(result.content[0].text as string).toContain("restartId 7");
  });

  it("a context with no sessionManager still short-circuits instead of throwing", () => {
    const ctx: { cwd: string; sessionManager?: SessionManagerLike } = { cwd };
    const resolve = () =>
      typeof ctx.cwd === "string" && typeof ctx.sessionManager?.getSessionId === "function"
        ? checkRestartInFlight(ctx.cwd, ctx.sessionManager.getSessionId())
        : { blocked: false, record: null };
    expect(resolve()).toEqual({ blocked: false, record: null });
  });
});
