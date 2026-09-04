import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";

/** Helper to find a registered event handler by event name */
function getHandler(mockPi: any, eventName: string) {
  const call = mockPi.on.mock.calls.find((c: any) => c[0] === eventName);
  return call?.[1];
}

describe("clean context produces minimal summary without embedded instructions", () => {
  let mockPi: any;
  let cwd: string;

  beforeEach(() => {
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
    };
    // O25: the compact branch (this file's only strategy) now reads/writes the
    // delegate-state record, so makeMockCtx needs a real cwd — a temp dir, not
    // process.cwd(), so a stray .pi/loop/delegate-*.json can never touch the developer's
    // own real state (handover F37).
    cwd = mkdtempSync(join(tmpdir(), "instruction-preservation-mockctx-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeMockCtx(entries: any[] = []) {
    return {
      compact: vi.fn(),
      cwd,
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(entries),
        getSessionId: () => "instruction-preservation-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  }

  it("should NOT embed raw instructions in compaction summary", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const mockCtx = makeMockCtx();

    const result = await toolConfig.execute(
      "tool-call-id",
      { reason: "task 1 done", nextSteps: "task 2", summary: "## Progress\n- Done" },
      undefined, undefined, mockCtx,
    );

    expect(result.content[0].text).not.toContain("<original_instructions>");
    expect(result.content[0].text).not.toContain("Instructions to follow");
    expect(result.content[0].text).toContain("## Progress");
  });

  it("should include reason, nextSteps, and summary in output", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const mockCtx = makeMockCtx();

    const result = await toolConfig.execute(
      "tool-call-id",
      { reason: "completed auth module", nextSteps: "write tests", summary: "## Goal\nImplement auth" },
      undefined, undefined, mockCtx,
    );

    expect(result.content[0].text).toContain("completed auth module");
    expect(result.content[0].text).toContain("write tests");
    expect(result.content[0].text).toContain("## Goal");
    expect(result.content[0].text).toContain("Implement auth");
  });

  it("should include timestamp in summary", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const mockCtx = makeMockCtx();

    const result = await toolConfig.execute(
      "tool-call-id",
      { reason: "done", nextSteps: "next", summary: "s" },
      undefined, undefined, mockCtx,
    );

    expect(result.content[0].text).toMatch(/Timestamp.*\d{4}-\d{2}-\d{2}/);
  });

  it("should not register input or before_agent_start handlers, and its session_start handler injects nothing", async () => {
    extensionFactory(mockPi);

    const registeredEvents = mockPi.on.mock.calls.map((c: any) => c[0]);

    expect(registeredEvents).not.toContain("input");
    expect(registeredEvents).not.toContain("before_agent_start");
    // session_start IS registered now (delegate-state adoption/reaping); the teeth of this
    // test are the two assertions below, which prove that handler injects nothing.
    expect(registeredEvents).toContain("session_start");

    const handler = getHandler(mockPi, "session_start");
    const cwd = mkdtempSync(join(tmpdir(), "instruction-preservation-test-"));
    try {
      await handler(
        { type: "session_start", reason: "startup" },
        {
          cwd,
          sessionManager: { getSessionId: () => "session-instruction-preservation" },
          ui: { notify: vi.fn() },
        }
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("should register the compaction and context handlers it needs", () => {
    extensionFactory(mockPi);

    const registeredEvents = mockPi.on.mock.calls.map((c: any) => c[0]);

    expect(registeredEvents).toContain("context");
    expect(registeredEvents).toContain("session_compact");
    expect(registeredEvents).toContain("session_before_compact");
  });

  it("should pass clean summary to compaction without instruction tags", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const mockCtx = makeMockCtx();

    await toolConfig.execute(
      "tool-call-id",
      { reason: "done", nextSteps: "next", summary: "My clean summary" },
      undefined, undefined, mockCtx,
    );

    // Verify the compaction handler receives a clean summary
    const handler = getHandler(mockPi, "session_before_compact");
    const compactResult = await handler(
      {
        preparation: { tokensBefore: 1000 },
        branchEntries: [{ id: "last" }],
      },
      {},
    );

    expect(compactResult.compaction.summary).toContain("My clean summary");
    expect(compactResult.compaction.summary).not.toContain("<original_instructions>");
    expect(compactResult.compaction.summary).not.toContain("Instructions to follow");
  });
});
