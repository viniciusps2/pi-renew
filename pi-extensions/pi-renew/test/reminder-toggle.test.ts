import { describe, it, expect, vi, beforeEach } from "vitest";
import extensionFactory from "../pi-renew";
import { CONFIG_PATH } from "../config";

/**
 * `/pi-renew-reminder-on` and `/pi-renew-reminder-off` — the session-scoped switch on
 * the high-context reminder. The config default here is `enabled: true`, so every test
 * that expects silence has to have switched it off itself.
 */
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

function getHandler(mockPi: any, eventName: string) {
  return mockPi.on.mock.calls.find((c: any) => c[0] === eventName)?.[1];
}

function getCommand(mockPi: any, name: string) {
  return mockPi.registerCommand.mock.calls.find((c: any) => c[0] === name)?.[1];
}

/** 0.575 * 200000 = 115000, so anything above that is over the threshold. */
function makeContext(tokens: number, contextWindow = 200000) {
  return {
    getContextUsage: vi.fn().mockReturnValue({
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    }),
    compact: vi.fn(),
    modelRegistry: { getAll: vi.fn().mockReturnValue([]) },
  };
}

function makeCommandContext() {
  return { ui: { notify: vi.fn() } };
}

const EVENT = { messages: [{ role: "user", content: "continue", timestamp: 1 }] };

describe("reminder toggle command registration", () => {
  let mockPi: any;

  beforeEach(() => {
    mockPi = makeMockPi();
    extensionFactory(mockPi);
  });

  it.each(["pi-renew-reminder-on", "pi-renew-reminder-off"])(
    "registers %s with a non-empty description and a callable handler",
    (name) => {
      const registered = mockPi.registerCommand.mock.calls.filter((c: any) => c[0] === name);
      expect(registered).toHaveLength(1);
      const options = registered[0][1];
      expect(typeof options.description).toBe("string");
      expect(options.description.length).toBeGreaterThan(0);
      expect(typeof options.handler).toBe("function");
    }
  );

  it("registers the toggles under names the restart command's resolver cannot claim", () => {
    // resolveRestartCommandName matches `pi-renew` and `pi-renew:<n>`; a toggle picked up
    // as the restart command would make /pi-renew dispatch a no-op instead of a restart.
    for (const name of ["pi-renew-reminder-on", "pi-renew-reminder-off"]) {
      expect(name).not.toBe("pi-renew");
      expect(name).not.toMatch(/^pi-renew:\d+$/);
    }
  });
});

describe("reminder toggle behaviour", () => {
  let mockPi: any;

  beforeEach(() => {
    mockPi = makeMockPi();
    extensionFactory(mockPi);
  });

  it("suppresses the reminder after /pi-renew-reminder-off", async () => {
    const context = getHandler(mockPi, "context");
    await getCommand(mockPi, "pi-renew-reminder-off").handler("", makeCommandContext());

    expect(await context(EVENT, makeContext(115001))).toBeUndefined();
    // Still silent a full repeat interval later — off is off, not "off for one turn".
    expect(await context(EVENT, makeContext(190000))).toBeUndefined();
  });

  it("restores the reminder after /pi-renew-reminder-on", async () => {
    const context = getHandler(mockPi, "context");
    await getCommand(mockPi, "pi-renew-reminder-off").handler("", makeCommandContext());
    await context(EVENT, makeContext(115001));
    await getCommand(mockPi, "pi-renew-reminder-on").handler("", makeCommandContext());

    const result = await context(EVENT, makeContext(115001));
    expect(result?.messages).toHaveLength(2);
    expect(result.messages[1].content).toContain("System reminder: context usage is too high");
  });

  it("re-arms the milestone tracker on /pi-renew-reminder-on, so the same milestone fires again", async () => {
    const context = getHandler(mockPi, "context");

    // The milestone at 115000 fires and is recorded.
    expect((await context(EVENT, makeContext(115001)))?.messages).toHaveLength(2);
    // Without re-arming, this would stay silent until 125000 — which reads as the `on`
    // command having done nothing.
    await getCommand(mockPi, "pi-renew-reminder-off").handler("", makeCommandContext());
    await getCommand(mockPi, "pi-renew-reminder-on").handler("", makeCommandContext());

    expect((await context(EVENT, makeContext(115001)))?.messages).toHaveLength(2);
  });

  it("stays off when /pi-renew-reminder-off is issued twice", async () => {
    const context = getHandler(mockPi, "context");
    const off = getCommand(mockPi, "pi-renew-reminder-off").handler;

    await off("", makeCommandContext());
    await off("", makeCommandContext());

    expect(await context(EVENT, makeContext(115001))).toBeUndefined();
  });

  it("scopes the switch to one session: a second extension instance starts from the config", async () => {
    await getCommand(mockPi, "pi-renew-reminder-off").handler("", makeCommandContext());

    const replacement = makeMockPi();
    extensionFactory(replacement);
    const result = await getHandler(replacement, "context")(EVENT, makeContext(115001));

    expect(result?.messages).toHaveLength(2);
  });

  it("reports the new state, its session scope and the config file it did not touch", async () => {
    const offCtx = makeCommandContext();
    await getCommand(mockPi, "pi-renew-reminder-off").handler("", offCtx);
    expect(offCtx.ui.notify).toHaveBeenCalledTimes(1);
    const [offMessage, offType] = offCtx.ui.notify.mock.calls[0];
    expect(offMessage).toContain("OFF");
    expect(offMessage).toContain("This session only");
    expect(offMessage).toContain(CONFIG_PATH);
    expect(offType).toBe("info");

    const onCtx = makeCommandContext();
    await getCommand(mockPi, "pi-renew-reminder-on").handler("", onCtx);
    const [onMessage] = onCtx.ui.notify.mock.calls[0];
    expect(onMessage).toContain("ON");
    // The threshold is worth restating: it is what "on" actually buys.
    expect(onMessage).toContain("57.5%");
    expect(onMessage).toContain("10000 tokens");
  });

  it("says so when the requested state is the one already in force", async () => {
    const first = makeCommandContext();
    const second = makeCommandContext();
    const off = getCommand(mockPi, "pi-renew-reminder-off").handler;

    await off("", first);
    await off("", second);

    expect(first.ui.notify.mock.calls[0][0]).not.toContain("already");
    expect(second.ui.notify.mock.calls[0][0]).toContain("already");
  });

  it("applies the switch even when the announcement cannot be delivered", async () => {
    // The state flip must come before ctx.ui.notify: a UI that cannot take the message is
    // no reason for the session to keep the reminder it just asked to be rid of.
    const context = getHandler(mockPi, "context");
    const ctx = {
      ui: {
        notify: vi.fn().mockImplementation(() => {
          throw new Error("ui is gone");
        }),
      },
    };

    await expect(
      getCommand(mockPi, "pi-renew-reminder-off").handler("", ctx)
    ).rejects.toThrow("ui is gone");
    expect(await context(EVENT, makeContext(115001))).toBeUndefined();
  });
});
