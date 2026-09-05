import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory from "../pi-renew";
import { RENEWAL_STATE_VERSION, writeRenewalState } from "../renewal-state";

function getTool(mockPi: any, toolName: string) {
  return mockPi.registerTool.mock.calls
    .map((call: any) => call[0])
    .find((tool: any) => tool.name === toolName);
}

function makeMockCtx(entries: any[] = []) {
  return {
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
    sessionManager: { getEntries: vi.fn().mockReturnValue(entries) },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    // O26: renew_from_handover now passes strategy: "new-session" explicitly, so its
    // executeRenewal call takes the new-session branch, which reports a failed dispatch
    // through ctx.ui.notify (reportRestartFailure). The happy-path tests below never reach
    // that branch (mockPi.getCommands resolves "pi-renew"), but the ctx type requires it.
    ui: { notify: vi.fn() },
  };
}

// restart-newsession.test.ts's harness, copied per the brief (decision 23 forbids a shared
// test/helpers.ts — every file duplicates its own fixtures on purpose): drives the
// /pi-renew command handler directly with a fake ReplacedSessionContext so the delivered
// payload can be inspected, since this mocked suite never runs a real getCommands()-resolved
// dispatch through to a real command handler.
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

// This file no longer mocks ../config: unlike the pre-4.4 version, none of these
// tests need the high-context reminder to fire at all. The handover path now comes
// from the caller (the test), never from the reminder, so loadConfig()'s real
// threshold is irrelevant here. See brief-4B decision 12.
describe("renew_from_handover tool", () => {
  let mockPi: any;
  let cwd: string;

  beforeEach(() => {
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      // O26: renew_from_handover's executeRenewal call now takes the new-session
      // branch (strategy: "new-session"), which resolves its dispatch target through
      // pi.getCommands(). Without this, resolveRestartCommandName finds nothing, the tool
      // takes the reportRestartFailure branch, and every assertion below would silently be
      // testing the failure path instead of the real one (see the brief's note on this file).
      getCommands: vi.fn().mockReturnValue([{ name: "pi-renew", source: "extension", sourceInfo: {} }]),
    };
    cwd = mkdtempSync(join(tmpdir(), "high-context-renewal-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("declares handoverPath as a required parameter", () => {
    extensionFactory(mockPi);

    const tool = getTool(mockPi, "renew_from_handover");

    expect(tool.parameters.properties.handoverPath).toBeDefined();
    expect(tool.parameters.required).toContain("handoverPath");
  });

  it("fails with a clear message when no location is supplied", async () => {
    extensionFactory(mockPi);

    const tool = getTool(mockPi, "renew_from_handover");

    let error: Error | undefined;
    try {
      await tool.execute("tool-call-id", {}, undefined, undefined, makeMockCtx());
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("handoverPath");
    expect(error!.message).toContain("does not generate or default a handover location");
  });

  it("fails naming the caller-supplied path when the file does not exist", async () => {
    extensionFactory(mockPi);

    const tool = getTool(mockPi, "renew_from_handover");
    const handoverPath = join(cwd, "never-written.md");

    await expect(
      tool.execute(
        "tool-call-id",
        { handoverPath },
        undefined,
        undefined,
        makeMockCtx()
      )
    ).rejects.toThrow(handoverPath);
  });

  it("fails when the caller-supplied file exists but is empty", async () => {
    extensionFactory(mockPi);

    const tool = getTool(mockPi, "renew_from_handover");
    const handoverPath = join(cwd, "empty-handover.md");
    writeFileSync(handoverPath, "   \n", "utf-8");

    await expect(
      tool.execute(
        "tool-call-id",
        { handoverPath },
        undefined,
        undefined,
        makeMockCtx()
      )
    ).rejects.toThrow("file is empty");
  });

  // O26: `renew_from_handover` passes strategy: "new-session" explicitly — a strategy
  // choice, not a bug fix, stated as such at its own call site. Once O25 lands, this path
  // replays the renewal context on its own under `compact` too; it is set to `new-session`
  // because both strategies reset the context but `new-session` additionally records
  // lineage via `parentSession` and produces a clean session file — the more useful
  // post-mortem artifact for the failure this path exists to handle, a session that ran out
  // of context window.
  it("dispatches the restart command via new-session, never calling ctx.compact", async () => {
    extensionFactory(mockPi);

    const tool = getTool(mockPi, "renew_from_handover");
    const handoverPath = join(cwd, "handover.md");
    writeFileSync(handoverPath, "## Goal\nSomething to hand off", "utf-8");
    const mockCtx = makeMockCtx();

    await tool.execute("tool-call-id", { handoverPath }, undefined, undefined, mockCtx);

    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [dispatched, options] = mockPi.sendUserMessage.mock.calls[0];
    expect(dispatched).toBe("/pi-renew -- context usage too high");
    expect(options).toEqual({ expandPromptTemplates: true });
    expect(mockCtx.compact).not.toHaveBeenCalled();
  });

  // Rewritten port of the pre-O26 test "reads the caller-supplied report, appends last task
  // files, and renews" (brief decision 20, second row). Under the old `compact` default
  // that test read session_before_compact's returned compaction.summary directly. Under
  // `new-session`, pendingRenewal is never set, so session_before_compact returns
  // undefined and that read would throw — invalidated, not by a content change, but by the
  // strategy switch. Every one of the four original content assertions, plus the negative
  // "no persona line" assertion, is ported onto the prelude actually delivered by the
  // /pi-renew command handler instead.
  it("delivers the handover content — last-tasks-read tag, both task paths, no persona line — in the restart prelude", async () => {
    extensionFactory(mockPi);

    const sessionId = "high-context-command-session";
    const tool = getTool(mockPi, "renew_from_handover");
    const handoverPath = join(cwd, "handover.md");
    writeFileSync(
      handoverPath,
      "## Goal\nContinue implementation\n\n## Progress\n- Finished most of the wiring",
      "utf-8"
    );

    const mockCtx = makeMockCtx([
      { role: "assistant", content: "read ~/.pi/agent/prompts/planner.md" },
      { role: "assistant", content: "view /repo/docs/planning/auth/task-01.md" },
      { role: "assistant", content: "apply_patch /repo/docs/planning/auth/task-02.md" },
    ]);

    const result = await tool.execute(
      "tool-call-id",
      { handoverPath },
      undefined,
      undefined,
      mockCtx
    );

    expect(result.content[0].text).toContain(`Continue from the handover report at ${handoverPath}`);

    // No renewal context is registered under sessionId, so the whole prelude — including
    // the handover-derived summary — is delivered as the sole sendUserMessage on c2
    // (decision 19's common case: assembleRestartPayload forces both toggles true when no
    // context is registered, which is the path most users are actually on).
    const order: string[] = [];
    const c2 = makeReplacedSessionCtx(order);
    const commandCtx = makeCommandCtx(cwd, sessionId, c2);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;

    await handler("context usage too high", commandCtx);

    expect(c2.sendMessage).not.toHaveBeenCalled();
    expect(c2.sendUserMessage).toHaveBeenCalledTimes(1);
    const [prelude] = c2.sendUserMessage.mock.calls[0];

    expect(prelude).toContain("Continue implementation");
    expect(prelude).toContain("<last_tasks_read>");
    expect(prelude).toContain("/repo/docs/planning/auth/task-01.md");
    expect(prelude).toContain("/repo/docs/planning/auth/task-02.md");
    // Spec "No workflow coupling": the summary must not name a persona even though the
    // transcript still mentions a prompt file — nothing in the surviving code path injects
    // "Load the agent prompt".
    expect(prelude).not.toContain("Load the agent prompt");
  });

  // Task 5.3's branch: with a renewal context registered under the command handler's own
  // session id, that context must reach the fresh session as its own message. Nothing
  // reached this today — O26 is what makes `renew_from_handover` dispatch a restart at
  // all, so this is the first coverage that closes the loop end to end: the tool dispatches,
  // then the command handler it dispatches to delivers the registered context.
  it("delivers a registered renewal context as the second message", async () => {
    extensionFactory(mockPi);

    const sessionId = "high-context-registered-context-session";
    const registeredContext = "the renewal context registered for the high-context handoff";
    writeRenewalState(cwd, sessionId, {
      version: RENEWAL_STATE_VERSION,
      context: registeredContext,
      includeSummary: true,
      includeNextSteps: true,
      restartCount: 0,
      registeredAt: new Date().toISOString(),
    });

    const tool = getTool(mockPi, "renew_from_handover");
    const handoverPath = join(cwd, "handover-with-context.md");
    writeFileSync(handoverPath, "## Goal\nHandoff body for the registered-context case", "utf-8");
    await tool.execute("tool-call-id", { handoverPath }, undefined, undefined, makeMockCtx());

    const order: string[] = [];
    const c2 = makeReplacedSessionCtx(order);
    const commandCtx = makeCommandCtx(cwd, sessionId, c2);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;

    await handler("context usage too high", commandCtx);

    expect(c2.sendMessage).toHaveBeenCalledTimes(1);
    expect(c2.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(c2.sendUserMessage).toHaveBeenCalledWith(registeredContext, {
      expandPromptTemplates: true,
      deliverAs: "followUp",
    });
    expect(order).toEqual(["sendMessage", "sendUserMessage"]);
  });
});
