import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extensionFactory from "../pi-renew";

describe("renew_session tool execution", () => {
  let mockPi: any;
  let mockCtx: any;
  let cwd: string;

  beforeEach(() => {
    // O25: the compact branch (this file's only strategy) now reads/writes the
    // renewal-state record, so the mock ctx needs a real cwd — a temp dir, not
    // process.cwd(), so a stray .pi/renew/renewal-*.json can never touch the developer's
    // own real state (handover F37).
    cwd = mkdtempSync(join(tmpdir(), "tool-execution-test-"));
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
        getSessionId: () => "tool-execution-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("should register the renew_session tool", () => {
    extensionFactory(mockPi);

    expect(mockPi.registerTool).toHaveBeenCalled();
    
    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    expect(toolConfig.name).toBe("renew_session");
    expect(toolConfig.label).toBe("Renew Session");
  });

  it("should format summary with handoff metadata", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "completed auth refactoring",
      nextSteps: "write unit tests",
      summary: "## Completed\n- Refactored auth service",
    };

    await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    expect(mockCtx.compact).toHaveBeenCalled();
    
    const compactCall = mockCtx.compact.mock.calls[0][0];
    expect(compactCall.onComplete).toBeDefined();
  });

  it("should return formatted content with summary", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "test reason",
      nextSteps: "test phase",
      summary: "test summary content",
    };

    const result = await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // The spec's "Tool result is honest about pendingness" requirement (batch 3A)
    // deliberately changed this to "requested … pending" — a restart is not yet
    // known to have completed when the tool returns.
    expect(result.content[0].text).toContain("Session renewal requested");
    expect(result.content[0].text).toContain("test phase");
  });

  it("should include timestamp in formatted summary", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;

    const params = {
      reason: "test reason",
      nextSteps: "test phase",
      summary: "test summary",
    };

    const result = await executeFn("tool-call-id", params, undefined, undefined, mockCtx);

    // Check that timestamp is present in ISO format
    expect(result.content[0].text).toMatch(/Timestamp.*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
