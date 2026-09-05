import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import extensionFactory from "../pi-renew";
import { loadConfig } from "../config";
import { beginRestart } from "../restart-inflight";
import { renderRestartSignal } from "../restart-dispatch";

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      models: [],
      highContextReminder: {
        enabled: true,
        // 0.575 * 200000 rounds to exactly 115000 under Math.round — the fraction
        // that reproduces the pre-migration fixture's threshold. See part C of
        // brief-4A: if this needed a different fraction to keep the same firing
        // points, that would mean Math.floor was used instead of Math.round.
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

// `tokens`:
//   - a number            → getContextUsage() returns a full usage object
//   - null                → getContextUsage() returns { tokens: null, contextWindow }
//                           (what the runtime returns right after compaction)
//   - undefined           → getContextUsage() itself returns undefined
//                           (no usage data available at all)
// These are two distinct absent-data paths (decision 5) and must be reachable
// separately — collapsing them into one sentinel would make it impossible to
// tell them apart in a test.
function makeContext(tokens: number | null | undefined, contextWindow = 200000) {
  return {
    getContextUsage: vi.fn().mockReturnValue(
      tokens === undefined
        ? undefined
        : tokens === null
        ? { tokens: null, contextWindow, percent: null }
        : {
            tokens,
            contextWindow,
            percent: (tokens / contextWindow) * 100,
          }
    ),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
    sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
  };
}

describe("high-context reminder injection", () => {
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

  it("should register context and session_compact handlers", () => {
    extensionFactory(mockPi);

    expect(mockPi.on).toHaveBeenCalledWith("context", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_compact", expect.any(Function));
  });

  it("should inject a reminder message after crossing the threshold", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const result = await handler(
      {
        messages: [{ role: "user", content: "continue", timestamp: 1 }],
      },
      makeContext(115001)
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toContain("Stop work and renew the session now");
    expect(result.messages[1].content).toContain("Do not inspect one more thing");
    expect(result.messages[1].content).toContain("renew_from_handover");
    expect(result.messages[1].content).toContain("Do not update task files");
    // Spec "No private artifact paths": the reminder must not invent or name a
    // temporary file path of the extension's own making.
    expect(result.messages[1].content).not.toMatch(/pi-renew-handover/);
    expect(result.messages[1].content).not.toContain(tmpdir());
    expect(result.messages[1].content).toContain(
      "Current estimated context: 115001 tokens of 200000 (threshold: 115000)."
    );
  });

  it("should not inject a reminder before the threshold", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const result = await handler(
      {
        messages: [{ role: "user", content: "continue", timestamp: 1 }],
      },
      makeContext(114999)
    );

    expect(result).toBeUndefined();
  });

  it("should only remind once per milestone and remind again after the next interval", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = {
      messages: [{ role: "user", content: "continue", timestamp: 1 }],
    };

    const first = await handler(event, makeContext(115001));
    const second = await handler(event, makeContext(124999));
    const third = await handler(event, makeContext(125000));

    expect(first?.messages).toHaveLength(2);
    expect(second).toBeUndefined();
    expect(third?.messages).toHaveLength(2);
  });

  it("should reset reminder milestones after compaction", async () => {
    extensionFactory(mockPi);

    const contextHandler = getHandler(mockPi, "context");
    const compactHandler = getHandler(mockPi, "session_compact");
    const event = {
      messages: [{ role: "user", content: "continue", timestamp: 1 }],
    };

    await contextHandler(event, makeContext(115001));
    await compactHandler(
      {
        compactionEntry: { id: "compaction-1" },
        fromExtension: false,
      },
      makeContext(null)
    );
    const afterCompact = await contextHandler(event, makeContext(115001));

    expect(afterCompact?.messages).toHaveLength(2);
  });
});

describe("high-context reminder threshold follows the live context window", () => {
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

  it("moves the firing point when contextWindow changes, with no config change", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

    // thresholdFraction is 0.575 (mocked above). Small window: threshold = round(0.575 *
    // 120000) = 69000, so 100000 tokens crosses it. Large window: threshold = round(0.575 *
    // 300000) = 172500, so the same 100000 tokens stays under it. The two windows genuinely
    // disagree on the same token count — a pair that agreed either way could not prove this.
    const smallWindow = await handler(event, makeContext(100000, 120000));
    const largeWindow = await handler(event, makeContext(100000, 300000));

    expect(smallWindow?.messages).toHaveLength(2);
    expect(largeWindow).toBeUndefined();
  });

  it("produces no reminder and does not throw when getContextUsage() returns undefined", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

    await expect(handler(event, makeContext(undefined))).resolves.toBeUndefined();
  });

  it("produces no reminder and does not throw when usage is { tokens: null, contextWindow }", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

    await expect(handler(event, makeContext(null, 200000))).resolves.toBeUndefined();
  });

  it("produces no reminder when contextWindow is zero", async () => {
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

    // A large token count that would fire under almost any positive threshold — this is
    // what makes the assertion non-vacuous: without the contextWindow <= 0 guard,
    // Math.round(fraction * 0) is 0 and 500000 > 0 would fire on every turn.
    const result = await handler(event, makeContext(500000, 0));

    expect(result).toBeUndefined();
  });
});

describe.each([
  ["0", 0],
  ["1", 1],
  ["a negative number", -0.5],
  ["a non-number", "0.5" as unknown as number],
])("thresholdFraction outside (0,1): %s", (_label, badFraction) => {
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

  it("falls back to the default fraction 0.85", async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      models: [],
      highContextReminder: {
        enabled: true,
        thresholdFraction: badFraction,
        repeatEveryTokens: 10000,
      },
    });
    extensionFactory(mockPi);

    const handler = getHandler(mockPi, "context");
    const event = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

    // Default 0.85 * 200000 (mocked contextWindow) = 170000.
    const below = await handler(event, makeContext(169999));
    const above = await handler(event, makeContext(170001));

    expect(below).toBeUndefined();
    expect(above?.messages).toHaveLength(2);
  });
});

describe("§2.3 in-flight stand-down signal in the high-context reminder", () => {
  let mockPi: any;
  let cwd: string;

  /**
   * A richer context than the base `makeContext`: it carries `cwd` (a real tmp dir) and
   * `sessionManager.getSessionId`, so the `pi.on("context")` handler can call
   * `checkRestartInFlight(ctx.cwd, sid())`.
   */
  function makeReminderCtx(tokens: number, sessionId: string, contextWindow = 200000) {
    return {
      getContextUsage: vi.fn().mockReturnValue({
        tokens,
        contextWindow,
        percent: (tokens / contextWindow) * 100,
      }),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue("You are the implement agent."),
      cwd,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: () => sessionId,
      },
      modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
    };
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "s23-ctx-"));
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
  });

  it("in-flight: the reminder contains the stand-down phrase and omits the renewal steps", async () => {
    const sessionId = "s23-inflight";
    extensionFactory(mockPi);

    // Seed an in-flight record for this session.
    beginRestart(cwd, sessionId, "the in-flight restart", 1);

    const handler = getHandler(mockPi, "context");
    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeReminderCtx(115001, sessionId)
    );

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(2);
    const content = result!.messages[1].content as string;

    // Contains the stand-down phrase:
    expect(content).toContain(renderRestartSignal(true));
    // Does NOT contain the ordinary step lines:
    expect(content).not.toContain("Do these steps immediately");
    expect(content).not.toContain("4. Call `renew_from_handover`");
  });

  it("not-in-flight: the reminder contains the ordinary renewal steps and does not contain the stand-down phrase", async () => {
    const sessionId = "s23-not-inflight";
    extensionFactory(mockPi);

    // No in-flight record seeded for this session.
    const handler = getHandler(mockPi, "context");
    const result = await handler(
      { messages: [{ role: "user", content: "continue", timestamp: 1 }] },
      makeReminderCtx(115001, sessionId)
    );

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(2);
    const content = result!.messages[1].content as string;

    // Contains the ordinary wording:
    expect(content).toContain("Do these steps immediately");
    expect(content).toContain("renew_from_handover");
    // Does NOT contain the stand-down phrase:
    expect(content).not.toContain("A restart is already in progress");
  });
});
