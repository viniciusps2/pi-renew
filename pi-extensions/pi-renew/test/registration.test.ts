import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import {
  DELEGATE_STATE_VERSION,
  getDelegateStatePath,
  readDelegateState,
  writeDelegateState,
} from "../delegate-state";

/**
 * Task 2.2 — registering a delegate context via the `set_delegate_context`
 * tool. This file selects the tool by name (not by `registerTool` call
 * index): it is a new file, unaffected by the existing suite's index-based
 * assertions, and selecting by name is more robust regardless.
 */
function getSetDelegateContextTool(mockPi: any) {
  const call = mockPi.registerTool.mock.calls.find(
    (c: any) => c[0].name === "set_delegate_context"
  );
  return call?.[0];
}

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

function makeCtx(cwd: string, sessionId: string) {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

describe("set_delegate_context: registration (task 2.2)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "registration-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // F12: several existing test files reach the tool under test by registerTool call
  // index rather than by name, so the two pre-existing tools must keep indices 0 and 1.
  // Asserted here explicitly: without it, inserting a tool earlier fails ~20 assertions
  // across five files with confusing errors instead of one that names the constraint.
  it("registers set_delegate_context third, leaving delegate_to_agent at index 0 and delegate_context_high at index 1", () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);

    const names = mockPi.registerTool.mock.calls.map((c: any) => c[0].name);
    expect(names).toEqual([
      "delegate_to_agent",
      "delegate_context_high",
      "set_delegate_context",
    ]);
    expect(mockPi.registerTool.mock.calls[2][0].label).toBe("Set Delegate Context");
  });

  it("stores the context verbatim, byte-for-byte, including leading/trailing whitespace and interior newlines", async () => {
    // Trimmed, this fixture starts with "/loop", so getCommands() must resolve it —
    // the point is to prove the *stored* value is untouched even though a slash
    // command triggers validation against the trimmed form.
    const context = "  \n/loop implement tasks.md\n  trailing  \n";
    const mockPi = makeMockPi([{ name: "loop", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetDelegateContextTool(mockPi);

    await tool.execute("call-1", { context }, undefined, undefined, makeCtx(cwd, "session-a"));

    expect(readDelegateState(cwd, "session-a")!.context).toBe(context);
  });

  it("defaults omitted toggles to true, and honours explicit false independently per toggle", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getSetDelegateContextTool(mockPi);

    await tool.execute(
      "call-1",
      { context: "plain prose" },
      undefined,
      undefined,
      makeCtx(cwd, "session-defaults")
    );
    expect(readDelegateState(cwd, "session-defaults")).toMatchObject({
      includeSummary: true,
      includeNextSteps: true,
    });

    // includeSummary and includeNextSteps deliberately differ here, so a bug that
    // ties them to one shared variable would fail this assertion.
    await tool.execute(
      "call-2",
      { context: "plain prose", includeSummary: false, includeNextSteps: true },
      undefined,
      undefined,
      makeCtx(cwd, "session-mixed")
    );
    expect(readDelegateState(cwd, "session-mixed")).toMatchObject({
      includeSummary: false,
      includeNextSteps: true,
    });
  });

  it("resets restartCount to 0 on registration, including when re-registering over a non-zero value", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getSetDelegateContextTool(mockPi);
    const ctx = makeCtx(cwd, "session-restart");

    await tool.execute("call-1", { context: "first" }, undefined, undefined, ctx);
    expect(readDelegateState(cwd, "session-restart")!.restartCount).toBe(0);

    writeDelegateState(cwd, "session-restart", {
      version: DELEGATE_STATE_VERSION,
      context: "first",
      includeSummary: true,
      includeNextSteps: true,
      restartCount: 7,
      registeredAt: "2026-08-08T19:00:00.000Z",
    });
    expect(readDelegateState(cwd, "session-restart")!.restartCount).toBe(7);

    await tool.execute("call-2", { context: "second" }, undefined, undefined, ctx);
    expect(readDelegateState(cwd, "session-restart")!.restartCount).toBe(0);
  });

  it("registeredAt parses as a valid ISO-8601 date", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getSetDelegateContextTool(mockPi);

    await tool.execute(
      "call-1",
      { context: "prose" },
      undefined,
      undefined,
      makeCtx(cwd, "session-date")
    );
    const state = readDelegateState(cwd, "session-date");
    expect(Number.isNaN(Date.parse(state!.registeredAt))).toBe(false);
  });

  it("does not parse the context's words: 'no summary' and 'skip next steps' leave both toggles true", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const tool = getSetDelegateContextTool(mockPi);

    await tool.execute(
      "call-1",
      { context: "Please do this with no summary and skip next steps entirely." },
      undefined,
      undefined,
      makeCtx(cwd, "session-prose")
    );
    const state = readDelegateState(cwd, "session-prose");
    expect(state!.includeSummary).toBe(true);
    expect(state!.includeNextSteps).toBe(true);
  });

  it("keeps two session ids in one cwd fully independent: neither read shows the other's context", async () => {
    const mockPiA = makeMockPi();
    extensionFactory(mockPiA);
    await getSetDelegateContextTool(mockPiA).execute(
      "call-1",
      { context: "context for A" },
      undefined,
      undefined,
      makeCtx(cwd, "session-x")
    );

    const mockPiB = makeMockPi();
    extensionFactory(mockPiB);
    await getSetDelegateContextTool(mockPiB).execute(
      "call-1",
      { context: "context for B" },
      undefined,
      undefined,
      makeCtx(cwd, "session-y")
    );

    expect(readDelegateState(cwd, "session-x")!.context).toBe("context for A");
    expect(readDelegateState(cwd, "session-y")!.context).toBe("context for B");
    expect(getDelegateStatePath(cwd, "session-x")).not.toBe(getDelegateStatePath(cwd, "session-y"));
  });
});
