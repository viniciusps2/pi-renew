import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import extensionFactory from "../pi-renew";
import { beginRestart } from "../restart-inflight";
import {
  isReportOnlySession,
  renderReportOnlyDirective,
  renderRestartSignal,
  REPORT_ONLY_ENV_VAR,
} from "../restart-dispatch";

// Same fixture threshold as context-reminder.test.ts: 0.575 * 200000 === 115000
// under Math.round, so 115001 is one token over and 114999 is one token under.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      models: [],
      highContextReminder: {
        enabled: true,
        thresholdFraction: 0.575,
        repeatEveryTokens: 10000,
      },
    }),
  };
});

function getHandler(mockPi: any, eventName: string) {
  const call = mockPi.on.mock.calls.find((c: any) => c[0] === eventName);
  return call?.[1];
}

describe("isReportOnlySession", () => {
  it("is true for the one-shot modes, which cannot restart at all", () => {
    expect(isReportOnlySession("print")).toBe(true);
    expect(isReportOnlySession("json")).toBe(true);
  });

  it("is false for the long-lived modes, where a restart really works", () => {
    expect(isReportOnlySession("tui")).toBe(false);
    expect(isReportOnlySession("rpc")).toBe(false);
  });

  it("is false when the mode is unknown — an absent mode is not evidence of a delegate", () => {
    expect(isReportOnlySession(undefined)).toBe(false);
  });

  it("is true in a long-lived mode when the launcher declares the session a delegate", () => {
    expect(isReportOnlySession("rpc", { [REPORT_ONLY_ENV_VAR]: "1" })).toBe(true);
    expect(isReportOnlySession("tui", { [REPORT_ONLY_ENV_VAR]: "yes" })).toBe(true);
  });

  // The launcher exports the variable unconditionally and flips its value per child,
  // so the falsy spellings must be real opt-OUTs — including in a one-shot mode, where
  // the caller is asserting it knows better than the mode heuristic.
  it("treats '', '0' and 'false' as an explicit opt-out that overrides the mode", () => {
    for (const value of ["", "0", "false", "FALSE", "  0  "]) {
      expect(isReportOnlySession("json", { [REPORT_ONLY_ENV_VAR]: value })).toBe(false);
      expect(isReportOnlySession("rpc", { [REPORT_ONLY_ENV_VAR]: value })).toBe(false);
    }
  });

  it("leaves the decision to the mode when the variable is absent, not merely falsy", () => {
    expect(isReportOnlySession("json", {})).toBe(true);
    expect(isReportOnlySession("rpc", {})).toBe(false);
  });
});

describe("renderReportOnlyDirective", () => {
  it("forbids both renewal tools by name and names no handover file to write", () => {
    const directive = renderReportOnlyDirective();
    expect(directive).toContain("renew_session");
    expect(directive).toContain("renew_from_handover");
    expect(directive).toContain("Do not call");
    expect(directive).toContain("There is no handover file to write");
  });

  it("asks for the five report sections a caller needs to continue the work", () => {
    const directive = renderReportOnlyDirective();
    for (const section of [
      "Stopped early",
      "Done",
      "Not done",
      "Next",
      "Context to carry over",
    ]) {
      expect(directive).toContain(section);
    }
  });

  // The failure this whole path exists to prevent is a caller that reads "report
  // written, steps 1-3 done" and believes the unit landed.
  it("requires the report to state that the work is incomplete", () => {
    expect(renderReportOnlyDirective()).toContain("INCOMPLETE");
  });
});

describe("the report-only high-context reminder", () => {
  let mockPi: any;
  let cwd: string;

  function makeContext(tokens: number, mode: string | undefined, sessionId = "s-ro") {
    return {
      mode,
      cwd,
      getContextUsage: vi.fn().mockReturnValue({
        tokens,
        contextWindow: 200000,
        percent: (tokens / 200000) * 100,
      }),
      compact: vi.fn(),
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: vi.fn().mockReturnValue(sessionId),
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ro-ctx-"));
    delete process.env[REPORT_ONLY_ENV_VAR];
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env[REPORT_ONLY_ENV_VAR];
  });

  it("tells a one-shot session to stop and report, and never mentions a renewal step", async () => {
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "context");

    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeContext(115001, "json")
    );

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(2);
    const content = result!.messages[1].content as string;

    expect(content).toContain("Stop work and end this session now");
    expect(content).toContain(renderReportOnlyDirective());
    expect(content).toContain(
      "Current estimated context: 115001 tokens of 200000 (threshold: 115000)."
    );

    // The restart variant's instructions must be entirely absent — a model given both
    // will try to satisfy both, which is the bug being fixed.
    expect(content).not.toContain("Do these steps immediately");
    expect(content).not.toContain("Call `renew_from_handover` with `handoverPath`");
    expect(content).not.toContain("Write a complete handover report to a markdown file");
    expect(content).not.toContain(renderRestartSignal(false));
  });

  it("still sends the ordinary restart reminder in a long-lived session", async () => {
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "context");

    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeContext(115001, "tui")
    );

    const content = result!.messages[1].content as string;
    expect(content).toContain("Do these steps immediately");
    expect(content).toContain("renew_from_handover");
    expect(content).not.toContain("There is no handover file to write");
  });

  it("switches a long-lived session to report-only when the launcher declares it", async () => {
    process.env[REPORT_ONLY_ENV_VAR] = "1";
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "context");

    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeContext(115001, "rpc")
    );

    const content = result!.messages[1].content as string;
    expect(content).toContain("There is no handover file to write");
    expect(content).not.toContain("Do these steps immediately");
  });

  // D-RO1: a stale in-flight record in the same cwd must not divert a report-only
  // session into standing down and waiting for a restart that can never arrive.
  it("outranks the stand-down variant when a restart record exists for this session", async () => {
    const sessionId = "s-ro-inflight";
    beginRestart(cwd, sessionId, "a stale in-flight restart", 1);
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "context");

    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeContext(115001, "json", sessionId)
    );

    const content = result!.messages[1].content as string;
    expect(content).toContain("There is no handover file to write");
    expect(content).not.toContain(renderRestartSignal(true));
    expect(content).not.toContain("Take no further action this run");
  });

  it("does not fire below the threshold in a report-only session either", async () => {
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "context");

    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeContext(114999, "json")
    );

    expect(result).toBeUndefined();
  });
});

describe("the report-only tool_call block", () => {
  let mockPi: any;

  function toolCtx(mode: string | undefined) {
    return { mode, cwd: "/tmp", sessionManager: { getSessionId: () => "s" } };
  }

  beforeEach(() => {
    delete process.env[REPORT_ONLY_ENV_VAR];
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    delete process.env[REPORT_ONLY_ENV_VAR];
  });

  it("registers a tool_call handler", () => {
    extensionFactory(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });

  it.each(["renew_session", "renew_from_handover"])(
    "blocks %s in a one-shot session and steers the model to the report",
    async (toolName) => {
      extensionFactory(mockPi);
      const handler = getHandler(mockPi, "tool_call");

      const result = await handler(
        { type: "tool_call", toolCallId: "c1", toolName, input: {} },
        toolCtx("json")
      );

      expect(result).toBeDefined();
      expect(result!.block).toBe(true);
      expect(result!.reason).toContain(`${toolName} is not available in this session`);
      expect(result!.reason).toContain(renderReportOnlyDirective());
      // Terminating the batch would end the run before the model can emit the report.
      expect(result!.terminate).toBeUndefined();
    }
  );

  it("blocks the renewal tools in a long-lived session the launcher declared a delegate", async () => {
    process.env[REPORT_ONLY_ENV_VAR] = "1";
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "tool_call");

    const result = await handler(
      { type: "tool_call", toolCallId: "c1", toolName: "renew_session", input: {} },
      toolCtx("rpc")
    );

    expect(result!.block).toBe(true);
  });

  it("does not block the renewal tools in an ordinary interactive session", async () => {
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "tool_call");

    for (const mode of ["tui", "rpc"]) {
      const result = await handler(
        { type: "tool_call", toolCallId: "c1", toolName: "renew_session", input: {} },
        toolCtx(mode)
      );
      expect(result).toBeUndefined();
    }
  });

  it("does not block any other tool, even in a one-shot session", async () => {
    extensionFactory(mockPi);
    const handler = getHandler(mockPi, "tool_call");

    for (const toolName of ["bash", "read", "edit", "set_renewal_context"]) {
      const result = await handler(
        { type: "tool_call", toolCallId: "c1", toolName, input: {} },
        toolCtx("json")
      );
      expect(result).toBeUndefined();
    }
  });
});
