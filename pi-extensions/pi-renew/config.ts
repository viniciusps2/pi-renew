import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * A model entry in pi-renew.json.
 * `id` is the exact model ID used by Pi (e.g. "Q3.5-27B").
 * `names` are human-friendly aliases that agents or users can refer to
 * when setting nextModel (e.g. "coding", "reviewer").
 */
export interface ModelAlias {
  id: string;
  names: string[];
}

export interface HighContextReminderConfig {
  enabled?: boolean;
  thresholdFraction?: number;
  repeatEveryTokens?: number;
}

export interface ResolvedHighContextReminderConfig {
  enabled: boolean;
  thresholdFraction: number;
  repeatEveryTokens: number;
}

export interface PiRenewConfig {
  models: ModelAlias[];
  highContextReminder?: HighContextReminderConfig;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-renew.json");
export const DEFAULT_HIGH_CONTEXT_REMINDER_CONFIG: ResolvedHighContextReminderConfig = {
  enabled: true,
  thresholdFraction: 0.85,
  repeatEveryTokens: 1000,
};

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

// Open interval (0, 1): a threshold at the whole window can never fire before
// pi's own auto-compaction, and 0 would fire on every turn — neither is a
// value a caller can have meant.
function normalizeFraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : fallback;
}

export function getHighContextReminderConfig(
  config: PiRenewConfig
): ResolvedHighContextReminderConfig {
  // Legacy key: no longer part of HighContextReminderConfig, so read it loosely
  // and warn. Presence means the key exists and is not undefined, regardless of
  // whether thresholdFraction is also present.
  const legacyThresholdTokens = (
    config.highContextReminder as { thresholdTokens?: unknown } | undefined
  )?.thresholdTokens;
  if (legacyThresholdTokens !== undefined) {
    console.warn(
      "pi-renew: highContextReminder.thresholdTokens is no longer supported and is ignored; use highContextReminder.thresholdFraction (a fraction of the model's context window, e.g. 0.85)."
    );
  }

  return {
    enabled:
      typeof config.highContextReminder?.enabled === "boolean"
        ? config.highContextReminder.enabled
        : DEFAULT_HIGH_CONTEXT_REMINDER_CONFIG.enabled,
    thresholdFraction: normalizeFraction(
      config.highContextReminder?.thresholdFraction,
      DEFAULT_HIGH_CONTEXT_REMINDER_CONFIG.thresholdFraction
    ),
    repeatEveryTokens: normalizePositiveInteger(
      config.highContextReminder?.repeatEveryTokens,
      DEFAULT_HIGH_CONTEXT_REMINDER_CONFIG.repeatEveryTokens
    ),
  };
}

/**
 * Loads the pi-renew config from disk.
 * Creates an empty config file if none exists.
 */
export function loadConfig(configPath = CONFIG_PATH): PiRenewConfig {
  if (!existsSync(configPath)) {
    const empty: PiRenewConfig = { models: [] };
    writeFileSync(configPath, JSON.stringify(empty, null, 2), "utf-8");
    return {
      ...empty,
      highContextReminder: getHighContextReminderConfig(empty),
    };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as PiRenewConfig;
    return {
      models: Array.isArray(parsed.models) ? parsed.models : [],
      highContextReminder: getHighContextReminderConfig(parsed),
    };
  } catch {
    return {
      models: [],
      highContextReminder: getHighContextReminderConfig({ models: [] }),
    };
  }
}

/**
 * Resolves a model name or alias to its canonical model ID.
 * Lookup order: exact ID match → case-insensitive alias match.
 * Returns undefined if the name is not found in the config.
 */
export function resolveModelId(
  nameOrAlias: string,
  config: PiRenewConfig
): string | undefined {
  const byId = config.models.find((m) => m.id === nameOrAlias);
  if (byId) return byId.id;

  const byAlias = config.models.find((m) =>
    m.names.some((n) => n.toLowerCase() === nameOrAlias.toLowerCase())
  );
  return byAlias?.id;
}
