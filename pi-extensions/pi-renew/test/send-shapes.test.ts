import { describe, it, expect, vi } from "vitest";
import {
  RESTART_PRELUDE_CUSTOM_TYPE,
  sendExtensionCommand,
  sendPayload,
  sendRestartPrelude,
} from "../send-shapes";

/**
 * Task 3.7 — the two send shapes (command mode, payload mode) and the
 * third prelude-delivery helper, plus the thenable-catching contract shared
 * by all three: never `await`, never let a rejection escape unhandled.
 */

function makeSender() {
  return { sendUserMessage: vi.fn() };
}

function makeCustomSender() {
  return { sendMessage: vi.fn() };
}

describe("sendExtensionCommand (task 3.7, command mode)", () => {
  it("sets the options object to exactly { expandPromptTemplates: true }, never deliverAs", () => {
    const sender = makeSender();
    sendExtensionCommand(sender, "/pi-renew restart now");

    expect(sender.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendUserMessage.mock.calls[0][0]).toBe("/pi-renew restart now");
    expect(sender.sendUserMessage.mock.calls[0][1]).toEqual({ expandPromptTemplates: true });
  });

  it("throws the exact message when the string has no leading slash, and calls sendUserMessage nothing", () => {
    const sender = makeSender();
    expect(() => sendExtensionCommand(sender, "pi-renew restart now")).toThrow(
      "sendExtensionCommand requires a leading slash: an extension command must start with '/'.",
    );
    expect(sender.sendUserMessage).not.toHaveBeenCalled();
  });

  it("a sender whose method returns a rejecting promise does not produce an unhandled rejection, and onError receives it", async () => {
    const rejection = new Error("command-send-failed");
    const sender = { sendUserMessage: vi.fn().mockReturnValue(Promise.reject(rejection)) };
    const onError = vi.fn();

    expect(() => sendExtensionCommand(sender, "/pi-renew", onError)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(rejection);
  });
});

describe("sendPayload (task 3.7, payload mode)", () => {
  it("sets the options object to exactly { expandPromptTemplates: true, deliverAs: 'followUp' }", () => {
    const sender = makeSender();
    sendPayload(sender, "Ordinary payload text.");

    expect(sender.sendUserMessage.mock.calls[0][1]).toEqual({
      expandPromptTemplates: true,
      deliverAs: "followUp",
    });
  });

  it("sends a /skill:-shaped payload in payload mode too, with both options and content unmodified", () => {
    const sender = makeSender();
    const payload = "/skill:my-loop .pi/loop/handover.md";
    sendPayload(sender, payload);

    expect(sender.sendUserMessage.mock.calls[0][0]).toBe(payload);
    expect(sender.sendUserMessage.mock.calls[0][1]).toEqual({
      expandPromptTemplates: true,
      deliverAs: "followUp",
    });
  });

  it("a sender whose method returns undefined (the ExtensionAPI shape) is handled with no throw", () => {
    const sender = { sendUserMessage: vi.fn().mockReturnValue(undefined) };
    expect(() => sendPayload(sender, "payload text")).not.toThrow();
  });

  it("a sender whose method returns a rejecting promise does not produce an unhandled rejection, and onError receives it", async () => {
    const rejection = new Error("payload-send-failed");
    const sender = { sendUserMessage: vi.fn().mockReturnValue(Promise.reject(rejection)) };
    const onError = vi.fn();

    expect(() => sendPayload(sender, "payload text", onError)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(rejection);
  });
});

describe("sendRestartPrelude (task 3.7, D-H7 prelude delivery)", () => {
  it("calls sendMessage with the custom-type prelude message and { triggerTurn: false }", () => {
    const sender = makeCustomSender();
    const prelude = "[pi-renew restart #1 at 2026-08-24T00:00:00.000Z] reason: none given";
    sendRestartPrelude(sender, prelude);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    // The customType is asserted as a literal, not as RESTART_PRELUDE_CUSTOM_TYPE:
    // asserting against the imported constant moves both sides together, so
    // editing the constant would leave this green. It is an identity string a
    // consumer keys on, so it is pinned twice — here and below.
    expect(sender.sendMessage.mock.calls[0][0]).toEqual({
      customType: "pi-renew-restart",
      content: prelude,
      display: true,
    });
    expect(sender.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });
  });

  it("exports RESTART_PRELUDE_CUSTOM_TYPE as exactly 'pi-renew-restart'", () => {
    expect(RESTART_PRELUDE_CUSTOM_TYPE).toBe("pi-renew-restart");
  });

  it("a sender whose method returns a rejecting promise does not produce an unhandled rejection, and onError receives it", async () => {
    const rejection = new Error("prelude-send-failed");
    const sender = { sendMessage: vi.fn().mockReturnValue(Promise.reject(rejection)) };
    const onError = vi.fn();

    expect(() => sendRestartPrelude(sender, "prelude text", onError)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(rejection);
  });
});

describe("all three helpers with no onError (task 3.7, the swallow branch)", () => {
  // The `onError ?? (() => {})` fallback is load-bearing and is the one branch
  // the per-helper tests above never reach: `.catch(undefined)` does NOT mark a
  // promise handled — it returns a fresh rejected promise nobody is watching —
  // so dropping the no-op default would let a send failure crash the pi process.
  // Detected by listening for the event Node would otherwise use to report it.
  it("swallows a rejection when no onError is given, so nothing escapes unhandled", async () => {
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", listener);

    try {
      sendExtensionCommand(
        { sendUserMessage: vi.fn().mockReturnValue(Promise.reject(new Error("command"))) },
        "/pi-renew",
      );
      sendPayload(
        { sendUserMessage: vi.fn().mockReturnValue(Promise.reject(new Error("payload"))) },
        "payload text",
      );
      sendRestartPrelude(
        { sendMessage: vi.fn().mockReturnValue(Promise.reject(new Error("prelude"))) },
        "prelude text",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", listener);
    }

    expect(escaped).toEqual([]);
  });
});
