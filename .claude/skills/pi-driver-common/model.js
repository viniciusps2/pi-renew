// model.js — fully-qualified model id resolution, with no silent fallback.
//
// Why this exists at all: `pi` does NOT fail on an unknown model id. Measured in this repo:
//
//   $ pi -p --mode json -ne -nt --model "llm-1/definitely-not-a-model" --no-session "hi"
//   Warning: Model "definitely-not-a-model" not found for provider "llm-1". Using custom model id.
//   {"type":"session",...}          <- the run proceeds
//   EXIT=0
//
// So a driver that just forwards whatever `--model` it was given inherits that silent
// fallback. This module is the one place that refuses it, per the shared contract: a
// fully-qualified, catalogued id or an explicit exit 2 — never a guess.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Thrown by resolveModelId; carries the exit code its caller should use (decision 4: 2). */
export class ModelResolutionError extends Error {
  /** @param {string} message @param {number} exitCode */
  constructor(message, exitCode) {
    super(message);
    this.name = 'ModelResolutionError';
    this.exitCode = exitCode;
  }
}

const USAGE_EXIT_CODE = 2;

// No default model is pinned here, and none is pinned in any driver. A driver that is not
// given an explicit --model passes NO --model flag to `pi` at all, so `pi` resolves its own
// default the same way an interactive session does. That is the only way the drivers can
// never drift from the model the user actually configured.
//
// readDefaultModelId() below exists for REPORTING, not for selection: a driver records what
// `pi` is expected to pick so its meta.json and its logs name a model, without that name
// ever becoming an argument. If it cannot be read, the driver still runs — it just reports
// the model as unknown, which is honest, rather than substituting a guess.

/** The agent directory `pi` reads settings from; PI_CODING_AGENT_DIR overrides the default. */
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

/**
 * The model `pi` will use when no --model is passed, read from its settings.
 *
 * `defaultModel` in `~/.pi/agent/settings.json` is stored UNQUALIFIED (e.g.
 * "qwen3.8-27b-superfast"); the provider is the separate `defaultProvider` field. This
 * joins them into the "provider/model" form the rest of this module speaks.
 *
 * Returns null — never a fallback id — when the file is missing, unreadable, malformed, or
 * missing either field. A caller must treat null as "unknown", not as "use something else":
 * there is deliberately nothing else to use.
 *
 * @param {object} [opts]
 * @param {string} [opts.settingsPath] Override, for tests.
 * @returns {string|null}
 */
export function readDefaultModelId({ settingsPath = join(agentDir(), 'settings.json') } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { defaultProvider, defaultModel } = parsed;
  if (typeof defaultProvider !== 'string' || defaultProvider === '') return null;
  if (typeof defaultModel !== 'string' || defaultModel === '') return null;
  // Already qualified in the settings file: take it as it stands rather than double-prefixing.
  if (defaultModel.includes('/')) return defaultModel;
  return `${defaultProvider}/${defaultModel}`;
}

/**
 * Run `pi --list-models` with no search term and return its raw stdout. Offline, ~1.5s,
 * lists several hundred models in this environment. Intentionally NOT parametrised with a
 * search string: `pi --list-models <search>` prints "No models matching \"...\"" and still
 * exits 0, so branching on that command's exit status is a trap either way — reading the
 * full catalogue once and searching it ourselves sidesteps the trap entirely rather than
 * working around it.
 * @returns {string}
 */
function defaultListModels() {
  return execFileSync('pi', ['--list-models'], { encoding: 'utf8' });
}

/**
 * Parse `pi --list-models` output into {provider, model} rows. Skips the header line and any
 * blank line. Columns are whitespace-aligned; since neither a provider nor a model name
 * contains whitespace, splitting each row on runs of whitespace and taking the first two
 * fields is exact regardless of the column widths `pi` chose to print.
 * @param {string} text
 * @returns {{provider: string, model: string}[]}
 */
export function parseCatalogue(text) {
  const lines = text.split('\n');
  const rows = [];
  // Row 0 is always the header ("provider  model  context  max-out  thinking  images");
  // skipping it unconditionally (rather than pattern-matching the word "provider") is what
  // the fixture test for this rule actually exercises — see model.test.js.
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    rows.push({ provider: cols[0], model: cols[1] });
  }
  return rows;
}

/**
 * Resolve a candidate model id against the catalogue, with no fuzzy matching, no glob, and
 * no discovery-and-pick-the-first.
 *
 * A candidate splits on the FIRST "/" only: provider is everything before it, model is
 * everything after. A model column can itself contain a "/" — this catalogue really does
 * contain a row `openrouter  qwen/qwen3.8-27b` — so `candidate.split("/")[1]` would silently
 * truncate that model id to "qwen" and, via the warning-path fallback documented above, run
 * against a custom model id with nobody the wiser. `"openrouter/qwen/qwen3.8-27b"` must
 * resolve to provider "openrouter", model "qwen/qwen3.8-27b" — found. `"qwen3.8-27b"` (no
 * "/") must be rejected as unqualified before the catalogue is even read.
 *
 * @param {string} candidate Fully-qualified "provider/model" id.
 * @param {object} [opts]
 * @param {() => string} [opts.listModels] Catalogue reader, injected so tests never shell
 *   out. Defaults to running `pi --list-models`.
 * @returns {{provider: string, model: string, id: string}}
 */
export function resolveModelId(candidate, { listModels = defaultListModels } = {}) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ModelResolutionError('a model id is required', USAGE_EXIT_CODE);
  }

  const slash = candidate.indexOf('/');
  if (slash <= 0 || slash === candidate.length - 1) {
    throw new ModelResolutionError(
      `model id "${candidate}" is unqualified — expected "provider/model"`,
      USAGE_EXIT_CODE,
    );
  }
  const provider = candidate.slice(0, slash);
  const model = candidate.slice(slash + 1);

  const rows = parseCatalogue(listModels());
  const found = rows.some((row) => row.provider === provider && row.model === model);
  if (!found) {
    throw new ModelResolutionError(
      `model id "${candidate}" is not in the catalogue (pi --list-models)`,
      USAGE_EXIT_CODE,
    );
  }

  return { provider, model, id: `${provider}/${model}` };
}
