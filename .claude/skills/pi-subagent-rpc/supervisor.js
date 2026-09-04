#!/usr/bin/env node
//
// supervisor — the detached process `pi-rpc start` spawns to own one `pi --mode rpc` child
// for the lifetime of a session. Not meant to be run by hand; `pi-rpc.js` spawns it with
// `detached: true` and `unref()`s it immediately, so it keeps running after `start` has
// already returned and its shell has moved on. Everything it does is file- and
// signal-based, because its only contact with the rest of the world is:
//   - the run directory's files (in.jsonl to read, events.jsonl/stderr.log/status.json to
//     write) — see the layout comment at the top of pi-rpc.js;
//   - two Unix signals from `pi-rpc.js stop`, since a separate `stop` invocation has no
//     other way to reach a child stdin handle it doesn't own (SIGUSR1 = close stdin
//     gracefully, SIGUSR2 = SIGKILL the child now).
//
// This process is intentionally dumb: it does not decide "settled" or "died" for anyone —
// that judgement is `session.js`'s, applied later by a stateless reader over events.jsonl
// and this file's own status.json. All this process does is relay bytes, watch two
// timeouts, and record how `pi` exited.

import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { computeIdleSeconds, IdleWatchdog, surfaceBytesFromCatalogue } from '../pi-driver-common/idle.js';
import { JsonlDecoder } from '../pi-driver-common/jsonl.js';
import { foldEvents } from '../pi-driver-common/session.js';

function parseArgs(argv) {
  const values = {};
  let extra = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      extra = argv.slice(i + 1);
      break;
    }
    if (arg === '--approve') {
      values.approve = true;
    } else if (['--run-dir', '--model', '--cwd', '--idle', '--timeout'].includes(arg)) {
      i += 1;
      values[arg.slice(2)] = argv[i];
    }
  }
  return { values, extra };
}

function main() {
  const { values, extra } = parseArgs(process.argv.slice(2));
  const runDir = values['run-dir'];
  const model = values.model;
  const cwd = values.cwd ?? process.cwd();
  const approve = Boolean(values.approve);
  const explicitIdle = values.idle !== undefined ? Number(values.idle) : undefined;
  const timeoutSeconds = values.timeout !== undefined ? Number(values.timeout) : 0;

  const eventsPath = path.join(runDir, 'events.jsonl');
  const stderrPath = path.join(runDir, 'stderr.log');
  const statusPath = path.join(runDir, 'status.json');
  const inPath = path.join(runDir, 'in.jsonl');
  const metaPath = path.join(runDir, 'meta.json');

  const eventsStream = createWriteStream(eventsPath, { flags: 'a' });
  const stderrStream = createWriteStream(stderrPath, { flags: 'a' });
  const narrate = (line) => stderrStream.write(`pi-rpc: supervisor: ${line}\n`);

  // Extensions and AGENTS.md/CLAUDE.md discovery off (mirrors pi-agent.sh's own "isolate the
  // run" defaults; see the header comment in pi-rpc.js for why tools are deliberately left
  // on). -ne leaves an explicit `-e <path>` still working, so this does not forbid a caller
  // from loading one via the pass-through extra args below.
  //
  // The session IS persisted, under the run directory — deliberately, and unlike the
  // one-shot driver, which is ephemeral because a one-shot run has nothing to persist. A
  // long-lived driver does: the session file is the only artifact that carries a session id
  // and its lineage, the tmux backend's shared discipline names it as the source of truth
  // for state, and a caller asserting on session-level behaviour cannot do so against a
  // session `pi` never wrote. A caller that genuinely wants an ephemeral run can append
  // `-- --no-session` (pi is last-flag-wins).
  const sessionDir = path.join(runDir, 'sessions');
  const piArgs = ['--mode', 'rpc', '--model', model, '--session-dir', sessionDir, '-ne', '-nc'];
  if (approve) piArgs.push('--approve');
  piArgs.push(...extra);

  // Own process group (detached), so an idle/timeout kill can signal the whole subtree —
  // including any tool subprocess `pi` itself spawned — the same way pi-agent.sh signals
  // -"$pid" rather than just "$pid" for exactly that reason.
  const child = spawn('pi', piArgs, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

  // `let`, not `const`: O32 below recomputes this once the surface is actually measured.
  let idleSeconds = computeIdleSeconds({ explicitIdle });
  const watchdog = new IdleWatchdog({ idleSeconds });
  // The idle watchdog only applies while a run is actively streaming. Without this gate a
  // long-lived session sitting idle between two `send` calls — its NORMAL resting state —
  // would eventually be killed for "no output", which is exactly the failure this driver
  // exists to avoid. Tracked directly off the same two events session.js's settle rule
  // uses, so it can never disagree with what a reader later concludes was "settled".
  let runActive = false;
  /** @type {Array<object>} */
  const parsedEvents = [];
  const decoder = new JsonlDecoder();

  // Captured once, at spawn, and reused by every later meta.json rewrite (see the O32 rewrite
  // below) so a re-measured idleSeconds doesn't also drift startedAt.
  let metaStartedAt;
  const writeMeta = () => {
    writeFileSync(
      metaPath,
      JSON.stringify({
        model,
        cwd,
        approve,
        idleSeconds,
        startedAt: metaStartedAt,
        supervisorPid: process.pid,
        piPid: child.pid,
      }),
    );
  };

  child.on('spawn', () => {
    // Written once we actually have a piPid — see the file-layout comment in pi-rpc.js for
    // why meta.json cannot be written any earlier than this by anyone.
    metaStartedAt = new Date().toISOString();
    writeMeta();

    // O32: the idle floor computed above (computeIdleSeconds({ explicitIdle })) has no size
    // information yet, so with no --idle override it sits at the bare 60s floor for every RPC
    // session regardless of how large the loaded tool/extension surface actually is — exactly
    // the gap task 6.4 owns closing. A single get_commands round trip answers in ~1.5s with NO
    // model call (measured: bare surface 277 bytes/1 command, full surface 26,710 bytes/64
    // commands — both answer this fast), so this costs nothing even while the model endpoint
    // itself is down. get_state was considered and rejected: measured FLAT at 892 bytes
    // regardless of surface (see CONTRACT.md Rule 4), which makes it useless as a size proxy.
    // Skipped entirely when the caller already pinned --idle: an explicit choice always wins
    // over a computed guess (decision 26).
    if (explicitIdle === undefined && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ id: 'idle-probe-1', type: 'get_commands' })}\n`);
    }
  });

  child.stdout.on('data', (chunk) => {
    // Byte-for-byte, verbatim, before any parsing: events.jsonl is the source of truth pi
    // itself wrote, not a re-serialisation of whatever this process understood of it.
    eventsStream.write(chunk);
    for (const line of decoder.push(chunk)) {
      if (line === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // never let a malformed line crash the supervisor mid-session
      }
      parsedEvents.push(event);
      watchdog.feed(event);
      if (event.type === 'agent_start') runActive = true;
      else if (event.type === 'agent_settled') runActive = false;
      else if (event.type === 'response' && event.command === 'get_commands' && explicitIdle === undefined) {
        // O32's other half: recompute from the ACTUAL measured surface and apply it to the
        // live watchdog and to meta.json, so a reader that opens meta.json after this point
        // sees the number actually in force. `line` is the raw JSONL text this event was
        // decoded from — byte length, not JS string .length, matches the measured anchor
        // (Buffer.byteLength, not .length, in case a catalogue entry has non-ASCII text).
        // Confirmed (see the report's Measurement provenance section): foldEvents's switch
        // has no `response` case, so this extra line in events.jsonl falls through its
        // `default: break` and changes no folded state — this response event is read here,
        // live, off the parsed stream, not through foldEvents.
        idleSeconds = computeIdleSeconds({ surfaceBytes: surfaceBytesFromCatalogue(Buffer.byteLength(line, 'utf8')) });
        watchdog.idleSeconds = idleSeconds;
        writeMeta();
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrStream.write(chunk);
  });

  // Poll in.jsonl for lines `send` has appended since the last poll, and forward each to the
  // child's stdin followed by exactly one \n. Polling a plain file, rather than a FIFO, is
  // the point (see pi-rpc.js's header comment on why a FIFO was rejected): any number of
  // `send` invocations, run as separate processes at any time, can append to this file
  // without needing a permanent reader held open for correctness.
  let forwardedChars = 0;
  const inTailTimer = setInterval(() => {
    if (!child.stdin.writable) return;
    let content;
    try {
      content = readFileSync(inPath, 'utf8');
    } catch {
      return;
    }
    if (content.length <= forwardedChars) return;
    const newPart = content.slice(forwardedChars);
    const lastNewline = newPart.lastIndexOf('\n');
    if (lastNewline === -1) return; // a line is still being written; wait for its \n
    const complete = newPart.slice(0, lastNewline + 1);
    forwardedChars += complete.length;
    for (const line of complete.split('\n')) {
      if (line === '') continue;
      child.stdin.write(`${line}\n`);
    }
  }, 100);

  const startedAtMs = Date.now();
  let killEscalated = false;
  let finished = false;
  const watchdogTimer = setInterval(() => {
    if (finished) return;
    if (timeoutSeconds > 0 && (Date.now() - startedAtMs) / 1000 >= timeoutSeconds) {
      narrate(`absolute ceiling of ${timeoutSeconds}s exceeded — sending SIGTERM`);
      killChild('SIGTERM');
      return;
    }
    if (runActive && watchdog.timedOut()) {
      narrate(`idle for ${idleSeconds}s with no tool running — sending SIGTERM`);
      killChild('SIGTERM');
    }
  }, 1000);

  function killChild(signal) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
    if (signal === 'SIGTERM' && !killEscalated) {
      killEscalated = true;
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 1000);
    }
  }

  // `pi-rpc.js stop` cannot reach the child's stdin directly (it doesn't own the handle), so
  // it asks this process via a plain signal instead. See the longer comment in pi-rpc.js's
  // cmdStop for why SIGUSR1/SIGUSR2 and why not a direct kill of the child pid from there.
  process.on('SIGUSR1', () => {
    narrate('stop requested — closing stdin');
    if (child.stdin.writable) child.stdin.end();
  });
  process.on('SIGUSR2', () => {
    narrate('stop --kill requested — sending SIGKILL');
    killChild('SIGKILL');
  });

  const finish = (exitCode, signal) => {
    if (finished) return;
    finished = true;
    clearInterval(inTailTimer);
    clearInterval(watchdogTimer);
    const settled = foldEvents(parsedEvents, { ended: true }).settled;
    writeFileSync(
      statusPath,
      JSON.stringify({ exitCode, signal, settled, endedAt: new Date().toISOString() }),
    );
    // Both streams are async: calling end() only SCHEDULES the flush, so exiting straight
    // after it can drop whatever is still buffered — and the tail is exactly where
    // agent_settled and the final assistant text live, which is what a later `read` folds.
    // status.json is written synchronously above and so is never at risk; events.jsonl is,
    // so wait for both to close before exiting.
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) process.exit(0);
    };
    eventsStream.end(done);
    stderrStream.end(done);
  };

  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => {
    // e.g. `pi` not on PATH. There is no child to have exited, so there is nothing settled
    // could ever mean here — record it as a death (no agent_settled, by construction) and
    // move the failure into stderr.log where a human debugging a stuck run will look.
    narrate(`failed to start pi: ${err.message}`);
    finish(null, null);
  });
}

main();
