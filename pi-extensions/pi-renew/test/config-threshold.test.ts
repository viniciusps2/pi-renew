import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, getHighContextReminderConfig } from "../config";

// This file exercises the real loader against real files in a throwaway temp
// directory (never CONFIG_PATH, never the home directory — decision 9), so it
// deliberately does NOT mock "../config" the way context-reminder.test.ts does.

const LEGACY_WARNING =
  "pi-renew: highContextReminder.thresholdTokens is no longer supported and is ignored; use highContextReminder.thresholdFraction (a fraction of the model's context window, e.g. 0.85).";

describe("config loader: legacy thresholdTokens key", () => {
  let dir: string;
  let warnSpy: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-renew-config-threshold-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(name: string, content: unknown): string {
    const configPath = join(dir, name);
    writeFileSync(configPath, JSON.stringify(content), "utf-8");
    return configPath;
  }

  it("loads with the default fraction when only the legacy thresholdTokens key is present, and warns exactly once", () => {
    const configPath = writeConfig("legacy-only.json", {
      models: [],
      highContextReminder: { enabled: true, thresholdTokens: 113000 },
    });

    const config = loadConfig(configPath);

    expect(config.highContextReminder?.thresholdFraction).toBe(0.85);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(LEGACY_WARNING);
  });

  it("resolves to the thresholdFraction value when both keys are present, and still warns", () => {
    const configPath = writeConfig("both-keys.json", {
      models: [],
      highContextReminder: { enabled: true, thresholdTokens: 113000, thresholdFraction: 0.7 },
    });

    const config = loadConfig(configPath);

    expect(config.highContextReminder?.thresholdFraction).toBe(0.7);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(LEGACY_WARNING);
  });

  it("does not warn when thresholdTokens is absent and thresholdFraction is present", () => {
    const configPath = writeConfig("fraction-only.json", {
      models: [],
      highContextReminder: { enabled: true, thresholdFraction: 0.7 },
    });

    const config = loadConfig(configPath);

    expect(config.highContextReminder?.thresholdFraction).toBe(0.7);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when highContextReminder is absent entirely, and resolves to the default fraction", () => {
    const configPath = writeConfig("no-section.json", { models: [] });

    const config = loadConfig(configPath);

    expect(config.highContextReminder?.thresholdFraction).toBe(0.85);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("has no thresholdTokens property on the resolved config — it is no longer a supported setting", () => {
    const configPath = writeConfig("legacy-only-2.json", {
      models: [],
      highContextReminder: { enabled: true, thresholdTokens: 113000 },
    });

    const config = loadConfig(configPath);

    expect(config.highContextReminder).not.toHaveProperty("thresholdTokens");
  });
});

describe("thresholdTokens is no longer a supported config setting", () => {
  it("getHighContextReminderConfig's resolved object has no thresholdTokens key", () => {
    const resolved = getHighContextReminderConfig({ models: [] });

    expect(resolved).not.toHaveProperty("thresholdTokens");
  });
});
