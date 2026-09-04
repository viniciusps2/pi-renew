import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import {
  DELEGATE_STATE_VERSION,
  getDelegateStateDir,
  readDelegateState,
  writeDelegateState,
} from "../delegate-state";

/**
 * O25 — the `compact` restart strategy delivers the assembled payload as its continuation,
 * the same as `new-session` (task 3.4's original gap; see the implementation handover's O25
 * entry and the delta spec's "Compact strategy selected" scenario). Mirrors
 * restart-newsession.test.ts's structure and header-comment style: drive the
 * `delegate_to_agent` tool with the default strategy (compact), then invoke the captured
 * `ctx.compact` callback directly, since this is a mocked, no-live-process suite.
 */
function makeMockPi(order: string[] = []): any {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn().mockImplementation(() => {
      order.push("sendUserMessage");
    }),
    sendMessage: vi.fn().mockImplementation(() => {
      order.push("sendMessage");
    }),
    setModel: vi.fn().mockResolvedValue(true),
  };
}

function makeMockToolCtx(cwd: string, sessionId: string) {
  return {
    mode: "tui" as const,
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
    cwd,
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: () => sessionId,
    },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    ui: { notify: vi.fn() },
  };
}

function getDelegateToAgentTool(mockPi: any) {
  return mockPi.registerTool.mock.calls[0][0];
}

function registerContextRecord(
  cwd: string,
  sessionId: string,
  restartCount: number,
  extra: Partial<{ context: string; includeSummary: boolean; includeNextSteps: boolean }> = {}
) {
  writeDelegateState(cwd, sessionId, {
    version: DELEGATE_STATE_VERSION,
    context: "/loop implement tasks.md",
    includeSummary: true,
    includeNextSteps: true,
    restartCount,
    registeredAt: new Date().toISOString(),
    ...extra,
  });
}

/** Runs delegate_to_agent with the default (compact) strategy and returns the captured
 *  ctx.compact({ onComplete, onError }) options for the caller to invoke directly. */
async function runTool(mockPi: any, ctx: any, params: any) {
  extensionFactory(mockPi);
  const tool = getDelegateToAgentTool(mockPi);
  const result = await tool.execute("call-1", params, undefined, undefined, ctx);
  return { result, compactOptions: ctx.compact.mock.calls[0][0] };
}

describe("delegate_to_agent compact restart — onComplete, with a registered delegate context", () => {
  const sessionId = "restart-compact-payload-registered-session";
  let cwd: string;
  let order: string[];
  let mockPi: any;
  let ctx: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-compact-payload-registered-"));
    // Seeded to 4, never 0 or 1: a hardcoded "#1" would still pass a test seeded at 0 or 1,
    // but not one that must produce "#5".
    registerContextRecord(cwd, sessionId, 4);
    order = [];
    mockPi = makeMockPi(order);
    ctx = makeMockToolCtx(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function fireOnComplete() {
    const { compactOptions } = await runTool(mockPi, ctx, {
      reason: "reason-compact-onComplete",
      nextSteps: "next steps for the onComplete case",
      summary: "summary for the onComplete case",
    });
    await compactOptions.onComplete();
  }

  it("sends exactly two messages: one pi.sendMessage and one pi.sendUserMessage, in that order", async () => {
    await fireOnComplete();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["sendMessage", "sendUserMessage"]);
  });

  it("the pi.sendMessage call carries customType, display and { triggerTurn: false }", async () => {
    await fireOnComplete();

    const [message, options] = mockPi.sendMessage.mock.calls[0];
    expect(message.customType).toBe("pi-renew-restart");
    expect(message.display).toBe(true);
    expect(options).toEqual({ triggerTurn: false });
  });

  it("its content starts with the frozen success header and contains restart #5 and the reason", async () => {
    await fireOnComplete();

    const [message] = mockPi.sendMessage.mock.calls[0];
    expect(message.content.startsWith("Agent delegation completed; context was reset.")).toBe(true);
    expect(message.content).toContain("restart #5");
    expect(message.content).toContain("reason-compact-onComplete");
  });

  it("the pi.sendUserMessage call delivers the delegate context alone, exact equality, with the followUp shape", async () => {
    await fireOnComplete();

    const [content, options] = mockPi.sendUserMessage.mock.calls[0];
    expect(content).toBe("/loop implement tasks.md");
    expect(options).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });
  });

  it("persists restartCount: 5 and lastReason equal to the reason passed to the tool", async () => {
    await fireOnComplete();

    const after = readDelegateState(cwd, sessionId);
    expect(after!.restartCount).toBe(5);
    expect(after!.lastReason).toBe("reason-compact-onComplete");
  });
});

describe("delegate_to_agent compact restart — includeSummary: false", () => {
  const sessionId = "restart-compact-payload-no-summary-session";
  let cwd: string;
  let mockPi: any;
  let ctx: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-compact-payload-no-summary-"));
    registerContextRecord(cwd, sessionId, 3, { includeSummary: false });
    mockPi = makeMockPi();
    ctx = makeMockToolCtx(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("omits ## Summary from the prelude while provenance, next steps and the context still arrive", async () => {
    const { compactOptions } = await runTool(mockPi, ctx, {
      reason: "reason-no-summary",
      nextSteps: "next steps that must survive",
      summary: "this summary text must be suppressed",
    });
    await compactOptions.onComplete();

    const [message] = mockPi.sendMessage.mock.calls[0];
    expect(message.content).toContain("restart #4");
    expect(message.content).toContain("## Next steps");
    expect(message.content).toContain("next steps that must survive");
    expect(message.content).not.toContain("## Summary");
    expect(message.content).not.toContain("this summary text must be suppressed");

    const [contextContent] = mockPi.sendUserMessage.mock.calls[0];
    expect(contextContent).toBe("/loop implement tasks.md");
  });
});

describe("delegate_to_agent compact restart — no registered context (decision 19's common case)", () => {
  const sessionId = "restart-compact-payload-unregistered-session";
  let cwd: string;
  let mockPi: any;
  let ctx: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-compact-payload-unregistered-"));
    mockPi = makeMockPi();
    ctx = makeMockToolCtx(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sends no custom message, and delivers provenance, summary and next steps in one sendUserMessage call", async () => {
    const { compactOptions } = await runTool(mockPi, ctx, {
      reason: "reason-unregistered",
      nextSteps: "next steps with nothing registered",
      summary: "summary with nothing registered",
    });
    await compactOptions.onComplete();

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

    const [content] = mockPi.sendUserMessage.mock.calls[0];
    const headerIdx = content.indexOf("Agent delegation completed; context was reset.");
    const ordinalIdx = content.indexOf("restart #1");
    const summaryIdx = content.indexOf("## Summary");
    const summaryTextIdx = content.indexOf("summary with nothing registered");
    const nextStepsIdx = content.indexOf("## Next steps");
    const nextStepsTextIdx = content.indexOf("next steps with nothing registered");

    // All present...
    for (const idx of [headerIdx, ordinalIdx, summaryIdx, summaryTextIdx, nextStepsIdx, nextStepsTextIdx]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    // ...and in this order: header, ordinal, summary section, next-steps section.
    expect(headerIdx).toBeLessThan(ordinalIdx);
    expect(ordinalIdx).toBeLessThan(summaryIdx);
    expect(summaryIdx).toBeLessThan(summaryTextIdx);
    expect(summaryTextIdx).toBeLessThan(nextStepsIdx);
    expect(nextStepsIdx).toBeLessThan(nextStepsTextIdx);
  });
});

describe("delegate_to_agent compact restart — degraded path ('Nothing to compact'), with a registered context", () => {
  const sessionId = "restart-compact-payload-degraded-session";
  let cwd: string;
  let mockPi: any;
  let ctx: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-compact-payload-degraded-"));
    registerContextRecord(cwd, sessionId, 2);
    mockPi = makeMockPi();
    ctx = makeMockToolCtx(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("keeps the frozen degraded sentence and provenance, and still delivers the delegate context", async () => {
    const { compactOptions } = await runTool(mockPi, ctx, {
      reason: "reason-degraded",
      nextSteps: "next steps for the degraded case",
      summary: "summary for the degraded case",
    });
    await compactOptions.onError(new Error("Nothing to compact"));

    const [message] = mockPi.sendMessage.mock.calls[0];
    expect(message.content).toContain(
      "Agent delegation continued WITHOUT a context reset (Nothing to compact). Your previous context is still present — do not assume a clean slate."
    );
    expect(message.content).toContain("restart #3");

    const [contextContent] = mockPi.sendUserMessage.mock.calls[0];
    expect(contextContent).toBe("/loop implement tasks.md");
  });
});

describe("delegate_to_agent compact restart — ordinal claimed before any side effect (decision 8)", () => {
  const sessionId = "restart-compact-payload-corrupt-session";
  let cwd: string;
  let mockPi: any;
  let ctx: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "restart-compact-payload-corrupt-"));
    mockPi = makeMockPi();
    ctx = makeMockToolCtx(cwd, sessionId);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("with a corrupt record on disk, execute() rejects and ctx.compact is never called", async () => {
    const dir = getDelegateStateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `delegate-${sessionId}.json`), "{not json", "utf-8");

    extensionFactory(mockPi);
    const tool = getDelegateToAgentTool(mockPi);

    // Not a bare rejects.toThrow(): that passes on ANY throw, including a TypeError from a
    // malformed mock ctx — the very failure this test exists to distinguish from. readDelegateState's
    // contract is that it names the offending file, so assert on that message.
    await expect(
      tool.execute(
        "call-1",
        { reason: "reason-corrupt", nextSteps: "next", summary: "s" },
        undefined,
        undefined,
        ctx
      )
    ).rejects.toThrow(join(dir, `delegate-${sessionId}.json`));

    expect(ctx.compact).not.toHaveBeenCalled();
  });
});
