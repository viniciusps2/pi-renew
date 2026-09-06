import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";

/**
 * Task 3.5 — the `--after-turn` deferral. Order is asserted via a shared call-order
 * array rather than two independent `toHaveBeenCalled`s, so a mock that happened to
 * fire in the wrong order could not still pass.
 *
 * The tool's parameter set (reason, nextSteps, summary, nextModel,
 * strategy — see decisions 2-4) has no field for requesting deferral: decision 4
 * forbids adding a `--strategy` flag to the human-typed command, and nothing in this
 * batch adds a tool-side `--after-turn` equivalent either. So the flag is reachable
 * only when a human types `/pi-renew --after-turn <reason>` directly — this file
 * therefore covers exactly the two handler-level cases the brief allows as the fallback
 * when the tool has no way to request deferral.
 */
function makeMockPi(): any {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getCommands: vi.fn().mockReturnValue([]),
  };
}

function makeCommandCtx(cwd: string, order: string[]) {
  return {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-x",
      getSessionFile: () => "/sessions/2026-08-24T00-00-00-000Z_session-x.jsonl",
    },
    waitForIdle: vi.fn().mockImplementation(async () => {
      order.push("waitForIdle");
    }),
    newSession: vi.fn().mockImplementation(async () => {
      order.push("newSession");
      return { cancelled: false };
    }),
  };
}

describe("--after-turn deferral (task 3.5)", () => {
  it("awaits ctx.waitForIdle() before ctx.newSession()", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const cwd = mkdtempSync(join(tmpdir(), "restart-after-turn-test-"));
    const order: string[] = [];
    const ctx = makeCommandCtx(cwd, order);

    try {
      await options.handler("--after-turn ran out", ctx);

      expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
      expect(ctx.newSession).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["waitForIdle", "newSession"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("without the flag, waitForIdle is never called", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const cwd = mkdtempSync(join(tmpdir(), "restart-after-turn-test-"));
    const order: string[] = [];
    const ctx = makeCommandCtx(cwd, order);

    try {
      await options.handler("ran out", ctx);

      expect(ctx.waitForIdle).not.toHaveBeenCalled();
      expect(ctx.newSession).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["newSession"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  // Caller review (batch 3B): a rejected waitForIdle used to fall through to the handler's
  // outer catch, which reports ONLY via ctx.ui.notify. The model never sees a notify — in
  // rpc/headless mode there is no UI at all — so the restart silently did not happen while
  // the model went on believing one was pending. That is exactly what the spec's "Restart
  // failures are reported" requirement forbids.
  it("a rejected waitForIdle reports the failure to the model, not only via ui.notify", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const cwd = mkdtempSync(join(tmpdir(), "restart-after-turn-test-"));
    const order: string[] = [];
    const ctx = makeCommandCtx(cwd, order);
    ctx.waitForIdle = vi.fn().mockRejectedValue(new Error("idle wait blew up"));

    try {
      await expect(options.handler("--after-turn -- ran out", ctx)).resolves.toBeUndefined();

      expect(ctx.newSession).not.toHaveBeenCalled();
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [text, options_] = mockPi.sendUserMessage.mock.calls[0];
      expect(text).toContain("restart FAILED");
      expect(text).toContain("idle wait blew up");
      expect(text).toContain("was NOT replaced");
      expect(options_).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("idle wait blew up"), "error");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The pending summary is consumed before ANY failure path can run, so a restart that
  // dies here cannot leave a stale summary attached to the next one. Asserted through the
  // only observable channel: the payload the *next* restart actually delivers.
  it("a failed deferral does not leave a stale summary for the next restart", async () => {
    const mockPi = makeMockPi();
    mockPi.getCommands = vi.fn().mockReturnValue([
      { name: "pi-renew", source: "extension", sourceInfo: {} },
    ]);
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const tool = mockPi.registerTool.mock.calls[0][0];
    const cwd = mkdtempSync(join(tmpdir(), "restart-after-turn-test-"));
    const order: string[] = [];

    try {
      // A renewal parks a summary in pendingRestart, then its deferral fails.
      await tool.execute(
        "call-1",
        {
          reason: "first",
          nextSteps: "phase one",
          summary: "STALE-SUMMARY-MARKER",
          strategy: "new-session",
        },
        undefined,
        undefined,
        {
          mode: "tui",
          compact: vi.fn(),
          getSystemPrompt: () => "",
          modelRegistry: { getAll: () => [] },
          ui: { notify: vi.fn() },
        }
      );
      const failing = makeCommandCtx(cwd, order);
      failing.waitForIdle = vi.fn().mockRejectedValue(new Error("nope"));
      await options.handler("--after-turn -- first", failing);

      // A later restart with no renewal behind it must carry no summary at all.
      const second = makeCommandCtx(cwd, order);
      await options.handler("-- second", second);

      const withSession = second.newSession.mock.calls[0][0].withSession;
      const c2: any = { sendMessage: vi.fn(), sendUserMessage: vi.fn() };
      await withSession(c2);
      const delivered = c2.sendUserMessage.mock.calls[0][0] as string;
      expect(delivered).not.toContain("STALE-SUMMARY-MARKER");
      expect(delivered).toContain("restart #1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
