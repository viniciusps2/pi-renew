import { describe, it, expect } from "vitest";
import {
  type DispatchRunner,
  resolveDispatchableRestart,
  resultDetails,
  renderRestartSignal,
} from "../restart-dispatch";

/**
 * §3.1 + §3.2 pure-function unit tests. No `pi`, no disk: the `DispatchRunner`
 * interface is a pure shape, so every case here is driven with a plain object.
 *
 * The three not-dispatchable / dispatchable outcomes are each asserted with
 * their exact reason string (byte-for-byte; the first is also asserted verbatim
 * by `restart-failure.test.ts`).
 */

function makeRunner(commands: { name: string; source: string; sourceInfo?: unknown }[]): DispatchRunner {
  return {
    listCommands: () => commands as any[],
    getCommand: (name: string) => {
      const match = commands.find(c => c.name === name && c.source === "extension");
      return match as any;
    },
  };
}

describe("resolveDispatchableRestart (3.1)", () => {
  it("a consistent runner (listCommands returns a matching pi-renew, getCommand returns it) → { ok: true, name: 'pi-renew' }", () => {
    const runner = makeRunner([{ name: "pi-renew", source: "extension", sourceInfo: {} }]);
    const result = resolveDispatchableRestart(runner);
    expect(result).toEqual({ ok: true, name: "pi-renew" });
  });

  it("empty listCommands() → { ok: false, reason: 'the pi-renew command is not registered…' }", () => {
    const runner = makeRunner([]);
    const result = resolveDispatchableRestart(runner);
    expect(result).toEqual({
      ok: false,
      reason: "the pi-renew command is not registered, so no restart could be dispatched",
    });
  });

  it("a stub runner whose listCommands() yields a matching pi-renew but whose getCommand returns undefined → the 'not available on the dispatching runner' reason", () => {
    // This is the list/lookup disagreement the pure function must handle (decision 2):
    // the list says the command exists, but the lookup says it doesn't. In production
    // this arm is defensive-only (unreachable through the real runner by construction),
    // so it is proven here, not in a tool-level integration test.
    const matchingCommand = { name: "pi-renew", source: "extension", sourceInfo: {} };
    const runner: DispatchRunner = {
      listCommands: () => [matchingCommand] as any[],
      getCommand: () => undefined, // disagrees with the list
    };
    const result = resolveDispatchableRestart(runner);
    expect(result).toEqual({
      ok: false,
      reason:
        "the pi-renew command resolves by name but is not available on the dispatching runner, so no restart could be dispatched",
    });
  });
});

describe("resultDetails (3.2)", () => {
  it('resultDetails("pending") deep-equals { status: "pending" }', () => {
    expect(resultDetails("pending")).toEqual({ status: "pending" });
  });

  it('resultDetails("stand-down", { restartId: 3 }) deep-equals { status: "stand-down", restartId: 3 }', () => {
    expect(resultDetails("stand-down", { restartId: 3 })).toEqual({
      status: "stand-down",
      restartId: 3,
    });
  });

  it("is stable: calling the same input twice deep-equals", () => {
    const a = resultDetails("stand-down", { restartId: 3 });
    const b = resultDetails("stand-down", { restartId: 3 });
    expect(a).toEqual(b);
  });

  it("the set of producible statuses is exactly { 'pending', 'stand-down' } — never 'done'", () => {
    // Both valid statuses are producible:
    expect(resultDetails("pending").status).toBe("pending");
    expect(resultDetails("stand-down").status).toBe("stand-down");
    // Neither call can yield "done":
    expect((resultDetails("pending") as { status: string }).status).not.toBe("done");
    expect((resultDetails("stand-down") as { status: string }).status).not.toBe("done");
    // The type-level exclusion is the real guarantee; this is the runtime mirror.
  });
});

describe("renderRestartSignal (2.3)", () => {
  it("renderRestartSignal(false) is the ordinary 'call the renewal tool' wording", () => {
    const result = renderRestartSignal(false);
    expect(result).toContain("renew");
    expect(result).toBe("Stop work and renew the session now.");
  });

  it("renderRestartSignal(true) is the stand-down wording", () => {
    const result = renderRestartSignal(true);
    expect(result).toContain("already in progress");
    expect(result).toContain("Stand down");
  });

  it("the two outputs are not equal", () => {
    expect(renderRestartSignal(false)).not.toBe(renderRestartSignal(true));
  });

  it("is deterministic: two calls with the same input return an equal string", () => {
    expect(renderRestartSignal(false)).toBe(renderRestartSignal(false));
    expect(renderRestartSignal(true)).toBe(renderRestartSignal(true));
  });
});
