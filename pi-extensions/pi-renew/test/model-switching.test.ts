import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";

// Provide a deterministic config so tests don't depend on the real filesystem.
// resolveModelId is kept real to test the full resolution logic.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      models: [
        { id: "Q3.5-27B", names: ["coding"] },
        { id: "G4-31B", names: ["reviewer"] },
      ],
    }),
  };
});

describe("model switching via nextModel parameter", () => {
  let mockPi: any;
  let mockCtx: any;
  let cwd: string;

  const q3Model = { id: "Q3.5-27B", provider: "llm-1" };
  const g4Model = { id: "G4-31B", provider: "llm-1" };

  beforeEach(() => {
    // O25: the compact branch (the default strategy, used by every test in this file) now
    // reads/writes the delegate-state record, so the mock ctx needs a real cwd — a temp
    // dir, not process.cwd(), so a stray .pi/loop/delegate-*.json can never touch the
    // developer's own real state (handover F37).
    cwd = mkdtempSync(join(tmpdir(), "model-switching-test-"));
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
        getSessionId: () => "model-switching-session",
      },
      modelRegistry: {
        getAll: vi.fn().mockReturnValue([q3Model, g4Model]),
      },
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("should call pi.setModel with resolved model when nextModel is provided", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "switching to heavier model",
      nextSteps: "complex reasoning task",
      summary: "## Goal\nNeed heavier model",
      nextModel: "G4-31B",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.setModel).toHaveBeenCalledWith(g4Model);
  });

  it("should call pi.setModel before sendUserMessage", async () => {
    extensionFactory(mockPi);

    const callOrder: string[] = [];
    mockPi.setModel.mockImplementation(() => { callOrder.push("setModel"); return Promise.resolve(true); });
    mockPi.sendUserMessage.mockImplementation(() => { callOrder.push("sendUserMessage"); });

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "test",
      nextSteps: "next task",
      summary: "summary",
      nextModel: "Q3.5-27B",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(callOrder).toEqual(["setModel", "sendUserMessage"]);
  });

  it("should not call pi.setModel when nextModel is omitted", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "no model change",
      nextSteps: "continue working",
      summary: "summary",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.setModel).not.toHaveBeenCalled();
  });

  it("should not call pi.setModel when nextModel is not found in registry", async () => {
    extensionFactory(mockPi);
    mockCtx.modelRegistry.getAll.mockReturnValue([q3Model]); // G4-31B not available

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "unknown model",
      nextSteps: "some task",
      summary: "summary",
      nextModel: "G4-31B",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.setModel).not.toHaveBeenCalled();
  });

  it("should mention switching model in the return text when model is found", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const result = await executeFn("tool-call-id", {
      reason: "switching to Q3",
      nextSteps: "coding task",
      summary: "summary",
      nextModel: "Q3.5-27B",
    }, undefined, undefined, mockCtx);

    expect(result.content[0].text).toContain("Q3.5-27B");
    expect(result.content[0].text).toContain("switching to model");
  });

  it("should warn in return text when model is not found", async () => {
    extensionFactory(mockPi);
    mockCtx.modelRegistry.getAll.mockReturnValue([]); // empty registry

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const result = await executeFn("tool-call-id", {
      reason: "test",
      nextSteps: "task",
      summary: "summary",
      nextModel: "nonexistent-model",
    }, undefined, undefined, mockCtx);

    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("nonexistent-model");
  });

  it("should include model note in the delegation summary when nextModel is provided", async () => {
    extensionFactory(mockPi);

    function getHandler(mockPi: any, eventName: string) {
      const call = mockPi.on.mock.calls.find((c: any) => c[0] === eventName);
      return call?.[1];
    }

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "model switch test",
      nextSteps: "next task",
      summary: "summary content",
      nextModel: "G4-31B",
    }, undefined, undefined, mockCtx);

    const handler = getHandler(mockPi, "session_before_compact");
    const result = await handler(
      {
        preparation: { firstKeptEntryId: "entry-1", tokensBefore: 100 },
        branchEntries: [{ id: "entry-1", content: "last" }],
      },
      {}
    );

    expect(result.compaction.summary).toContain("G4-31B");
  });

  it("should resolve model by alias name (e.g. 'coding' → Q3.5-27B)", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "use coding model",
      nextSteps: "write code",
      summary: "summary",
      nextModel: "coding",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.setModel).toHaveBeenCalledWith(q3Model);
  });

  it("should resolve model by alias name case-insensitively (e.g. 'Reviewer' → G4-31B)", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    await executeFn("tool-call-id", {
      reason: "use reviewer model",
      nextSteps: "review code",
      summary: "summary",
      nextModel: "Reviewer",
    }, undefined, undefined, mockCtx);

    const compactOptions = mockCtx.compact.mock.calls[0][0];
    await compactOptions.onComplete();

    expect(mockPi.setModel).toHaveBeenCalledWith(g4Model);
  });

  it("should report the resolved model ID in return text when alias is used", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const result = await executeFn("tool-call-id", {
      reason: "switching",
      nextSteps: "task",
      summary: "summary",
      nextModel: "coding",
    }, undefined, undefined, mockCtx);

    // Should show resolved ID, not the alias
    expect(result.content[0].text).toContain("Q3.5-27B");
    expect(result.content[0].text).toContain("switching to model");
  });

  it("should report pi-renew.json in warning when alias is unknown", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const result = await executeFn("tool-call-id", {
      reason: "test",
      nextSteps: "task",
      summary: "summary",
      nextModel: "unknown-alias",
    }, undefined, undefined, mockCtx);

    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("pi-renew.json");
  });
});
