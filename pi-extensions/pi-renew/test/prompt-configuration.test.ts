import { describe, it, expect, vi, beforeEach } from "vitest";
import extensionFactory from "../pi-renew";

describe("tool prompt configuration", () => {
  let mockPi: any;

  beforeEach(() => {
    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
    };
  });

  it("should have descriptive label", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    
    expect(toolConfig.label).toBe("Delegate to Another Agent");
  });

  it("should have comprehensive description", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];

    expect(toolConfig.description).toContain("Delegate to another agent");
    expect(toolConfig.description).toContain("No LLM review");
    expect(toolConfig.description).toContain("/compact is unaffected");
  });

  it("should have promptSnippet for trigger phrases", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];

    expect(toolConfig.promptSnippet).toContain('"clean context"');
    expect(toolConfig.promptSnippet).toContain('"reset context"');
  });

  it("should have promptGuidelines array", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];

    expect(Array.isArray(toolConfig.promptGuidelines)).toBe(true);
    expect(toolConfig.promptGuidelines).toHaveLength(5);
  });

  it("should include guideline about ALWAYS calling delegate_to_agent", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const guidelines = toolConfig.promptGuidelines;

    expect(guidelines[0]).toContain("ALWAYS call delegate_to_agent");
  });

  it("should include guideline about proactive phase transitions", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const guidelines = toolConfig.promptGuidelines;

    expect(guidelines[1]).toContain("Proactively");
    expect(guidelines[1]).toContain("transition to a different agent");
  });

  it("should include guideline about being thorough in summary", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const guidelines = toolConfig.promptGuidelines;

    expect(guidelines[2]).toContain("thorough");
    expect(guidelines[2]).toContain("ONLY context the next agent will have");
  });

  it("should include guideline about /compact not being affected", () => {
    extensionFactory(mockPi);

    const toolConfig = mockPi.registerTool.mock.calls[0][0];
    const guidelines = toolConfig.promptGuidelines;

    expect(guidelines[4]).toContain("/compact");
    expect(guidelines[4]).toContain("NOT affected");
  });
});
