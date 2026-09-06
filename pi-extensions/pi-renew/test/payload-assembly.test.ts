import { describe, it, expect } from "vitest";
import { assembleRestartPayload } from "../restart-payload";

/**
 * Task 3.1 — restart payload assembly: section ordering, toggle gating,
 * absence rules, whitespace trimming, and the D-H7 property that the
 * renewal context never leaks into `prelude`. Provenance's own format is
 * covered in `provenance.test.ts`, not here.
 *
 * Fixture strings below are chosen mutually distinct and individually
 * recognisable (reason / summary / next-steps / context never share text)
 * so an ordering bug and a duplication bug cannot pass the same assertion.
 */

const REASON = "context usage crossed the configured threshold";
const SUMMARY = "Investigated the flaky auth test and found the race condition.";
const NEXT_STEPS = "Add a retry guard around the token refresh call.";
const CONTEXT = "Continue reviewing the open pull requests for regressions.";
const SLASH_CONTEXT = "/loop implement tasks.md";

describe("assembleRestartPayload (task 3.1)", () => {
  it("assembles all four sections, in order: provenance, summary, next steps, context", () => {
    const result = assembleRestartPayload({
      ordinal: 2,
      timestamp: "2026-08-24T09:45:31.123Z",
      reason: "context usage too high",
      summary: "Did A and B.",
      nextSteps: "Do C.",
      context: "/loop implement tasks.md",
      includeSummary: true,
      includeNextSteps: true,
    });

    expect(result).toEqual({
      prelude:
        "[pi-renew restart #2 at 2026-08-24T09:45:31.123Z] reason: context usage too high\n\n" +
        "## Summary\n\nDid A and B.\n\n" +
        "## Next steps\n\nDo C.",
      context: "/loop implement tasks.md",
    });
  });

  it("includeSummary: false omits only the summary", () => {
    const result = assembleRestartPayload({
      ordinal: 4,
      timestamp: "2026-03-01T10:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      context: CONTEXT,
      includeSummary: false,
      includeNextSteps: true,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #4 at 2026-03-01T10:00:00.000Z] reason: ${REASON}\n\n` +
        `## Next steps\n\n${NEXT_STEPS}`,
      context: CONTEXT,
    });
  });

  it("includeNextSteps: false omits only next steps", () => {
    const result = assembleRestartPayload({
      ordinal: 4,
      timestamp: "2026-03-01T10:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      context: CONTEXT,
      includeSummary: true,
      includeNextSteps: false,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #4 at 2026-03-01T10:00:00.000Z] reason: ${REASON}\n\n` +
        `## Summary\n\n${SUMMARY}`,
      context: CONTEXT,
    });
  });

  it("both toggles false with a context registered leaves prelude equal to the provenance line alone", () => {
    const result = assembleRestartPayload({
      ordinal: 6,
      timestamp: "2026-03-02T00:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      context: CONTEXT,
      includeSummary: false,
      includeNextSteps: false,
    });

    expect(result).toEqual({
      prelude: `[pi-renew restart #6 at 2026-03-02T00:00:00.000Z] reason: ${REASON}`,
      context: CONTEXT,
    });
  });

  it("no registered context forces both toggles on even when passed false, and context is null", () => {
    const result = assembleRestartPayload({
      ordinal: 8,
      timestamp: "2026-03-03T00:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      includeSummary: false,
      includeNextSteps: false,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #8 at 2026-03-03T00:00:00.000Z] reason: ${REASON}\n\n` +
        `## Summary\n\n${SUMMARY}\n\n` +
        `## Next steps\n\n${NEXT_STEPS}`,
      context: null,
    });
  });

  it("an empty summary string produces no ## Summary header and no stray blank block", () => {
    const result = assembleRestartPayload({
      ordinal: 9,
      timestamp: "2026-03-04T00:00:00.000Z",
      reason: REASON,
      summary: "",
      nextSteps: NEXT_STEPS,
      context: CONTEXT,
      includeSummary: true,
      includeNextSteps: true,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #9 at 2026-03-04T00:00:00.000Z] reason: ${REASON}\n\n` +
        `## Next steps\n\n${NEXT_STEPS}`,
      context: CONTEXT,
    });
    expect(result.prelude).not.toContain("\n\n\n");
  });

  it("a whitespace-only context counts as absent: context is null and the toggles are forced on", () => {
    const result = assembleRestartPayload({
      ordinal: 10,
      timestamp: "2026-03-05T00:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      context: "   ",
      includeSummary: false,
      includeNextSteps: false,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #10 at 2026-03-05T00:00:00.000Z] reason: ${REASON}\n\n` +
        `## Summary\n\n${SUMMARY}\n\n` +
        `## Next steps\n\n${NEXT_STEPS}`,
      context: null,
    });
  });

  it("the context never appears in prelude, including when it is a slash command", () => {
    const result = assembleRestartPayload({
      ordinal: 11,
      timestamp: "2026-03-06T00:00:00.000Z",
      reason: REASON,
      summary: SUMMARY,
      nextSteps: NEXT_STEPS,
      context: SLASH_CONTEXT,
      includeSummary: true,
      includeNextSteps: true,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #11 at 2026-03-06T00:00:00.000Z] reason: ${REASON}\n\n` +
        `## Summary\n\n${SUMMARY}\n\n` +
        `## Next steps\n\n${NEXT_STEPS}`,
      context: SLASH_CONTEXT,
    });
    expect(result.prelude).not.toContain("/loop");
  });

  it("trims leading and trailing whitespace from summary, next steps and context, preserving interior blank lines", () => {
    const summary = "  Line one.\n\nLine two.  ";
    const nextSteps = "\tStep one.\n\nStep two.\t";
    const context = "  Registered context one.\n\nRegistered context two.  ";

    const result = assembleRestartPayload({
      ordinal: 9,
      timestamp: "2026-04-01T00:00:00.000Z",
      reason: REASON,
      summary,
      nextSteps,
      context,
      includeSummary: true,
      includeNextSteps: true,
    });

    expect(result).toEqual({
      prelude:
        `[pi-renew restart #9 at 2026-04-01T00:00:00.000Z] reason: ${REASON}\n\n` +
        "## Summary\n\nLine one.\n\nLine two.\n\n" +
        "## Next steps\n\nStep one.\n\nStep two.",
      context: "Registered context one.\n\nRegistered context two.",
    });
  });
});
