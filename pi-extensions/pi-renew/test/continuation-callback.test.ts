import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";

describe("continuation callback after compaction", () => {
  let mockPi: any;
  let mockCtx: any;
  let cwd: string;

  beforeEach(() => {
    // O25: the compact branch (this file's only strategy) now reads/writes the
    // delegate-state record, so the mock ctx needs a real cwd — a temp dir, not
    // process.cwd(), so a stray .pi/loop/delegate-*.json can never touch the developer's
    // own real state (handover F37).
    cwd = mkdtempSync(join(tmpdir(), "continuation-callback-test-"));
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
    };
    mockCtx = {
      compact: vi.fn(),
      cwd,
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: () => "continuation-callback-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("should configure onComplete callback in ctx.compact call", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed work",
      nextSteps: "start new phase",
      summary: "summary content",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    expect(mockCtx.compact).toHaveBeenCalled();
    const compactOptions = mockCtx.compact.mock.calls[0][0];
    
    expect(compactOptions.onComplete).toBeDefined();
    expect(typeof compactOptions.onComplete).toBe("function");
  });

  it("should send followUp user message on compaction complete", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed work",
      nextSteps: "write tests",
      summary: "summary",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    // Get the onComplete callback and invoke it
    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.sendUserMessage).toHaveBeenCalled();
  });

  it("should include nextSteps in continuation message", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed work",
      nextSteps: "implement feature X",
      summary: "summary",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    const sendMessageCall = mockPi.sendUserMessage.mock.calls[0];
    expect(sendMessageCall[0]).toContain("implement feature X");
  });

  it("should deliver continuation message as followUp", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed work",
      nextSteps: "next task",
      summary: "summary",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    const sendMessageCall = mockPi.sendUserMessage.mock.calls[0];
    // Decision 16 (task 3.7's send-shapes helper): the continuation now goes through
    // sendPayload, which adds expandPromptTemplates:true alongside the existing
    // deliverAs:"followUp" — exact equality, not objectContaining, so a dropped or
    // silently-changed option here still fails this assertion.
    expect(sendMessageCall[1]).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });
  });

  // O25 decision 14: the old inline `promptLine` sentence (deleted) is gone — the payload's
  // "## Next steps" section, assembled by assembleRestartPayload, is what carries the next
  // steps now, exactly as on the new-session path. Renamed and rewritten rather than
  // deleted, per the brief's decision 20: this is the only place in the suite that asserted
  // on that old phrasing.
  it("carries the next steps in the payload's ## Next steps section", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed work",
      nextSteps: "new task",
      summary: "summary",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    const sendMessageCall = mockPi.sendUserMessage.mock.calls[0];
    expect(sendMessageCall[0]).toContain("## Next steps");
    expect(sendMessageCall[0]).toContain("new task");
  });
});
