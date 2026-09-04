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

// O25: executeDelegation's compact branch now reads (and writes) the delegate-state record,
// so every mock ctx below needs a real cwd and a sessionManager.getSessionId — a temp dir,
// not "/nonexistent" or process.cwd(), so a stray .pi/loop/delegate-*.json here can never
// read or write the developer's own real state (the same class of defect as handover F37).
// File-scoped (not per-describe): both describe blocks below build a compacting ctx.
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "compaction-handler-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("session_before_compact handler", () => {
  let mockPi: any;

  beforeEach(() => {
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
    };
  });

  it("should register session_before_compact event handler", () => {
    extensionFactory(mockPi);

    expect(mockPi.on).toHaveBeenCalledWith(
      "session_before_compact",
      expect.any(Function)
    );
  });

  it("should return undefined when pendingHandoff is not set (normal /compact)", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "session_before_compact");
    const mockEvent = {
      preparation: {
        firstKeptEntryId: "entry-123",
        tokensBefore: 1000,
      },
    };

    const result = await handler(mockEvent, {});

    // Should return undefined to let Pi handle normal compaction
    expect(result).toBeUndefined();
  });

  it("should return CompactionResult when pendingHandoff is set", async () => {
    extensionFactory(mockPi);

    // First trigger the tool to set pendingHandoff
    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;
    const mockCtx = {
      compact: vi.fn(),
      cwd,
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: () => "compaction-handler-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };

    await executeFn("tool-call-id", {
      reason: "test reason",
      nextSteps: "test phase",
      summary: "test summary content",
    }, undefined, undefined, mockCtx);

    // Now trigger the compaction handler
    const handler = getHandler(mockPi, "session_before_compact");
    const mockEvent = {
      preparation: {
        firstKeptEntryId: "entry-456",
        tokensBefore: 2000,
      },
      branchEntries: [
        { id: "entry-last", content: "last entry" },
      ],
    };

    const result = await handler(mockEvent, {});

    expect(result).toBeDefined();
    expect(result.compaction.summary).toContain("test summary content");
    expect(result.compaction.firstKeptEntryId).toBe("entry-last");
    expect(result.compaction.tokensBefore).toBe(2000);
  });

  it("should consume pendingHandoff after returning result", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;
    const mockCtx = {
      compact: vi.fn(),
      cwd,
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: () => "compaction-handler-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    }; 

    await executeFn("tool-call-id", {
      reason: "test reason",
      nextSteps: "test phase", 
      summary: "test summary",
    }, undefined, undefined, mockCtx);

    const handler = getHandler(mockPi, "session_before_compact");
    
    // First call should return result
    const result1 = await handler(
      { 
        preparation: { firstKeptEntryId: "entry-1", tokensBefore: 100 },
        branchEntries: [{ id: "entry-1", content: "first" }],
      },
      {}
    );
    expect(result1).toBeDefined();

    // Second call should return undefined (pendingHandoff consumed)
    const result2 = await handler(
      { 
        preparation: { firstKeptEntryId: "entry-2", tokensBefore: 200 },
        branchEntries: [{ id: "entry-2", content: "second" }],
      },
      {}
    );
    expect(result2).toBeUndefined();
  });

  it("should include handoff metadata in compaction summary", async () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const executeFn = toolConfig.execute;
    const mockCtx = {
      compact: vi.fn(),
      cwd,
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: () => "compaction-handler-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };

    await executeFn("tool-call-id", {
      reason: "completed auth refactoring",
      nextSteps: "write unit tests",
      summary: "## Done\n- Auth service refactored",
    }, undefined, undefined, mockCtx);

    const handler = getHandler(mockPi, "session_before_compact");
    const result = await handler(
      { 
        preparation: { firstKeptEntryId: "entry-1", tokensBefore: 100 },
        branchEntries: [{ id: "entry-1", content: "first" }],
      },
      {}
    );

    expect(result.compaction.summary).toContain("completed auth refactoring");
    expect(result.compaction.summary).toContain("write unit tests");
    expect(result.compaction.summary).toContain("## Done");
  });
});

/**
 * Task 3.4 — the compact strategy behind the new selector (default, per decision 3), with
 * its already-applied "nothing to compact" fix preserved and tested explicitly. pendingDelegation
 * clearing is asserted observably, per the technique used across this batch's new test
 * files: fire session_before_compact again afterwards and confirm it is a no-op (returns
 * undefined) rather than reading the private variable.
 */
describe("compact path — honest continuation and pendingDelegation clearing (task 3.4)", () => {
  let mockPi: any;
  let mockCtx: any;

  beforeEach(() => {
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
        getSessionId: () => "compaction-handler-session",
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  });

  /** Runs the tool once and returns its onComplete/onError callbacks. */
  async function runTool() {
    extensionFactory(mockPi);
    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const result = await toolConfig.execute(
      "tool-call-id",
      { reason: "r", nextSteps: "next", summary: "s" },
      undefined,
      undefined,
      mockCtx
    );
    return { toolConfig, result, compactOptions: mockCtx.compact.mock.calls[0][0] };
  }

  /** pendingDelegation cleared, observed the only way this batch allows: firing
   *  session_before_compact again must now be a no-op (returns undefined). */
  async function expectPendingDelegationCleared(entryId: string) {
    const handler = getHandler(mockPi, "session_before_compact");
    const result = await handler(
      { preparation: { firstKeptEntryId: entryId, tokensBefore: 1 }, branchEntries: [{ id: entryId }] },
      {}
    );
    expect(result).toBeUndefined();
  }

  it("onComplete sends a continuation stating the context WAS reset", async () => {
    const { compactOptions } = await runTool();
    await compactOptions.onComplete();

    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage.mock.calls[0][0]).toContain("context was reset");
  });

  describe("the 'Nothing to compact' variant", () => {
    it("continues WITHOUT a context reset and names the reason", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("Nothing to compact"));

      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("WITHOUT a context reset");
      expect(text).toContain("Nothing to compact");
      // O25 decision 13: the degraded path delivers the payload too, so its provenance
      // line rides along with the honest-failure header rather than being dropped. The
      // ordinal is deterministically 1: cwd is a fresh temp dir with no registered record,
      // so claimRestartOrdinal returns (0 ?? 0) + 1. Pinning the number, not just the
      // "restart #" prefix, is what makes a dropped or miscomputed ordinal fail here.
      expect(text).toContain("restart #1");
    });

    it("clears pendingDelegation", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("Nothing to compact"));
      await expectPendingDelegationCleared("entry-a1");
    });
  });

  describe("the 'session too small' variant", () => {
    it("continues WITHOUT a context reset and names the reason", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("session too small"));

      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("WITHOUT a context reset");
      expect(text).toContain("session too small");
      // O25 decision 13: the degraded path delivers the payload too, so its provenance
      // line rides along with the honest-failure header rather than being dropped. The
      // ordinal is deterministically 1: cwd is a fresh temp dir with no registered record,
      // so claimRestartOrdinal returns (0 ?? 0) + 1. Pinning the number, not just the
      // "restart #" prefix, is what makes a dropped or miscomputed ordinal fail here.
      expect(text).toContain("restart #1");
    });

    it("clears pendingDelegation", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("session too small"));
      await expectPendingDelegationCleared("entry-b1");
    });
  });

  describe("the 'Already compacted' variant", () => {
    it("continues WITHOUT a context reset and names the reason", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("Already compacted"));

      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("WITHOUT a context reset");
      expect(text).toContain("Already compacted");
      // O25 decision 13: the degraded path delivers the payload too, so its provenance
      // line rides along with the honest-failure header rather than being dropped. The
      // ordinal is deterministically 1: cwd is a fresh temp dir with no registered record,
      // so claimRestartOrdinal returns (0 ?? 0) + 1. Pinning the number, not just the
      // "restart #" prefix, is what makes a dropped or miscomputed ordinal fail here.
      expect(text).toContain("restart #1");
    });

    it("clears pendingDelegation", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("Already compacted"));
      await expectPendingDelegationCleared("entry-c1");
    });
  });

  describe("an unrecognised compaction error", () => {
    it("sends the explicit FAILED message, naming the underlying error", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("disk exploded"));

      const [text] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("FAILED");
      expect(text).toContain("disk exploded");
    });

    it("clears pendingDelegation", async () => {
      const { compactOptions } = await runTool();
      await compactOptions.onError(new Error("disk exploded"));
      await expectPendingDelegationCleared("entry-d1");
    });
  });

  describe("the tool's own return text (task 3.4's last unit-test clause)", () => {
    it("contains 'requested'", async () => {
      const { result } = await runTool();
      expect(result.content[0].text).toContain("requested");
    });

    it("never contains 'completed'", async () => {
      const { result } = await runTool();
      expect(result.content[0].text).not.toContain("completed");
    });
  });
});
