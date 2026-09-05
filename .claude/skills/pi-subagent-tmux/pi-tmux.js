#!/usr/bin/env node
//
// pi-tmux — drive a long-lived `pi` TUI session inside a tmux pane from the shell.
//
// Six verbs: start · send · settled · dead · read · stop — the same driver contract as the RPC
// backend (see ../pi-driver-common/CONTRACT.md), driven against the interactive terminal
// surface instead of `--mode rpc`, because that surface is the only one production actually
// uses. Nothing else is added: no `status` verb distinct from settled/dead, no sentinel-marker
// protocol, no restart or handover awareness. This script does not know what its caller is
// doing with these six verbs.
//
// Architecture: unlike the RPC backend, there is NO supervisor process here and no separate
// watchdog. tmux itself IS the supervisor — it keeps `pi` alive, reports its death via
// `#{pane_dead}`, and survives this script's own exit, so every verb below is a short-lived,
// stateless process that only reads and writes the run directory's files and shells out to
// `tmux`. Run directory layout:
//
//   <run-dir>/
//     meta.json          written once, synchronously, by `start`:
//                        {model, cwd, approve, sessionId, tmuxSessionName, surfaceBytes,
//                         explicitIdle, startedAt}
//     sessions/          `pi`'s own --session-dir; its session file lands here directly, named
//                        <timestamp>_<sessionId>.jsonl — see the note on session identity below
//     stub-stdin.log      (test-only) a stub `pi` writes whatever `send` delivered here; the
//                        real `pi` binary has no such file — see the unit suite
//
// Model validation (../pi-driver-common/model.js) happens before ANY of the above exists, and
// before the tmux session-existence check below — but only for an EXPLICIT --model; with none
// given, no --model is passed to `pi` at all and it picks its own default. `pi` warns but proceeds on an unknown model
// id, so this script rejects an unqualified or uncatalogued id itself, first.
//
// Session identity (measured, not assumed): `start` mints a uuid (crypto.randomUUID()) and
// passes `--session-dir <run-dir>/sessions --session-id <uuid>` to `pi`. `--session-dir <dir>`
// puts the file DIRECTLY in that dir with no cwd-slug subdirectory, and `--session-id <uuid>`
// makes the filename embed that exact uuid —
// `<dir>/2026-08-25T06-59-57-988Z_54b83587-bb0b-4a34-a6e1-0684568fe132.jsonl` — so this driver
// never has to predict the timestamp half; every later verb locates the file by globbing
// `<run-dir>/sessions/*_<uuid>.jsonl`. An absent file means "no assistant message yet" —
// measured in pi's own source (session-manager.js's `_persist` returns early with no assistant
// message in the session) — NEVER death, never an error; see readSessionEntries below.
//
// The tmux session name is `pi-<first 12 hex chars of sha256(resolved absolute run dir)>` —
// deterministic, collision-free in practice, and namespaced away from a human's own tmux
// sessions (this machine has live sessions literally named `a`, `b`, `d`, `t`; a human-readable
// scheme would be a real hazard). `--run-dir` is the addressing flag on every verb, exactly as
// in pi-rpc.js — never a tmux session name directly.
//
// Tool/extension surface: every session isolates the run the same way the RPC supervisor does
// (-ne -nc: no extension discovery, no AGENTS.md/CLAUDE.md discovery; built-in tools left ON by
// default, since this driver is meant to run real coding sessions). A caller wanting a cheaper,
// tool-free probe (as this skill's own smoke.sh does) appends raw `pi` flags after a literal
// `--` on the `start` command line, passed through verbatim after this script's own flags, so a
// later flag wins pi's own last-flag-wins parsing — the same convention pi-rpc.js uses, and
// deliberately NOT a named flag of its own.
//
// Usage:
//   pi-tmux start   --run-dir <dir> [--model <provider/model>] [--cwd <dir>] [--approve]
//                   [--idle <seconds>] [-- <extra pi flags>]
//   pi-tmux send    --run-dir <dir> <text>
//   pi-tmux settled --run-dir <dir> [--wait <seconds>]
//   pi-tmux dead    --run-dir <dir>
//   pi-tmux read    --run-dir <dir> [--all]
//   pi-tmux stop    --run-dir <dir> [--kill]
//   pi-tmux --help
//
// Flags:
//   --run-dir <dir>   The session's state directory (required on every verb).
//   --model <id>      Fully-qualified "provider/model". OPTIONAL, and there is no default:
//                      omit it and no --model reaches `pi`, which then uses the default model
//                      from its own settings. Supplied, it is validated before anything is
//                      spawned (`pi` only warns on an unknown id, so nobody else would catch it).
//   --cwd <dir>       Working directory for the `pi` process (default: this process's cwd).
//   --approve         Trust project-local files for this run (`pi -a`). OFF by default, for
//                      the same reason pi-rpc.js's --approve is off by default: non-interactive
//                      *starts* still skip the trust prompt even though the surface itself is
//                      interactive, so a project-local .pi/skills/ resource silently does not
//                      exist without this.
//   --idle <seconds>  Recorded verbatim in meta.json and used, unless overridden, as the
//                      default for a later `settled --wait` with no --wait value — see decision
//                      27 in the brief / SKILL.md for the full rule. 0 disables it, verbatim.
//   --wait <seconds>  On `settled`: poll instead of checking once. If OMITTED, the default is
//                      NOT "check once" the way the RPC backend's settled is — see SKILL.md,
//                      *A deliberate, bounded difference from the RPC backend*.
//   --all             On `read`: print every assistant text seen, not just the last.
//   --kill            On `stop`: kill the tmux session immediately instead of asking `pi` to
//                      exit first.
//
// Exit codes:
//   start    0 (the tmux session now exists), or 2 if the model id is rejected, the tmux
//            session already exists, or <run-dir>/meta.json already exists — in every case
//            nothing is created and no tmux session is spawned.
//   send     0 once delivered, 2 for a missing run directory.
//   settled  0 if settled, 1 if not (yet, or the session died instead), 2 for a missing run
//            directory.
//   dead     0 if the pane has exited (or no longer exists at all), 1 if it is alive, 2 for a
//            missing run directory.
//   read     0 settled with text, 4 settled with no text, 3 died, 2 for a missing run
//            directory, 1 if the session is still actively running (see pi-rpc.js's identical
//            note on this — read is meant to follow `settled --wait` or `dead`).
//   stop     0 once no tmux session remains (gracefully or via --kill), 2 for a missing run
//            directory.
//
// Deliberate differences from the RPC driver (decision, not omission):
//   - NO --timeout. There is no supervisor to enforce a wall-clock ceiling, so exit code 124
//     never occurs in this backend.
//   - NO --follow-up on `send`. There is no RPC queue; a TUI submission while a run is
//     streaming is whatever the TUI does with it, which is not this driver's business.
//   - `settled` reads a turn boundary from the persisted session file (foldSessionEntries),
//     not an `agent_settled` event — there is no such event in a session file. One consequence:
//     a session `pi` auto-retries after an error is reported as not-settled until the retry
//     lands (see CONTRACT.md's foldSessionEntries section).
//
// capture-pane has exactly one job (measured, see the brief's decision 17): showing the last
// on-screen content of a DEAD pane, on `read`, to stderr. It is never consulted for settled,
// for death, or for the answer text — pane content carries a systematic false-positive class a
// settle heuristic only partly mitigates, which is exactly why state comes from the session
// file instead. Piping a pi TUI's stdout kills it (measured: `pi ... | tee log` died instantly
// with status 0), so there is no "also log the pane" option beyond this one read.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_USAGE, EXIT_DIED, EXIT_SETTLED_WITH_TEXT, EXIT_SETTLED_NO_TEXT } from '../pi-driver-common/exit-codes.js';
import { computeIdleSeconds } from '../pi-driver-common/idle.js';
import { resolveModelId, readDefaultModelId } from '../pi-driver-common/model.js';
import { foldSessionEntries } from '../pi-driver-common/session.js';

const THIS_FILE = fileURLToPath(import.meta.url);

// The F90-anchored full-surface estimate (see ../pi-driver-common/idle.js's header comment,
// "~96KB", and CONTRACT.md Rule 4: 23,974 input tokens x 4 bytes, measured with the full
// extension surface loaded and -a). This driver does not do a round trip to measure the
// surface it actually loaded the way the RPC supervisor's O32 fix does (see supervisor.js) — a
// second `pi` spawn purely to size the surface would double this driver's startup for a number
// derivable from the flags `start` was already given. So, like the one-shot driver, it is
// binary: 0 when the run has no tools loaded (the extra pass-through args include --no-tools or
// -nt — extensions are already off by default via -ne), the full anchor otherwise.
const FULL_SURFACE_PROMPT_BYTES = 95896;

class UsageError extends Error {
  constructor(verb, message) {
    super(`${verb}: ${message}`);
    this.name = 'UsageError';
    this.exitCode = EXIT_USAGE;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Print the header comment block above, the same trick pi-agent.sh's --help and pi-rpc.js use. */
function printHelp() {
  const src = readFileSync(THIS_FILE, 'utf8');
  const lines = src.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('//')) {
      out.push(lines[i].replace(/^\/\/ ?/, ''));
    } else if (lines[i].trim() === '' && out.length > 0) {
      out.push('');
    } else if (out.length > 0) {
      break;
    }
  }
  process.stdout.write(out.join('\n').trimEnd() + '\n');
}

/** Split argv on a literal "--"; everything after it is returned verbatim, untouched. */
function splitOnDoubleDash(argv) {
  const idx = argv.indexOf('--');
  if (idx === -1) return { main: argv, extra: [] };
  return { main: argv.slice(0, idx), extra: argv.slice(idx + 1) };
}

/** Minimal named-flag parser: boolFlags take no value, valueFlags consume the next argv. */
function parseFlags(args, { boolFlags = [], valueFlags = [] } = {}) {
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (boolFlags.includes(arg)) {
      values[arg] = true;
    } else if (valueFlags.includes(arg)) {
      i += 1;
      values[arg] = args[i];
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

function requireRunDir(values, verb) {
  const runDir = values['--run-dir'];
  if (!runDir) throw new UsageError(verb, 'requires --run-dir <dir>');
  if (!existsSync(runDir)) throw new UsageError(verb, `no such run directory: ${runDir}`);
  return runDir;
}

function readMeta(runDir, verb) {
  const metaPath = path.join(runDir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new UsageError(verb, `${runDir} has no session yet (meta.json not written)`);
  }
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

/**
 * The tmux session name for a run directory: deterministic, collision-free in practice, and
 * namespaced away from a human's own tmux sessions (decision 6 in the brief). Sha256, not a
 * weaker hash: this only needs to be stable and spread out, and Node has it built in for free.
 * @param {string} absRunDir The RESOLVED absolute run directory.
 * @returns {string}
 */
function tmuxSessionNameFor(absRunDir) {
  const hash = createHash('sha256').update(absRunDir).digest('hex').slice(0, 12);
  return `pi-${hash}`;
}

/** True if a tmux session with this name currently exists. */
function tmuxHasSession(name) {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

/**
 * Is the pane dead? An absent session/pane (already fully torn down, e.g. after `stop`) counts
 * as dead too — there is no "alive" answer for a target that no longer exists.
 * @param {string} name
 * @returns {boolean}
 */
function tmuxPaneDead(name) {
  const res = spawnSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_dead}'], { encoding: 'utf8' });
  if (res.status !== 0) return true;
  return res.stdout.split('\n')[0].trim() === '1';
}

/**
 * Locate this run's session file by globbing on the uuid `start` minted (decision 7): the
 * filename is `<timestamp>_<sessionId>.jsonl` and this driver never has to predict the
 * timestamp half. Returns null if the sessions directory or the file doesn't exist yet — that
 * is "no assistant message written yet", not an error (see the header comment above).
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {string|null}
 */
function findSessionFile(sessionsDir, sessionId) {
  let names;
  try {
    names = readdirSync(sessionsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = names.find((n) => n.endsWith(suffix));
  return match ? path.join(sessionsDir, match) : null;
}

/** Read and parse a session file's entries, tolerating a concurrent partial write. */
function readSessionEntries(sessionsDir, sessionId) {
  const file = findSessionFile(sessionsDir, sessionId);
  if (file === null) return [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return []; // raced: listed by readdir, gone by the time we read it
    throw err;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A concurrent reader can catch the file mid-append; a line that fails to parse is
      // presumed to be exactly such a partial write and is skipped, not treated as corruption
      // (mirrors readParsedEvents's identical comment in pi-rpc.js).
    }
  }
  return entries;
}

/** The one place a stateless reader (settled/dead/read) turns a run directory into current state. */
function readCurrentState(runDir, meta) {
  const paneDead = tmuxPaneDead(meta.tmuxSessionName);
  const entries = readSessionEntries(meta.sessionsDir, meta.sessionId);
  return foldSessionEntries(entries, { paneDead });
}

function cmdStart(argv) {
  const { main, extra } = splitOnDoubleDash(argv);
  const { values } = parseFlags(main, {
    boolFlags: ['--approve'],
    valueFlags: ['--run-dir', '--model', '--cwd', '--idle'],
  });

  const runDirArg = values['--run-dir'];
  if (!runDirArg) throw new UsageError('start', 'requires --run-dir <dir>');

  // No --model means no --model: the flag is omitted from the pane's argv and `pi` resolves
  // its own default, so this driver can never pin a model the user did not configure. An
  // EXPLICIT --model is still validated first, before anything else exists, so a rejected id
  // leaves nothing behind (mirrors pi-rpc.js's cmdStart exactly).
  const requestedModel = values['--model'];
  const modelId = requestedModel === undefined ? null : resolveModelId(requestedModel).id;

  const runDir = path.resolve(runDirArg);
  const sessionName = tmuxSessionNameFor(runDir);
  const metaPath = path.join(runDir, 'meta.json');

  // Both guards run BEFORE any side effect, so "creates nothing" holds for either failure —
  // decision 6's own test names this exactly.
  if (tmuxHasSession(sessionName)) {
    throw new UsageError('start', `tmux session ${sessionName} already exists for ${runDir} — choose a fresh --run-dir`);
  }
  if (existsSync(metaPath)) {
    throw new UsageError('start', `${runDir} already has a session (meta.json exists) — choose a fresh --run-dir`);
  }

  const cwd = path.resolve(values['--cwd'] ?? process.cwd());
  const sessionsDir = path.join(runDir, 'sessions');
  const sessionId = randomUUID();
  const explicitIdle = values['--idle'] !== undefined ? Number(values['--idle']) : undefined;

  // decision 24's rule, applied here per decision 27: 0 only when tools are explicitly turned
  // off via the pass-through (extensions are already off by default through -ne below); the
  // full anchor otherwise. See the FULL_SURFACE_PROMPT_BYTES comment above for why this driver
  // doesn't measure the surface directly the way the RPC supervisor's O32 fix does.
  const toolsDisabled = extra.includes('--no-tools') || extra.includes('-nt');
  const surfaceBytes = toolsDisabled ? 0 : FULL_SURFACE_PROMPT_BYTES;

  mkdirSync(runDir, { recursive: true });
  // NOT mkdir'd here: `pi` creates <run-dir>/sessions itself once it has something to persist
  // (mirrors supervisor.js, which passes --session-dir without pre-creating it either).

  // decision 16: build the pane command as a plain argv array, never one interpolated string —
  // tmux runs a command directly (no shell) when none of its own argv tokens contain shell
  // metacharacters, which is what keeps #{pane_pid} the `pi` process itself.
  const piArgs = ['--session-dir', sessionsDir, '--session-id', sessionId, '-ne', '-nc'];
  if (modelId !== null) piArgs.unshift('--model', modelId);
  if (values['--approve']) piArgs.push('--approve');
  piArgs.push(...extra);

  // decision 15: remain-on-exit set in the SAME tmux invocation that creates the session — a
  // process that dies in the gap between two separate tmux calls would leave no pane to
  // inspect at all, defeating the point of the flag. The literal `;` here is tmux's OWN
  // multi-command separator syntax, passed as its own argv element because there is no shell
  // between this process and tmux to have escaped it for — not a shell metacharacter.
  const tmuxArgs = [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    cwd,
    'pi',
    ...piArgs,
    ';',
    'set-option',
    '-t',
    sessionName,
    'remain-on-exit',
    'on',
  ];
  const res = spawnSync('tmux', tmuxArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    const stderr = res.stderr ? res.stderr.toString('utf8').trim() : '';
    throw new Error(`tmux new-session failed (exit ${res.status}): ${stderr}`);
  }

  writeFileSync(
    metaPath,
    JSON.stringify({
      // The model the caller pinned, or the default `pi` is expected to pick (read from its
      // settings purely so meta.json names one). null when neither is known.
      model: modelId ?? readDefaultModelId(),
      cwd,
      approve: Boolean(values['--approve']),
      sessionId,
      sessionsDir,
      tmuxSessionName: sessionName,
      surfaceBytes,
      explicitIdle: explicitIdle ?? null,
      startedAt: new Date().toISOString(),
    }),
  );

  process.stdout.write(runDir + '\n');
  process.exit(0);
}

// Settle after the pane first draws, before a paste is accepted — see waitForPaneReady.
const READY_SETTLE_SECONDS = 1;

/**
 * Best-effort wait for the TUI in a freshly started pane to be ready to accept a paste.
 *
 * Why this exists, measured by the caller against a live pi 0.84.3 TUI: `start` returns as soon
 * as tmux has created the session (that is deliberate — it must not block on a model), but the
 * TUI inside the pane needs a moment to draw its composer and enable bracketed-paste mode. A
 * `send` issued immediately after `start` measured as landing in the composer and then NEVER
 * submitting — the text is visible on screen with the token counter still at 0.0%. The same
 * send three seconds later submits correctly. smoke.sh sends immediately, which is exactly how
 * this was found.
 *
 * The readiness signal is the pane's CURSOR POSITION, not its contents: measured, `#{cursor_y}`
 * is 0 while the pane is still blank and becomes non-zero (20, on an 80x24 pane) within ~1s,
 * once the TUI has drawn. This reads a tmux format, not the screen — `capture-pane` still has
 * exactly one job in this driver (see the header comment and decision 17).
 *
 * Best-effort by design: on timeout it returns and the caller proceeds anyway. A driver that
 * can refuse to send is worse than one that occasionally sends a touch early.
 * @param {string} sessionName
 * @param {number} [timeoutMs]
 */
function waitForPaneReady(sessionName, timeoutMs = 5000) {
  const cursorY = () => {
    const res = spawnSync('tmux', ['display-message', '-p', '-t', sessionName, '#{cursor_y}'], {
      encoding: 'utf8',
    });
    // null (not 0) for "cannot ask": pane or session gone, which is not a "still blank" answer.
    return res.status === 0 ? Number(res.stdout.trim()) : null;
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const y = cursorY();
    if (y === null) return; // pane or session gone: let the caller's own error path report it
    if (y > 0) {
      // Drawn — but NOT yet ready. Measured: the cursor lands at its final row about a second
      // before the TUI will accept a submitting paste, and a send in that window leaves the
      // text sitting in the composer forever. So settle: hold, then require it still drawn.
      spawnSync('sleep', [String(READY_SETTLE_SECONDS)]);
      return;
    }
    spawnSync('sleep', ['0.1']);
  }
}

function cmdSend(argv) {
  const { values, positionals } = parseFlags(argv, { valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'send');
  const meta = readMeta(runDir, 'send');
  const text = positionals.join(' ');
  if (text === '') throw new UsageError('send', 'requires prompt text');

  // Text goes in through a tmux buffer loaded from a temp file — never send-keys -l with the
  // text built into a shell/tmux argument string, which is the whole class of quoting bug this
  // avoids. Two calls, and BOTH flags on them are load-bearing; all four facts below were
  // measured by the caller against a live pi 0.84.3 TUI during review of this batch:
  //
  //   1. paste-buffer -r for the TEXT. Without -r, tmux converts every LF in the buffer to CR,
  //      and the TUI reads each CR as a submit: a two-line prompt measured as arriving as TWO
  //      separate user messages, each answered separately. -r turns that conversion off, so the
  //      newlines stay literal and the whole prompt lands in the composer as one message.
  //   2. A second paste of a bare LF, deliberately WITHOUT -r, to submit. That is the same
  //      conversion turned back on for one byte: LF -> CR -> the TUI submits, exactly once.
  //   3. send-keys does NOT work here and is deliberately not used. Measured: `send-keys Enter`
  //      and `send-keys C-m`, against both the session name and an explicit pane id (%0), left
  //      the prompt sitting unsubmitted in the composer with the token counter at 0.0% every
  //      time. An earlier version of this driver used it, and `send` silently never submitted.
  //   4. -p (bracketed paste) is kept on the text: pi requests bracketed-paste mode, and it is
  //      what makes the payload arrive as a paste rather than as simulated typing.
  //
  // Verified end to end after the change: a two-line prompt containing $VAR, "quotes" and a
  // backtick arrives as exactly ONE user message with its newline and every special character
  // byte-intact.
  const bufferName = `pi-tmux-${process.pid}-${Date.now().toString(36)}`;
  const submitBufferName = `${bufferName}-submit`;
  const tmpFile = path.join(tmpdir(), `${bufferName}.txt`);
  const submitFile = path.join(tmpdir(), `${submitBufferName}.txt`);
  writeFileSync(tmpFile, text);
  writeFileSync(submitFile, '\n');
  const tmux = (args, what) => {
    const res = spawnSync('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0) {
      throw new Error(`tmux ${what} failed: ${res.stderr ? res.stderr.toString('utf8').trim() : ''}`);
    }
  };
  try {
    // The TUI must be drawn before it can accept a paste — see waitForPaneReady.
    waitForPaneReady(meta.tmuxSessionName);
    tmux(['load-buffer', '-b', bufferName, tmpFile], 'load-buffer');
    // -r: literal newlines, so a multi-line prompt is ONE message (fact 1 above).
    tmux(['paste-buffer', '-p', '-r', '-b', bufferName, '-t', meta.tmuxSessionName], 'paste-buffer');
    tmux(['load-buffer', '-b', submitBufferName, submitFile], 'load-buffer (submit)');
    // No -r: this one LF becomes the CR that submits (fact 2 above).
    tmux(['paste-buffer', '-b', submitBufferName, '-t', meta.tmuxSessionName], 'paste-buffer (submit)');
  } finally {
    spawnSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'ignore' });
    spawnSync('tmux', ['delete-buffer', '-b', submitBufferName], { stdio: 'ignore' });
    try {
      unlinkSync(submitFile);
    } catch {
      // best-effort cleanup
    }
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }

  process.exit(0);
}

async function cmdSettled(argv) {
  const { values } = parseFlags(argv, { valueFlags: ['--run-dir', '--wait'] });
  const runDir = requireRunDir(values, 'settled');
  const meta = readMeta(runDir, 'settled');

  // decision 27 — the deliberate, bounded difference from the RPC backend: there is no
  // supervisor/watchdog process here (decision 4), so `settled --wait`'s own default is this
  // driver's ONLY participation in the shared idle discipline. When --wait is explicitly
  // given, that value wins verbatim (matches the RPC backend's settled exactly). When it is
  // OMITTED, the default is NOT "check once" the way the RPC backend's settled is — it is
  // computeIdleSeconds({ surfaceBytes, explicitIdle }), using the surfaceBytes `start` recorded
  // and the --idle `start` was (or wasn't) given, so an explicit `start --idle N` still governs
  // this default too (decision 26: --idle wins everywhere, verbatim).
  const waitSeconds =
    values['--wait'] !== undefined
      ? Number(values['--wait'])
      : computeIdleSeconds({ surfaceBytes: meta.surfaceBytes ?? 0, explicitIdle: meta.explicitIdle ?? undefined });
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;

  for (;;) {
    const state = readCurrentState(runDir, meta);
    if (state.settled) process.exit(0);
    if (state.died) process.exit(1); // it will never settle now
    if (Date.now() >= deadline) process.exit(1);
    await sleep(200);
  }
}

function cmdDead(argv) {
  const { values } = parseFlags(argv, { valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'dead');
  const meta = readMeta(runDir, 'dead');
  process.exit(tmuxPaneDead(meta.tmuxSessionName) ? 0 : 1);
}

function cmdRead(argv) {
  const { values } = parseFlags(argv, { boolFlags: ['--all'], valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'read');
  const meta = readMeta(runDir, 'read');
  const state = readCurrentState(runDir, meta);

  // decision 12: surfaced, not swallowed, and without changing the exit code below — the
  // tmux backend's equivalent of the RPC backend's extension_error handling. A session `pi`
  // auto-retries after an error otherwise just hangs at "not settled" with nothing anywhere
  // saying why.
  for (const err of state.erroredStopReasons) {
    process.stderr.write(`pi-tmux: stopReason=error at ${err.timestamp ?? '?'} (rawStopReason=${err.rawStopReason ?? '?'})\n`);
  }

  if (state.settled) {
    const text = values['--all'] ? state.assistantTexts.join('\n\n') : state.lastAssistantText;
    if (text !== '') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    process.exit(state.lastAssistantText !== '' ? EXIT_SETTLED_WITH_TEXT : EXIT_SETTLED_NO_TEXT);
  }
  if (state.died) {
    // decision 17: the ONE job capture-pane has — the last on-screen content of a DEAD pane,
    // to stderr, never consulted for settled/died/text. A pane already fully torn down (no
    // session left to capture at all) is handled gracefully: no content, no crash.
    const capture = spawnSync('tmux', ['capture-pane', '-p', '-t', meta.tmuxSessionName], { encoding: 'utf8' });
    if (capture.status === 0) {
      process.stderr.write(`pi-tmux: last screen of the dead pane:\n${capture.stdout}\n`);
    }
    process.exit(EXIT_DIED);
  }
  // Neither settled nor dead: still actively running. Same "not yet" signal settled/dead
  // themselves use (exit 1) rather than forcing a guess into the three-outcome table — mirrors
  // pi-rpc.js's cmdRead exactly; see its comment for the full reasoning.
  if (state.lastAssistantText !== '') process.stdout.write(`${state.lastAssistantText}\n`);
  process.stderr.write('pi-tmux: read: session has not finished yet — call `settled --wait` or `dead` first\n');
  process.exit(1);
}

async function cmdStop(argv) {
  const { values } = parseFlags(argv, { boolFlags: ['--kill'], valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'stop');
  const meta = readMeta(runDir, 'stop');
  const name = meta.tmuxSessionName;

  if (values['--kill']) {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } else {
    // decision 19: pi's own documented exit key (its startup banner: "ctrl+c/ctrl+d
    // clear/exit"), then a brief wait for the pane to actually die, then kill-session
    // regardless — "stop must leave no tmux session behind" holds either way.
    spawnSync('tmux', ['send-keys', '-t', name, 'C-d'], { stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !tmuxPaneDead(name)) {
      await sleep(100);
    }
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }

  const stillThere = tmuxHasSession(name);
  if (stillThere) {
    process.stderr.write(`pi-tmux: stop: tmux session ${name} still exists after the kill attempt\n`);
    process.exit(1);
  }
  process.stdout.write(`pi-tmux: stop: tmux session ${name} closed\n`);
  process.exit(0);
}

async function main() {
  const [, , verb, ...rest] = process.argv;
  try {
    switch (verb) {
      case 'start':
        cmdStart(rest);
        return;
      case 'send':
        cmdSend(rest);
        return;
      case 'settled':
        await cmdSettled(rest);
        return;
      case 'dead':
        cmdDead(rest);
        return;
      case 'read':
        cmdRead(rest);
        return;
      case 'stop':
        await cmdStop(rest);
        return;
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        process.exit(0);
        return;
      default:
        throw new UsageError('pi-tmux', `unknown verb "${verb}" (expected start|send|settled|dead|read|stop)`);
    }
  } catch (err) {
    const code = typeof err?.exitCode === 'number' ? err.exitCode : 1;
    process.stderr.write(`pi-tmux: ${err.message}\n`);
    process.exit(code);
  }
}

main();
