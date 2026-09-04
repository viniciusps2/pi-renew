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

// The default pin every driver skill uses when its caller doesn't override --model. Kept
// here, not duplicated in each driver, for the same anti-drift reason the rest of this
// module lives in one place (design.md D10): a generic harness reused by multiple drivers
// needs the pin overridable explicitly, per-run, rather than baked in unreachably the way
// the one-shot driver bakes in its own (skills/pi-subagent/pi-agent.sh has its own separate
// MODEL constant deliberately — it predates this module and is out of scope this batch).
//
// 2026-08-28 flip-back (user instruction): llm-1/Qwen3.8-Flash-Next -> llm-1/qwen3.8-27b.
// The 27b endpoint had been dead when it was re-pinned away (a `--no-session` control prompt
// produced no assistant event in 120s; handover F131), but the same control prompt answers
// ~1s with `agent_settled` as of the 2026-08-28 18:08 check (F139). It is `defaultModel` in
// ~/.pi/agent/settings.json and has a 260K window. A catalogue row is still not a live
// endpoint (F84/F102/F131) — if this row ever goes silent again, the control probe in the
// driver skills is the thing that exposes it, not this validation.
export const DEFAULT_MODEL_ID = 'llm-1/qwen3.8-27b';

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
