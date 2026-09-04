import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import { getDelegateStatePath } from "../delegate-state";

/**
 * Task 3.6 — decision 12's three failure cases (newSession throws, newSession resolves
 * {cancelled:true}, the command could not be resolved) plus the corrupt-record case
 * decision 20 routes through the same channel. All must deliver the exact
 * "pi-renew restart FAILED: <reason>. …" message on the surviving session via
 * sendPayload (i.e. pi.sendUserMessage, since sendPayload funnels through it) AND a
 * ctx.ui.notify(…, "error"), and none may throw out of the handler.
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

function makeMockToolCtx() {
  return {
    mode: "tui" as const,
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
    sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    ui: { notify: vi.fn() },
  };
}

function getDelegateToAgentTool(mockPi: any) {
  return mockPi.registerTool.mock.calls[0][0];
}

function makeCommandCtx(cwd: string, sessionId: string, newSession: any) {
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/2026-08-24T00-00-00-000Z_${sessionId}.jsonl`,
    },
    waitForIdle: vi.fn(),
    newSession,
  };
}

describe("restart failure reporting (task 3.6, decision 12)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-failure-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("newSession() throws", () => {
    function setup() {
      const mockPi = makeMockPi();
      extensionFactory(mockPi);
      const [, options] = mockPi.registerCommand.mock.calls[0];
      const newSession = vi.fn().mockRejectedValue(new Error("disk is full"));
      const ctx = makeCommandCtx(cwd, "session-x", newSession);
      return { mockPi, handler: options.handler, ctx };
    }

    it("the handler resolves to undefined rather than rejecting", async () => {
      const { handler, ctx } = setup();
      await expect(handler("reason text", ctx)).resolves.toBeUndefined();
    });

    it("sends the exact FAILED message on the surviving session, naming the thrown error", async () => {
      const { mockPi, handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("restart FAILED");
      expect(text).toContain("newSession() threw: disk is full");
      expect(text).toContain("The session was NOT replaced and your context was NOT reset");
    });

    it("notifies with type 'error'", async () => {
      const { handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify.mock.calls[0][1]).toBe("error");
      expect(ctx.ui.notify.mock.calls[0][0]).toContain("restart FAILED");
    });
  });

  describe("newSession() resolves {cancelled: true} — the case a catch block alone misses", () => {
    function setup() {
      const mockPi = makeMockPi();
      extensionFactory(mockPi);
      const [, options] = mockPi.registerCommand.mock.calls[0];
      const newSession = vi.fn().mockResolvedValue({ cancelled: true });
      const ctx = makeCommandCtx(cwd, "session-x", newSession);
      return { mockPi, handler: options.handler, ctx };
    }

    it("the handler resolves to undefined rather than rejecting", async () => {
      const { handler, ctx } = setup();
      await expect(handler("reason text", ctx)).resolves.toBeUndefined();
    });

    it("sends the exact FAILED message on the surviving session, naming the cancellation", async () => {
      const { mockPi, handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("restart FAILED");
      expect(text).toContain("cancelled by a session_before_switch handler");
    });

    it("notifies with type 'error'", async () => {
      const { handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify.mock.calls[0][1]).toBe("error");
    });
  });

  describe("getCommands() returns no pi-renew entry", () => {
    function setup() {
      const mockPi = makeMockPi([]); // no matching command registered
      extensionFactory(mockPi);
      const tool = getDelegateToAgentTool(mockPi);
      const mockCtx = makeMockToolCtx();
      return { mockPi, tool, mockCtx };
    }

    it("the tool reports the failure via sendUserMessage on the surviving session", async () => {
      const { mockPi, tool, mockCtx } = setup();
      await tool.execute(
        "call-1",
        { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
        undefined,
        undefined,
        mockCtx
      );

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("restart FAILED");
      expect(text).toContain("the pi-renew command is not registered");
    });

    it("never dispatches a literal '/pi-renew…' string", async () => {
      const { mockPi, tool, mockCtx } = setup();
      await tool.execute(
        "call-1",
        { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
        undefined,
        undefined,
        mockCtx
      );

      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text.startsWith("/pi-renew")).toBe(false);
    });

    it("notifies with type 'error'", async () => {
      const { tool, mockCtx } = setup();
      await tool.execute(
        "call-1",
        { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
        undefined,
        undefined,
        mockCtx
      );

      expect(mockCtx.ui.notify).toHaveBeenCalledTimes(1);
      expect(mockCtx.ui.notify.mock.calls[0][1]).toBe("error");
    });

    it("the tool's own return value is unchanged by this later-discovered failure — it already returned", async () => {
      const { tool, mockCtx } = setup();
      const result = await tool.execute(
        "call-1",
        { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
        undefined,
        undefined,
        mockCtx
      );

      expect(result.content[0].text).toContain("requested");
    });
  });

  describe("a corrupt record on disk (unknown version)", () => {
    function setup() {
      const mockPi = makeMockPi();
      extensionFactory(mockPi);
      const [, options] = mockPi.registerCommand.mock.calls[0];
      const sessionId = "session-corrupt";
      const dir = join(cwd, ".pi", "loop");
      mkdirSync(dir, { recursive: true });
      writeFileSync(getDelegateStatePath(cwd, sessionId), JSON.stringify({ version: 99 }), "utf-8");
      const newSession = vi.fn().mockResolvedValue({ cancelled: false });
      const ctx = makeCommandCtx(cwd, sessionId, newSession);
      return { mockPi, handler: options.handler, ctx, newSession };
    }

    it("is reported, not thrown out of the handler — it still resolves to undefined", async () => {
      const { handler, ctx } = setup();
      await expect(handler("reason text", ctx)).resolves.toBeUndefined();
    });

    it("never reaches newSession", async () => {
      const { handler, ctx, newSession } = setup();
      await handler("reason text", ctx);

      expect(newSession).not.toHaveBeenCalled();
    });

    it("sends a failure message on the surviving session", async () => {
      const { mockPi, handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("notifies with type 'error'", async () => {
      const { handler, ctx } = setup();
      await handler("reason text", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify.mock.calls[0][1]).toBe("error");
    });
  });
});
