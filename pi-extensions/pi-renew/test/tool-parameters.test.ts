import { describe, it, expect, vi, beforeEach } from "vitest";
import extensionFactory from "../pi-renew";
import { Value } from "typebox/value";

describe("delegate_to_agent tool parameters", () => {
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

  it("should define reason parameter as required string", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.properties.reason).toBeDefined();
    expect(params.required).toContain("reason");
  });

  it("should define nextSteps parameter as required string", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.properties.nextSteps).toBeDefined();
    expect(params.required).toContain("nextSteps");
  });

  it("should define summary parameter as required string", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.properties.summary).toBeDefined();
    expect(params.required).toContain("summary");
  });

  it("should include structured summary template in parameter description", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const summaryParam = toolConfig.parameters.properties.summary;

    expect(summaryParam.description).toContain("## Goal");
    expect(summaryParam.description).toContain("## Constraints & Preferences");
    expect(summaryParam.description).toContain("## Progress");
    expect(summaryParam.description).toContain("## Key Decisions");
    expect(summaryParam.description).toContain("## Next Steps");
    expect(summaryParam.description).toContain("## Critical Context");
  });

  it("should have exactly 3 required parameters", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.required).toHaveLength(3);
    expect(params.required).toEqual(expect.arrayContaining(["reason", "nextSteps", "summary"]));
  });

  // Decision 4/5: the runtime rejects an unrecognised key via additionalProperties:false,
  // but tool.execute(...) bypasses the runtime validator entirely — asserting on execute
  // output could never prove rejection. Assert on the schema itself with the same checker
  // the runtime compiles (typebox's Value.Check), with a positive control included: without
  // it, a schema broken some other way would make the negative assertions pass for the
  // wrong reason.
  it("should reject the removed nextPhase and nextAgentPrompt parameters", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.additionalProperties).toBe(false);
    expect(Value.Check(params, { reason: "r", nextSteps: "n", summary: "s" })).toBe(true);
    expect(Value.Check(params, { reason: "r", nextSteps: "n", summary: "s", nextPhase: "p" })).toBe(false);
    expect(Value.Check(params, { reason: "r", nextSteps: "n", summary: "s", nextAgentPrompt: "x" })).toBe(false);
  });

  it("should define nextModel as optional parameter", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const params = toolConfig.parameters;

    expect(params.properties.nextModel).toBeDefined();
    expect(params.required).not.toContain("nextModel");
  });

  it("should reference the config file and alias support in nextModel description", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const nextModelParam = toolConfig.parameters.properties.nextModel;

    expect(nextModelParam.description).toContain("pi-renew.json");
    expect(nextModelParam.description).toContain("alias");
  });
});
