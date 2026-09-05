import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import { getRenewalStatePath, readRenewalState } from "../renewal-state";

/** Task 2.3 — registration-time validation of a leading slash command. */
function getSetRenewalContextTool(mockPi: any) {
  const call = mockPi.registerTool.mock.calls.find(
    (c: any) => c[0].name === "set_renewal_context"
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

describe("set_renewal_context: registration-time validation (task 2.3)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "registration-validation-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("accepts /loop x when getCommands() includes a prompt-template 'loop'", async () => {
    const mockPi = makeMockPi([{ name: "loop", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "/loop x" }, undefined, undefined, makeCtx(cwd, "s1"))
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("/loop x");
  });

  it("accepts /skill:my-loop x when getCommands() includes a skill 'skill:my-loop'", async () => {
    const mockPi = makeMockPi([{ name: "skill:my-loop", source: "skill", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "/skill:my-loop x" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("/skill:my-loop x");
  });

  // D-H13 (O13, batch 3B): superseded by the self-referential rejection below. A context
  // that resolves to this extension's own restart command must now be REJECTED — replaying
  // it would restart forever — so this pre-3B test (which asserted the opposite) is the
  // third assertion 3B's absence sweep found invalidated, on top of the two named in its
  // brief's part B. Re-pointed rather than deleted, per the same "exactly two, report a
  // third" rule: the brief's own part E requires exactly this new behaviour to be tested.
  it("rejects /pi-renew x: it resolves to this extension's own restart command", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "/pi-renew x" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).rejects.toThrow(
      "Renewal context not registered: /pi-renew is this extension's own restart command, so replaying it would restart forever. Register the work you want replayed, not the restart itself."
    );
    expect(existsSync(getRenewalStatePath(cwd, "s1"))).toBe(false);
  });

  it("validates a context of exactly /loop, with no arguments", async () => {
    const mockPi = makeMockPi([{ name: "loop", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "/loop" }, undefined, undefined, makeCtx(cwd, "s1"))
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("/loop");
  });

  it("skips validation entirely for a context not starting with /, even when getCommands() would reject everything", async () => {
    // getCommands() returns [] — if validation ran on this non-slash context, it
    // would have nothing to resolve against and this test would fail.
    const mockPi = makeMockPi([]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "just some prose, not a command" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("just some prose, not a command");
  });

  it("rejects /nope x: the error names the command and nothing is persisted", async () => {
    const mockPi = makeMockPi([{ name: "loop", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "/nope x" }, undefined, undefined, makeCtx(cwd, "s1"))
    ).rejects.toThrow("/nope");
    expect(existsSync(getRenewalStatePath(cwd, "s1"))).toBe(false);
  });

  it("closest matches: lists names that contain, are contained by, or share a 3-char prefix with the token, and excludes unrelated names", async () => {
    const mockPi = makeMockPi([
      { name: "loop", source: "prompt", sourceInfo: {} },
      { name: "loopy", source: "prompt", sourceInfo: {} },
      { name: "skill:loop-runner", source: "skill", sourceInfo: {} },
      { name: "unrelated", source: "prompt", sourceInfo: {} },
    ]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    let message = "";
    try {
      await tool.execute("call-1", { context: "/loo x" }, undefined, undefined, makeCtx(cwd, "s1"));
      throw new Error("expected tool.execute to throw");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Closest matches: loop, loopy, skill:loop-runner.");
    expect(message).not.toContain("unrelated");
  });

  it("closest matches with no candidates reads 'Closest matches: none.'", async () => {
    const mockPi = makeMockPi([]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "/zzz x" }, undefined, undefined, makeCtx(cwd, "s1"))
    ).rejects.toThrow("Closest matches: none.");
  });

  it("rejects an empty / whitespace-only context with the empty-context message, and persists nothing", async () => {
    const mockPi = makeMockPi([]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "   \n  " }, undefined, undefined, makeCtx(cwd, "s1"))
    ).rejects.toThrow("Renewal context not registered: the context is empty.");
    expect(existsSync(getRenewalStatePath(cwd, "s1"))).toBe(false);
  });
});

/** Decision 14 (O13, batch 3B) — the self-referential rejection in full. */
describe("set_renewal_context: self-referential rejection (decision 14)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "self-referential-rejection-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects /pi-renew --after-turn foo too — the check is on the command token, not the whole string", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "/pi-renew --after-turn foo" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).rejects.toThrow(
      "Renewal context not registered: /pi-renew is this extension's own restart command, so replaying it would restart forever. Register the work you want replayed, not the restart itself."
    );
    expect(existsSync(getRenewalStatePath(cwd, "s1"))).toBe(false);
  });

  it("rejects a pi-renew:2 entry (a collision-renamed invocation name)", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew:2", source: "extension", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "/pi-renew:2 foo" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).rejects.toThrow(
      "Renewal context not registered: /pi-renew:2 is this extension's own restart command, so replaying it would restart forever. Register the work you want replayed, not the restart itself."
    );
    expect(existsSync(getRenewalStatePath(cwd, "s1"))).toBe(false);
  });

  it("accepts a prompt template also named 'pi-renew' — the rejection is scoped to extension commands", async () => {
    const mockPi = makeMockPi([{ name: "pi-renew", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute(
        "call-1",
        { context: "/pi-renew foo" },
        undefined,
        undefined,
        makeCtx(cwd, "s1")
      )
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("/pi-renew foo");
  });

  it("still accepts an unrelated command like /loop", async () => {
    const mockPi = makeMockPi([{ name: "loop", source: "prompt", sourceInfo: {} }]);
    extensionFactory(mockPi);
    const tool = getSetRenewalContextTool(mockPi);

    await expect(
      tool.execute("call-1", { context: "/loop x" }, undefined, undefined, makeCtx(cwd, "s1"))
    ).resolves.toBeDefined();
    expect(readRenewalState(cwd, "s1")!.context).toBe("/loop x");
  });
});
