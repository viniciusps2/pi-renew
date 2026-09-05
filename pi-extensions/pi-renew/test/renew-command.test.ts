import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extensionFactory from "../pi-renew";
import { parseRenewCommandArgs } from "../renewal-context";

/** Task 2.4 — the `/pi-renew` command: registration and flag parsing. */
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

describe("pi-renew command registration (task 2.4)", () => {
  it("registers 'pi-renew' once, with a non-empty description and a callable handler", () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);

    expect(mockPi.registerCommand).toHaveBeenCalledTimes(1);
    const [name, options] = mockPi.registerCommand.mock.calls[0];
    expect(name).toBe("pi-renew");
    expect(typeof options.description).toBe("string");
    expect(options.description.length).toBeGreaterThan(0);
    expect(typeof options.handler).toBe("function");
  });
});

describe("parseRenewCommandArgs (task 2.4)", () => {
  it("parses and strips a leading --after-turn flag", () => {
    expect(parseRenewCommandArgs("--after-turn ran out of context")).toEqual({
      afterTurn: true,
      rest: "ran out of context",
    });
  });

  it("defaults afterTurn to false with no flag", () => {
    expect(parseRenewCommandArgs("ran out of context")).toEqual({
      afterTurn: false,
      rest: "ran out of context",
    });
  });

  it("handles an empty string", () => {
    expect(parseRenewCommandArgs("")).toEqual({ afterTurn: false, rest: "" });
  });

  it("throws on an unknown leading flag, naming the flag", () => {
    expect(() => parseRenewCommandArgs("--bogus x")).toThrow("--bogus");
  });

  it("treats a --after-turn appearing after payload text as payload, not a flag", () => {
    expect(parseRenewCommandArgs("restart now --after-turn")).toEqual({
      afterTurn: false,
      rest: "restart now --after-turn",
    });
  });

  // Decision 13: the `--` end-of-flags marker. The tool always emits it (`/pi-renew --
  // <reason>` or `/pi-renew --after-turn -- <reason>`) so an ordinary reason string that
  // happens to start with `--` is never mistaken for a flag.
  it("-- --rerun after failure: the marker is consumed and everything after it is rest, even a --looking token", () => {
    expect(parseRenewCommandArgs("-- --rerun after failure")).toEqual({
      afterTurn: false,
      rest: "--rerun after failure",
    });
  });

  it("--after-turn -- x: both the flag and the marker are consumed", () => {
    expect(parseRenewCommandArgs("--after-turn -- x")).toEqual({
      afterTurn: true,
      rest: "x",
    });
  });

  it("a bare -- with nothing after it yields an empty rest", () => {
    expect(parseRenewCommandArgs("--")).toEqual({ afterTurn: false, rest: "" });
  });
});

describe("registered pi-renew command handler (task 2.4)", () => {
  it("swallows a parse failure and reports it via ctx.ui.notify, without rejecting", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    await expect(options.handler("--bogus x", ctx)).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("--bogus"), "error");
  });

  it("calls ctx.newSession once, with the current session file as parentSession and a withSession callback (task 3.3)", async () => {
    const mockPi = makeMockPi();
    extensionFactory(mockPi);
    const [, options] = mockPi.registerCommand.mock.calls[0];
    const notify = vi.fn();
    const newSession = vi.fn().mockResolvedValue({ cancelled: false });
    const cwd = mkdtempSync(join(tmpdir(), "renew-command-test-"));
    const ctx = {
      cwd,
      ui: { notify },
      sessionManager: {
        getSessionId: () => "session-x",
        getSessionFile: () => "/sessions/2026-08-24T00-00-00-000Z_session-x.jsonl",
      },
      waitForIdle: vi.fn(),
      newSession,
    };

    try {
      await expect(options.handler("--after-turn ran out", ctx)).resolves.toBeUndefined();

      expect(newSession).toHaveBeenCalledTimes(1);
      const callArgs = newSession.mock.calls[0][0];
      expect(callArgs.parentSession).toBe("/sessions/2026-08-24T00-00-00-000Z_session-x.jsonl");
      expect(typeof callArgs.withSession).toBe("function");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
