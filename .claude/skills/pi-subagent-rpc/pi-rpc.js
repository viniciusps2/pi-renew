#!/usr/bin/env node
//
// pi-rpc — drive a long-lived `pi --mode rpc` session from the shell.
//
// Six verbs: start · send · settled · dead · read · stop. The first five are the shared
// driver contract (see ../pi-driver-common/CONTRACT.md); `stop` is the one addition every
// long-lived driver is allowed (a session with no shutdown path leaks a process that pins
// the model it loaded). Nothing else is added: no `status` verb distinct from
// settled/dead, no sentinel-marker protocol, no restart or handover awareness. This script
// does not know what its caller is doing with these six verbs.
//
// Architecture: `start` writes a run directory and spawns a DETACHED supervisor process
// (supervisor.js) that owns the actual `pi` child for as long as the session lives — one
// foreground process cannot answer "is it settled yet?" from a separate shell invocation
// two minutes later, so the supervisor outlives this command. `send`, `settled`, `dead` and
// `read` are stateless: each is a fresh process that only reads and writes the run
// directory's files, and must work correctly however many other invocations run before or
// after it. Run directory layout:
//
//   <run-dir>/
//     meta.json      written by the supervisor once it has spawned `pi`:
//                    {model, cwd, approve, idleSeconds, startedAt, supervisorPid, piPid}
//     in.jsonl       append-only; `send` appends one RPC command line here, verbatim
//     events.jsonl   append-only; every byte `pi` writes to its own stdout, byte-for-byte
//     stderr.log     `pi`'s stderr, plus a few supervisor narration lines
//     status.json    written by the supervisor once `pi` exits: {exitCode, signal, settled, endedAt}
//     sessions/      `pi`'s own session file for this run (--session-dir), so the session id
//                    and its lineage survive the run — see the note on persistence below
//
// A FIFO was considered for in.jsonl and rejected, deliberately: a FIFO signals EOF to its
// reader the moment the last writer closes it, so every single `send` would terminate the
// session unless some other process held a permanent writer open for no other reason. A
// plain append-only file the supervisor polls has no such failure mode.
//
// Model validation (../pi-driver-common/model.js) happens before ANY of the above exists:
// `pi` warns but proceeds on an unknown model id, so this script rejects an unqualified or
// uncatalogued id itself, before the run directory is created and before any `pi` process
// is spawned.
//
// Tool/extension surface: every session this script starts runs with extensions and
// AGENTS.md/CLAUDE.md discovery off, mirroring skills/pi-subagent/pi-agent.sh's own "isolate
// the run" defaults (--no-extensions --no-context-files). Built-in tools are left enabled by
// default, also matching pi-agent.sh's default — this driver is meant to run real coding
// sessions, not just reasoning-only probes. Session persistence, however, is deliberately
// left ON and pointed at <run-dir>/sessions: the one-shot driver is ephemeral because a
// single turn has nothing to persist, while a long-lived session's file is the only artifact
// carrying its id and lineage, and is the source of truth the sibling tmux backend reads
// state from. Append `-- --no-session` for an ephemeral run. A caller that wants a cheaper,
// tool-free probe (as this skill's own smoke.sh does) appends raw `pi` flags after a literal
// `--` on the `start` command line; they are passed through verbatim, after this script's
// own flags, so a later one wins pi's own last-flag-wins parsing. This is deliberately NOT a
// named flag: the six-verb table below is the only vocabulary this driver invents, and raw
// pass-through costs nothing to keep.
//
// Usage:
//   pi-rpc start   --run-dir <dir> [--model <provider/model>] [--cwd <dir>] [--approve]
//                  [--idle <seconds>] [--timeout <seconds>] [-- <extra pi flags>]
//   pi-rpc send    --run-dir <dir> [--follow-up] <text>
//   pi-rpc settled --run-dir <dir> [--wait <seconds>]
//   pi-rpc dead    --run-dir <dir>
//   pi-rpc read    --run-dir <dir> [--all]
//   pi-rpc stop    --run-dir <dir> [--kill]
//   pi-rpc --help
//
// Flags:
//   --run-dir <dir>   The session's state directory (required on every verb).
//   --model <id>      Fully-qualified "provider/model" (default: the shared pin in
//                      ../pi-driver-common/model.js). Validated before anything is spawned.
//   --cwd <dir>       Working directory for the `pi` process (default: this process's cwd).
//   --approve         Trust project-local files for this run (`pi -a`). OFF by default:
//                      non-interactive modes never prompt for trust, so without this a
//                      project-local .pi/skills/ or .pi/prompts/ resource silently does not
//                      exist. A flow using only globally installed resources needs no
//                      approval and should leave this off.
//   --idle <seconds>  Idle-stall timeout; 0 disables it. Default: the 60s floor from
//                      ../pi-driver-common/idle.js (this driver does not yet measure a
//                      loaded surface to raise it automatically — pass --idle explicitly for
//                      a session with a large tool/extension surface).
//   --timeout <sec>   Absolute wall-clock ceiling for the whole session's lifetime; 0 (the
//                      default) disables it.
//   --follow-up       On `send`: queue as a followUp (delivered once the current run
//                      finishes) instead of a fresh prompt. Rejected by `pi` if nothing is
//                      currently streaming — send a plain prompt instead in that case.
//   --wait <seconds>  On `settled`: poll instead of checking once.
//   --all             On `read`: print every assistant text seen, not just the last.
//   --kill            On `stop`: SIGKILL the session instead of closing its stdin.
//
// Exit codes:
//   start    0 always (the run directory now exists and the supervisor is launched), or 2
//            if the model id is rejected or the run directory already holds a session —
//            in both cases nothing is created and no `pi` process is spawned.
//   send     0 once the line is appended, or 2 for a missing run directory.
//   settled  0 if settled, 1 if not (yet, or the session died instead), 2 for a missing run
//            directory.
//   dead     0 if the process has exited, 1 if it is still running, 2 for a missing run
//            directory.
//   read     0 settled with text, 4 settled with no text, 3 died, 2 for a missing run
//            directory — and 1 if the session is still actively running (neither settled
//            nor dead yet; call `settled --wait` or `dead` first — see the note in cmdRead).
//   stop     0 once the session has exited (gracefully or via --kill), 1 if it did not exit
//            within the wait budget, 2 for a missing run directory.
//
// Extension errors: a throwing `pi` extension emits {"type":"extension_error",...} and the
// run then settles SUCCESSFULLY anyway (measured) — nothing about the exit code or the
// model's own answer records the failure. `read` prints every extension_error line to
// stderr, prefixed "pi-rpc: extension_error:", before printing the answer to stdout, WITHOUT
// changing the exit code — an extension error is not treated as a run failure.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_USAGE,
  EXIT_DIED,
  EXIT_SETTLED_WITH_TEXT,
  EXIT_SETTLED_NO_TEXT,
} from '../pi-driver-common/exit-codes.js';
import { resolveModelId, DEFAULT_MODEL_ID } from '../pi-driver-common/model.js';
import { foldEvents } from '../pi-driver-common/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = path.join(HERE, 'supervisor.js');
const THIS_FILE = fileURLToPath(import.meta.url);

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

/** Print the header comment block above, the same trick pi-agent.sh's --help uses. */
function printHelp() {
  const src = readFileSync(THIS_FILE, 'utf8');
  const lines = src.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    // stop at the first non-comment, non-blank line (the `import` block)
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

function readParsedEvents(runDir) {
  let text = '';
  try {
    text = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return []; // the supervisor hasn't written anything yet
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A concurrent reader can catch events.jsonl mid-append, since the supervisor writes
      // raw stdout chunks as they arrive rather than waiting for a complete line (decision:
      // "byte-for-byte", so it deliberately does not buffer to line boundaries). A line that
      // fails to parse is presumed to be exactly such a partial write and is skipped, not
      // treated as corruption.
    }
  }
  return events;
}

/**
 * The one place a stateless reader (settled/dead/read) turns a run directory into current
 * state. status.json, once it exists, is authoritative for `settled`/`died` (it is computed
 * exactly once, at the moment the supervisor observed `pi` actually exit) — a fresh fold of
 * events.jsonl here is used only for the text/extension-error fields status.json doesn't
 * carry, and as the sole source of truth while the process is still running.
 */
function readCurrentState(runDir) {
  const events = readParsedEvents(runDir);
  const statusPath = path.join(runDir, 'status.json');
  if (existsSync(statusPath)) {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    const folded = foldEvents(events, { ended: true });
    return { ...folded, settled: status.settled, died: !status.settled, ended: true, status };
  }
  return { ...foldEvents(events, { ended: false }), ended: false, status: null };
}

function cmdStart(argv) {
  const { main, extra } = splitOnDoubleDash(argv);
  const { values } = parseFlags(main, {
    boolFlags: ['--approve'],
    valueFlags: ['--run-dir', '--model', '--cwd', '--idle', '--timeout'],
  });

  const runDir = values['--run-dir'];
  if (!runDir) throw new UsageError('start', 'requires --run-dir <dir>');

  // Model validation happens before the run directory exists and before any `pi` process is
  // spawned — a rejected id leaves nothing behind to clean up. resolveModelId already
  // throws with .exitCode set (EXIT_USAGE), so letting it propagate to main()'s catch is
  // enough; no separate try/catch is needed here.
  const resolved = resolveModelId(values['--model'] ?? DEFAULT_MODEL_ID);

  if (existsSync(path.join(runDir, 'meta.json'))) {
    throw new UsageError('start', `${runDir} already has a session (meta.json exists) — choose a fresh --run-dir`);
  }

  const cwd = path.resolve(values['--cwd'] ?? process.cwd());
  mkdirSync(runDir, { recursive: true });
  // Created here, synchronously, before the supervisor is even spawned — so `send` (a
  // separate process that may run moments later) never races "does in.jsonl exist yet".
  writeFileSync(path.join(runDir, 'in.jsonl'), '');
  writeFileSync(path.join(runDir, 'events.jsonl'), '');
  writeFileSync(path.join(runDir, 'stderr.log'), '');

  const supervisorArgs = [SUPERVISOR_PATH, '--run-dir', path.resolve(runDir), '--model', resolved.id, '--cwd', cwd];
  if (values['--idle'] !== undefined) supervisorArgs.push('--idle', values['--idle']);
  if (values['--timeout'] !== undefined) supervisorArgs.push('--timeout', values['--timeout']);
  if (values['--approve']) supervisorArgs.push('--approve');
  if (extra.length > 0) supervisorArgs.push('--', ...extra);

  // detached + unref'd + stdio ignored: the supervisor must outlive this process and this
  // process must not wait on it. Any startup failure inside the supervisor (e.g. `pi` not
  // on PATH) surfaces later, through status.json/stderr.log, exactly as a real crash would —
  // there is no way to report it synchronously without breaking "start returns immediately".
  const child = spawn(process.execPath, supervisorArgs, { detached: true, stdio: 'ignore', cwd });
  child.unref();

  process.stdout.write(path.resolve(runDir) + '\n');
  process.exit(0);
}

function cmdSend(argv) {
  const { values, positionals } = parseFlags(argv, {
    boolFlags: ['--follow-up'],
    valueFlags: ['--run-dir'],
  });
  const runDir = requireRunDir(values, 'send');
  const text = positionals.join(' ');
  if (text === '') throw new UsageError('send', 'requires prompt text');

  const command = {
    // A caller-visible id has no purpose here (this script never correlates a `response`
    // event back to it), but the protocol accepts one and it makes events.jsonl easier to
    // read by eye, so a cheap unique one costs nothing.
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type: 'prompt',
    message: text,
  };
  // camelCase, and only on `prompt`: "followUp" is a value of prompt's streamingBehavior
  // field. `{"type":"follow_up",...}` is a DIFFERENT, unrelated top-level command in the
  // protocol; sending that snake_case string here would silently do nothing.
  if (values['--follow-up']) command.streamingBehavior = 'followUp';

  appendFileSync(path.join(runDir, 'in.jsonl'), `${JSON.stringify(command)}\n`);
  process.exit(0);
}

async function cmdSettled(argv) {
  const { values } = parseFlags(argv, { valueFlags: ['--run-dir', '--wait'] });
  const runDir = requireRunDir(values, 'settled');
  const waitSeconds = values['--wait'] !== undefined ? Number(values['--wait']) : 0;
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;

  for (;;) {
    const state = readCurrentState(runDir);
    if (state.settled) process.exit(0);
    if (state.died) process.exit(1); // it will never settle now
    if (Date.now() >= deadline) process.exit(1);
    await sleep(200);
  }
}

function cmdDead(argv) {
  const { values } = parseFlags(argv, { valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'dead');
  process.exit(existsSync(path.join(runDir, 'status.json')) ? 0 : 1);
}

function cmdRead(argv) {
  const { values } = parseFlags(argv, { boolFlags: ['--all'], valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'read');
  const state = readCurrentState(runDir);

  // Surfaced to stderr BEFORE the answer, per decision 14, and unconditionally: an
  // extension error never changes the exit code below, settled or not.
  for (const err of state.extensionErrors) {
    process.stderr.write(
      `pi-rpc: extension_error: ${err.extensionPath ?? '(unknown extension)'} (${err.event ?? '?'}): ${err.error ?? ''}\n`,
    );
  }

  if (state.settled) {
    const text = values['--all'] ? state.assistantTexts.join('\n\n') : state.lastAssistantText;
    if (text !== '') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    process.exit(state.lastAssistantText !== '' ? EXIT_SETTLED_WITH_TEXT : EXIT_SETTLED_NO_TEXT);
  }
  if (state.died) {
    process.exit(EXIT_DIED);
  }
  // Neither settled nor dead: the session is still actively running. Decision 4's table only
  // defines 0/3/4 for a FINISHED session — `read` is meant to be called after `settled --wait`
  // or `dead` has confirmed one. Rather than force a guess into that table, this prints
  // whatever partial text exists and reuses the same "not yet" signal `settled`/`dead`
  // themselves already use (exit 1). This is the one place this script's behaviour goes
  // beyond the documented three-outcome exit-code table; flagged here and in the report.
  if (state.lastAssistantText !== '') process.stdout.write(`${state.lastAssistantText}\n`);
  process.stderr.write('pi-rpc: read: session has not finished yet — call `settled --wait` or `dead` first\n');
  process.exit(1);
}

async function cmdStop(argv) {
  const { values } = parseFlags(argv, { boolFlags: ['--kill'], valueFlags: ['--run-dir'] });
  const runDir = requireRunDir(values, 'stop');
  const metaPath = path.join(runDir, 'meta.json');
  const statusPath = path.join(runDir, 'status.json');

  if (existsSync(statusPath)) {
    process.stdout.write('pi-rpc: stop: session already exited\n');
    process.exit(0);
  }
  if (!existsSync(metaPath)) {
    // The supervisor hasn't written meta.json yet (a narrow race right after `start`
    // returns) — there is nothing to signal yet. Report it rather than busy-waiting
    // indefinitely for a process that may not even have spawned `pi` yet.
    throw new UsageError('stop', `${runDir} has no session yet (meta.json not written) — try again shortly`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

  // Only the supervisor holds the actual child's stdin handle, so `stop` — a separate,
  // stateless process — cannot close it directly; it asks the supervisor to, with a plain
  // Unix signal. SIGUSR1/SIGUSR2 are otherwise unused by Node and are the conventional
  // escape hatch for exactly this "tell my own long-lived helper to do something" case.
  // Sending SIGKILL to meta.piPid directly from here (skipping the supervisor) was
  // considered and rejected: an external process guessing a bare pid risks hitting a
  // process the OS has since reused, whereas the supervisor still holds a live handle to
  // the exact child it spawned.
  try {
    process.kill(meta.supervisorPid, values['--kill'] ? 'SIGUSR2' : 'SIGUSR1');
  } catch (err) {
    process.stderr.write(`pi-rpc: stop: could not signal supervisor (pid ${meta.supervisorPid}): ${err.message}\n`);
    process.exit(1);
  }

  const deadline = Date.now() + 10_000;
  while (!existsSync(statusPath)) {
    if (Date.now() >= deadline) {
      process.stderr.write('pi-rpc: stop: timed out waiting for the session to exit\n');
      process.exit(1);
    }
    await sleep(100);
  }
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  process.stdout.write(`pi-rpc: stop: exited (code=${status.exitCode} signal=${status.signal} settled=${status.settled})\n`);
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
        throw new UsageError('pi-rpc', `unknown verb "${verb}" (expected start|send|settled|dead|read|stop)`);
    }
  } catch (err) {
    const code = typeof err?.exitCode === 'number' ? err.exitCode : 1;
    process.stderr.write(`pi-rpc: ${err.message}\n`);
    process.exit(code);
  }
}

main();
