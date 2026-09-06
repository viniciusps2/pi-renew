import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";

/**
 * Decisions 2 and 3 (D-H12, O9) — the `strategy` tool parameter and its default. The
 * default is asserted in exactly one place here, so O15's eventual flip to "new-session"
 * has exactly one test to update.
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

// O25: the "compact" branch — taken by the first two tests below, the omitted-strategy
// default and the explicit "compact" — now reads/writes the renewal-state record, so
// makeMockCtx needs a real cwd. A temp dir, not process.cwd(), so a stray
// .pi/renew/renewal-*.json can never touch the developer's own real state (handover F37).
// File-scoped, not per-describe: makeMockCtx is a plain function outside any describe.
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "restart-strategy-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeMockCtx() {
  return {
    mode: "tui" as const,
    compact: vi.fn(),
    cwd,
    getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: () => "restart-strategy-session",
    },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    ui: { notify: vi.fn() },
  };
}

function getRenewSessionTool(mockPi: any) {
  return mockPi.registerTool.mock.calls[0][0];
}

describe("renew_session strategy selector (decisions 2, 3)", () => {
  it("omitting strategy takes the compact path — ctx.compact is called (the default, asserted here and only here)", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);
    const mockCtx = makeMockCtx();

    await tool.execute(
      "call-1",
      { reason: "r", nextSteps: "next", summary: "s" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockCtx.compact).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("strategy: 'compact' explicitly takes the same path", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);
    const mockCtx = makeMockCtx();

    await tool.execute(
      "call-1",
      { reason: "r", nextSteps: "next", summary: "s", strategy: "compact" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockCtx.compact).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("strategy: 'new-session' calls sendUserMessage and never ctx.compact", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);
    const mockCtx = makeMockCtx();

    await tool.execute(
      "call-1",
      { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mockCtx.compact).not.toHaveBeenCalled();
  });

  it("an unrecognised strategy throws from execute, naming both valid values", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getRenewSessionTool(mockPi);
    const mockCtx = makeMockCtx();

    let message = "";
    try {
      await tool.execute(
        "call-1",
        { reason: "r", nextSteps: "next", summary: "s", strategy: "bogus" },
        undefined,
        undefined,
        mockCtx
      );
      throw new Error("expected tool.execute to throw");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("new-session");
    expect(message).toContain("compact");

    // Nothing should have happened on the way to the throw.
    expect(mockCtx.compact).not.toHaveBeenCalled();
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });
});
