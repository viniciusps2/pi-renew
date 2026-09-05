/**
 * The model the live tests run against — discovered, never pinned.
 *
 * Both live tests write a seed session file whose `model_change` entry has to name the model the
 * spawned `pi` will actually use; a mismatch leaves the resumed session on a different model than
 * the fixture claims. Historically that was solved by hardcoding an id here, and it broke twice —
 * once when the pinned row was dropped from the catalogue, once when the row survived but its
 * endpoint went silent. Both times every live run failed in a way that looked like a restart
 * defect.
 *
 * So the id is read from `pi`'s own settings instead: `defaultProvider` + `defaultModel` in
 * `<agent dir>/settings.json`, the same pair `pi` resolves when no `--model` is passed. The agent
 * dir honours `PI_CODING_AGENT_DIR`, so a run against an isolated agent directory discovers that
 * directory's default rather than the developer's.
 *
 * This mirrors `.claude/skills/pi-driver-common/model.js`'s `readDefaultModelId()` deliberately
 * rather than importing it: that module is development-only tooling outside this package, and the
 * extension's own suite should not reach across into it for a six-line read.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredModel {
  /** Fully-qualified `provider/model`, for a `--model` argument. */
  id: string;
  /** The provider alone, for a session file's `model_change.provider`. */
  provider: string;
  /** The model alone, for a session file's `model_change.modelId`. */
  modelId: string;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Read `pi`'s default model. Throws rather than falling back to a guess: a live test that
 * silently ran against some other model would report a pass that means nothing.
 */
export function discoverDefaultModel(): DiscoveredModel {
  const settingsPath = join(agentDir(), "settings.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot discover the default model: ${settingsPath} is missing or unreadable (${String(err)})`
    );
  }
  const settings = parsed as { defaultProvider?: unknown; defaultModel?: unknown };
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  if (typeof provider !== "string" || provider === "") {
    throw new Error(`cannot discover the default model: ${settingsPath} has no defaultProvider`);
  }
  if (typeof model !== "string" || model === "") {
    throw new Error(`cannot discover the default model: ${settingsPath} has no defaultModel`);
  }
  // `defaultModel` is normally unqualified, with the provider in its own field — but take an
  // already-qualified value as it stands rather than double-prefixing it.
  if (model.includes("/")) {
    const slash = model.indexOf("/");
    return { id: model, provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  return { id: `${provider}/${model}`, provider, modelId: model };
}
