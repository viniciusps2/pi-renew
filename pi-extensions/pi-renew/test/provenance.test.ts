import { describe, it, expect } from "vitest";
import { buildProvenance, assembleRestartPayload } from "../restart-payload";

/**
 * Task 3.2 — the provenance line every restart payload opens with:
 * `buildProvenance`'s format, its verbatim treatment of the reason and the
 * timestamp, and its presence inside `assembleRestartPayload`'s `prelude`
 * even when both toggles are off. Payload ordering and section gating
 * (task 3.1) are covered in `payload-assembly.test.ts`, not here.
 */

describe("buildProvenance (task 3.2)", () => {
  it("renders the ordinal as #N, matching the value passed", () => {
    const line = buildProvenance({
      ordinal: 3,
      timestamp: "2026-08-24T09:45:31.123Z",
      reason: "context usage too high",
    });
    expect(line).toBe(
      "[pi-renew restart #3 at 2026-08-24T09:45:31.123Z] reason: context usage too high",
    );
  });

  it("reproduces the reason verbatim, including unusual characters", () => {
    const reason = `has "double" and 'single' quotes, a \`backtick\`, $@, #, %, a leading /skill:x and\na newline`;
    const line = buildProvenance({
      ordinal: 1,
      timestamp: "2026-08-24T09:45:31.123Z",
      reason,
    });
    expect(line).toBe(
      `[pi-renew restart #1 at 2026-08-24T09:45:31.123Z] reason: ${reason}`,
    );
  });

  it("renders 'reason: (none given)' for an empty reason and a whitespace-only reason", () => {
    const empty = buildProvenance({ ordinal: 3, timestamp: "2026-08-24T09:45:31.123Z", reason: "" });
    const whitespace = buildProvenance({
      ordinal: 3,
      timestamp: "2026-08-24T09:45:31.123Z",
      reason: "   ",
    });
    expect(empty).toBe("[pi-renew restart #3 at 2026-08-24T09:45:31.123Z] reason: (none given)");
    expect(whitespace).toBe(
      "[pi-renew restart #3 at 2026-08-24T09:45:31.123Z] reason: (none given)",
    );
  });

  it("reproduces the timestamp verbatim and never parses it", () => {
    const line = buildProvenance({ ordinal: 12, timestamp: "NOT-A-DATE", reason: '/help "x" $@' });
    expect(line).toBe('[pi-renew restart #12 at NOT-A-DATE] reason: /help "x" $@');
  });

  it("never branches on the reason's value: three different reasons each match the same template", () => {
    const ordinal = 7;
    const timestamp = "2026-01-01T00:00:00.000Z";
    const template = (reason: string) =>
      `[pi-renew restart #${ordinal} at ${timestamp}] reason: ${reason}`;

    const reasons = [
      "restart requested manually",
      "context threshold crossed during a long tool loop",
      "/skill:loop resume after handoff",
    ];

    for (const reason of reasons) {
      expect(buildProvenance({ ordinal, timestamp, reason })).toBe(template(reason));
    }
  });

  it("is present in assembleRestartPayload's prelude even when both toggles are false and a context is registered", () => {
    const input = {
      ordinal: 4,
      timestamp: "2026-08-24T09:45:31.123Z",
      reason: "context usage too high",
      summary: "Summary text that must not appear.",
      nextSteps: "Next-steps text that must not appear.",
      context: "/loop implement tasks.md",
      includeSummary: false,
      includeNextSteps: false,
    };
    const { prelude } = assembleRestartPayload(input);
    // Asserted against the literal line, not against buildProvenance(input):
    // comparing the payload to the same function that built it moves both
    // sides together, so a buildProvenance that returned a constant would
    // still pass. Verified by mutant — see the change's handover, F30.
    expect(prelude).toBe(
      "[pi-renew restart #4 at 2026-08-24T09:45:31.123Z] reason: context usage too high",
    );
  });
});
