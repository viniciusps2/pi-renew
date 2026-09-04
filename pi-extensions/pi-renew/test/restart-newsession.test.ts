import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import { DELEGATE_STATE_VERSION, readDelegateState, writeDelegateState } from "../delegate-state";

/**
 * Task 3.3 — the new-session restart strategy end to end: the tool's dispatch (decisions
 * 5-8, 17-19) and the command handler's restart (decisions 6, 9-11, 20-21). Two separate
 * describe blocks because this is a mocked, no-live-process suite: the tool's dispatch
 * never actually invokes the registered command handler, so each half is driven directly.
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

function getSessionBeforeCompactHandler(mockPi: any) {
  return mockPi.on.mock.calls.find((c: any) => c[0] === "session_before_compact")?.[1];
}

describe("delegate_to_agent tool dispatch, strategy: new-session (task 3.3, decisions 5-8, 17-19)", () => {
  it("calls pi.sendUserMessage with expandPromptTemplates:true and no deliverAs key — exact equality", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);
    const mockCtx = makeMockToolCtx();

    await tool.execute(
      "call-1",
      { reason: "reason-alpha", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [dispatched, options] = mockPi.sendUserMessage.mock.calls[0];
    expect(dispatched).toBe("/pi-renew -- reason-alpha");
    expect(options).toEqual({ expandPromptTemplates: true });
  });

  it("with only pi-renew:3 and pi-renew:2 registered (no unsuffixed entry), dispatches to the lowest numeric suffix — fixture ordering disagrees with the answer", async () => {
    const mockPi = makeMockPi([
      { name: "pi-renew:3", source: "extension", sourceInfo: {} },
      { name: "pi-renew:2", source: "extension", sourceInfo: {} },
    ]);
    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);
    const mockCtx = makeMockToolCtx();

    await tool.execute(
      "call-1",
      { reason: "reason-beta", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockPi.sendUserMessage.mock.calls[0][0]).toBe("/pi-renew:2 -- reason-beta");
  });

  it("prefers the unsuffixed name regardless of its position among the getCommands() entries", async () => {
    const mockPi = makeMockPi([
      { name: "pi-renew:3", source: "extension", sourceInfo: {} },
      { name: "pi-renew:2", source: "extension", sourceInfo: {} },
      { name: "pi-renew", source: "extension", sourceInfo: {} },
    ]);
    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);
    const mockCtx = makeMockToolCtx();

    await tool.execute(
      "call-1",
      { reason: "reason-gamma", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockPi.sendUserMessage.mock.calls[0][0]).toBe("/pi-renew -- reason-gamma");
  });

  it("ctx.compact is never called", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);
    const mockCtx = makeMockToolCtx();

    await tool.execute(
      "call-1",
      { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    expect(mockCtx.compact).not.toHaveBeenCalled();
  });

  it("pendingDelegation stays unset — observably, via session_before_compact returning undefined", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);
    const mockCtx = makeMockToolCtx();

    await tool.execute(
      "call-1",
      { reason: "r", nextSteps: "next", summary: "s", strategy: "new-session" },
      undefined,
      undefined,
      mockCtx
    );

    const handler = getSessionBeforeCompactHandler(mockPi);
    const result = await handler(
      { preparation: { firstKeptEntryId: "entry-x", tokensBefore: 1 }, branchEntries: [{ id: "entry-x" }] },
      {}
    );
    expect(result).toBeUndefined();
  });
});

/**
 * The command handler's half: driven directly (`options.handler(args, ctx)`), with a
 * `ctx.newSession` mock that invokes the passed `withSession` callback against a fake
 * `ReplacedSessionContext`, so the delivered payload can be inspected.
 */
function makeMockCommandPi(): any {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getCommands: vi.fn().mockReturnValue([]),
  };
}

function getPiRenewHandler(mockPi: any) {
  return mockPi.registerCommand.mock.calls[0][1].handler;
}

function makeReplacedSessionCtx(order: string[]) {
  return {
    sendMessage: vi.fn().mockImplementation(async () => {
      order.push("sendMessage");
    }),
    sendUserMessage: vi.fn().mockImplementation(async () => {
      order.push("sendUserMessage");
    }),
  };
}

function makeCommandCtx(cwd: string, sessionId: string, c2: any) {
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/2026-08-24T00-00-00-000Z_${sessionId}.jsonl`,
    },
    waitForIdle: vi.fn(),
    newSession: vi.fn().mockImplementation(async (options: any) => {
      if (options?.withSession) {
        await options.withSession(c2);
      }
      return { cancelled: false };
    }),
  };
}

function registerContextRecord(cwd: string, sessionId: string, restartCount = 0, extra: any = {}) {
  writeDelegateState(cwd, sessionId, {
    version: DELEGATE_STATE_VERSION,
    context: "the delegate context payload",
    includeSummary: true,
    includeNextSteps: true,
    restartCount,
    registeredAt: new Date().toISOString(),
    ...extra,
  });
}

describe("/pi-renew command handler restart (task 3.3, decisions 6, 9-11, 20-21)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-newsession-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("parentSession", () => {
    it("newSession is called exactly once", async () => {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const c2 = makeReplacedSessionCtx([]);
      const ctx = makeCommandCtx(cwd, "session-x", c2);

      await handler("some reason", ctx);

      expect(ctx.newSession).toHaveBeenCalledTimes(1);
    });

    it("equals ctx.sessionManager.getSessionFile()'s return value", async () => {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const c2 = makeReplacedSessionCtx([]);
      const ctx = makeCommandCtx(cwd, "session-x", c2);

      await handler("some reason", ctx);

      expect(ctx.newSession.mock.calls[0][0].parentSession).toBe(
        "/sessions/2026-08-24T00-00-00-000Z_session-x.jsonl"
      );
    });
  });

  describe("with a registered context", () => {
    const sessionId = "session-with-context";

    function setup() {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      registerContextRecord(cwd, sessionId);
      const order: string[] = [];
      const c2 = makeReplacedSessionCtx(order);
      const ctx = makeCommandCtx(cwd, sessionId, c2);
      return { handler, ctx, c2, order };
    }

    it("sends the prelude as a custom message naming the customType, content and display", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("reason-with-context", ctx);

      expect(c2.sendMessage).toHaveBeenCalledTimes(1);
      const [message] = c2.sendMessage.mock.calls[0];
      expect(message.customType).toBe("pi-renew-restart");
      expect(message.display).toBe(true);
      expect(message.content).toContain("restart #1");
      expect(message.content).toContain("reason-with-context");
    });

    it("sends the prelude with { triggerTurn: false }", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("reason-with-context", ctx);

      const [, messageOptions] = c2.sendMessage.mock.calls[0];
      expect(messageOptions).toEqual({ triggerTurn: false });
    });

    it("then sends the context alone as a followUp user message", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("reason-with-context", ctx);

      expect(c2.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(c2.sendUserMessage).toHaveBeenCalledWith("the delegate context payload", {
        expandPromptTemplates: true,
        deliverAs: "followUp",
      });
    });

    it("sends the prelude before the context — in that order", async () => {
      const { handler, ctx, order } = setup();
      await handler("reason-with-context", ctx);

      expect(order).toEqual(["sendMessage", "sendUserMessage"]);
    });
  });

  describe("with no registered context", () => {
    const sessionId = "session-no-context";

    function setup() {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const c2 = makeReplacedSessionCtx([]);
      const ctx = makeCommandCtx(cwd, sessionId, c2);
      return { handler, ctx, c2 };
    }

    it("sendMessage is not called", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("reason-no-context", ctx);

      expect(c2.sendMessage).not.toHaveBeenCalled();
    });

    it("sendUserMessage is called once with the prelude alone, as a followUp", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("reason-no-context", ctx);

      expect(c2.sendUserMessage).toHaveBeenCalledTimes(1);
      const [content, options] = c2.sendUserMessage.mock.calls[0];
      expect(content).toContain("restart #1");
      expect(content).toContain("reason-no-context");
      expect(options).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });
    });
  });

  describe("provenance ordinal and restartCount persistence", () => {
    it("first restart: provenance says #1, the reason is verbatim, and restartCount goes 0 -> 1 on disk", async () => {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const sessionId = "session-ordinal-first";
      registerContextRecord(cwd, sessionId, 0);
      const c2 = makeReplacedSessionCtx([]);

      await handler("first restart reason", makeCommandCtx(cwd, sessionId, c2));

      const after = readDelegateState(cwd, sessionId);
      expect(after!.restartCount).toBe(1);
      expect(after!.lastReason).toBe("first restart reason");
      expect(c2.sendMessage.mock.calls[0][0].content).toContain("restart #1");
      expect(c2.sendMessage.mock.calls[0][0].content).toContain("first restart reason");
    });

    it("a restart starting from restartCount:1 on disk: provenance says #2, and restartCount goes 1 -> 2", async () => {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const sessionId = "session-ordinal-second";
      registerContextRecord(cwd, sessionId, 1, { lastReason: "first restart reason" });
      const c2 = makeReplacedSessionCtx([]);

      await handler("second restart reason", makeCommandCtx(cwd, sessionId, c2));

      const after = readDelegateState(cwd, sessionId);
      expect(after!.restartCount).toBe(2);
      expect(after!.lastReason).toBe("second restart reason");
      expect(c2.sendMessage.mock.calls[0][0].content).toContain("restart #2");
      expect(c2.sendMessage.mock.calls[0][0].content).toContain("second restart reason");
    });

    it("two restarts against the SAME (unreplaced) session id: the second stands down (D1 guard), restartCount stays 1", async () => {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const sessionId = "session-ordinal-chained";
      registerContextRecord(cwd, sessionId, 0);

      // First restart: no in-flight state exists yet, so it proceeds and claims ordinal 1.
      const ctx1 = makeCommandCtx(cwd, sessionId, makeReplacedSessionCtx([]));
      await handler("first restart reason", ctx1);
      expect(ctx1.newSession, "the first restart proceeds").toHaveBeenCalledTimes(1);
      expect(readDelegateState(cwd, sessionId)!.restartCount).toBe(1);

      // A *distinct* second restart in production happens in a *replacement* session (a new id),
      // which the guard never blocks. The only way to hit the SAME session id twice is a
      // non-replacing restart being re-issued — the D1 re-fire loop — so the guard stands the
      // second call down instead of incrementing to 2: no newSession, no ordinal change, and a
      // stand-down is reported on the still-live session.
      const ctx2 = makeCommandCtx(cwd, sessionId, makeReplacedSessionCtx([]));
      await handler("second restart reason", ctx2);
      expect(ctx2.newSession, "a blocked repeat must not re-dispatch the restart").not.toHaveBeenCalled();
      expect(readDelegateState(cwd, sessionId)!.restartCount, "the stand-down must not increment the ordinal").toBe(1);
      expect(ctx2.ui.notify, "the stand-down is reported, not swallowed").toHaveBeenCalled();
      expect(ctx2.ui.notify.mock.calls[0][0], "names the in-flight restart and says to stand down").toMatch(/already in progress/);
    });
  });

  describe("with no record on disk (nothing registered)", () => {
    const sessionId = "session-unregistered";

    function setup() {
      const mockPi = makeMockCommandPi();
      extensionFactory(mockPi);
      const handler = getPiRenewHandler(mockPi);
      const c2 = makeReplacedSessionCtx([]);
      const ctx = makeCommandCtx(cwd, sessionId, c2);
      return { handler, ctx, c2 };
    }

    it("the restart still happens", async () => {
      const { handler, ctx } = setup();
      await handler("unregistered reason", ctx);

      expect(ctx.newSession).toHaveBeenCalledTimes(1);
    });

    it("provenance says #1", async () => {
      const { handler, ctx, c2 } = setup();
      await handler("unregistered reason", ctx);

      expect(c2.sendUserMessage.mock.calls[0][0]).toContain("restart #1");
    });

    it("no record is written", async () => {
      const { handler, ctx } = setup();
      await handler("unregistered reason", ctx);

      expect(readDelegateState(cwd, sessionId)).toBeNull();
    });
  });
});
