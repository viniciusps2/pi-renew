// pi-tmux.test.js — the tmux driver's unit suite. Drives REAL tmux (never skipped if tmux is
// missing — see the brief's decision 30) against a small stub `pi` binary this file writes
// into a temp dir at runtime and puts first on PATH, so the suite needs no model and no
// network: hermetic and fast, green for reasons that are about this code and nothing else.
//
// The stub does three things, driven entirely off its OWN argv (never an env var — measured in
// this repo that a freshly-created tmux session does NOT reliably inherit a client's custom
// env vars, so anything the stub needs is passed as a CLI flag instead):
//   - if invoked with --list-models (the model-validation round trip pi-tmux.js's start makes
//     before creating anything, for an EXPLICIT --model only), prints a one-row catalogue and
//     exits 0. The driver pins no model, so most tests here pass no --model at all and never
//     reach this branch; the one that does passes an unqualified id to prove it is rejected.
//   - otherwise, parses --session-dir/--session-id and, if also given a --stub-fixture-file
//     (passed through the driver's own `-- <extra pi flags>` channel), copies that fixture's
//     content to the exact path decision 7 predicts (<session-dir>/<ts>_<sessionId>.jsonl).
//   - echoes whatever it then reads on stdin to <run-dir>/stub-stdin.log and blocks there
//     (via `exec cat`) so the tmux pane stays alive until a test kills it.
//
// Every test cleans up its own tmux session and temp dirs, including on failure — a stray tmux
// session left behind is a defect on a machine with the user's own live sessions on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_TMUX = path.join(HERE, '..', 'pi-tmux.js');
const FIXTURES_DIR = path.join(HERE, 'fixtures');

// --- the stub `pi` -----------------------------------------------------------------------

const STUB_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail

if [ "\${1:-}" = "--list-models" ]; then
  printf 'provider  model  context  max-out  thinking  images\\n'
  printf 'llm-1  qwen3.8-27b  128000  16384  true  false\\n'
  exit 0
fi

SESSION_DIR=""
SESSION_ID=""
FIXTURE_FILE=""
args=("$@")
i=0
while [ $i -lt \${#args[@]} ]; do
  case "\${args[$i]}" in
    --session-dir)        i=$((i+1)); SESSION_DIR="\${args[$i]}" ;;
    --session-id)         i=$((i+1)); SESSION_ID="\${args[$i]}" ;;
    --stub-fixture-file)  i=$((i+1)); FIXTURE_FILE="\${args[$i]}" ;;
  esac
  i=$((i+1))
done

if [ -n "$SESSION_DIR" ] && [ -n "$SESSION_ID" ] && [ -n "$FIXTURE_FILE" ] && [ -f "$FIXTURE_FILE" ]; then
  mkdir -p "$SESSION_DIR"
  cp "$FIXTURE_FILE" "$SESSION_DIR/2026-01-01T00-00-00-000Z_\${SESSION_ID}.jsonl"
fi

# dirname, NOT "$SESSION_DIR/../": the driver deliberately does not pre-create
# <run-dir>/sessions (pi-tmux.js:333 — real pi creates it only once it has something to
# persist), so a "$SESSION_DIR/.." path cannot be resolved by the kernel on any run that
# passes no fixture, the redirect fails, and the stub dies instantly — taking the pane, and
# with it the last tmux session and the whole tmux server, down with it. dirname is pure
# string manipulation and needs no directory to exist.
RUN_DIR="$(dirname "$SESSION_DIR")"
CAPTURE_FILE="$RUN_DIR/stub-stdin.log"
# "stty raw -echo" FIRST: the thing this stub stands in for is a TUI, and a TUI reads its
# terminal in raw mode. A line-oriented reader (plain cat, canonical mode) is not a faithful
# stand-in and cannot receive a paste at all: measured in this repo, tmux's paste-buffer
# translates the buffer's LF to CR by default (the documented behaviour -r turns off), so a
# canonical-mode reader gets the first line and then blocks forever on a line terminator that
# never arrives, and "send-keys Enter" does not supply one either. In raw mode the whole
# paste arrives immediately and byte-intact, which is what the send test asserts on.
#
# What this stub therefore CANNOT model: real pi requests bracketed-paste mode, so tmux's
# -p wraps the paste in ESC[200~/ESC[201~ and the TUI takes it as one paste rather than as
# embedded Enters. This stub never requests it, so the embedded newline reaches it as a bare
# CR. The live proof for the bracketed path is smoke.sh, not this suite.
stty raw -echo
exec cat > "$CAPTURE_FILE"
`;

/** Write the stub into a fresh temp dir named "pi", executable. Returns the dir. */
function makeStubDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-tmux-stub-'));
  writeFileSync(path.join(dir, 'pi'), STUB_SCRIPT, { mode: 0o755 });
  return dir;
}

const STUB_DIR = makeStubDir(); // one stub dir, shared read-only across every test in this file

// --- driving the CLI -----------------------------------------------------------------------

function run(args) {
  return spawnSync('node', [PI_TMUX, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}` },
  });
}

function newRunDir() {
  return mkdtempSync(path.join(tmpdir(), 'pi-tmux-run-'));
}

/** The exact formula pi-tmux.js's tmuxSessionNameFor uses, replicated for test assertions. */
function expectedSessionName(absRunDir) {
  const hash = createHash('sha256').update(absRunDir).digest('hex').slice(0, 12);
  return `pi-${hash}`;
}

function tmuxHasSession(name) {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

/** Best-effort teardown: kill the tmux session (if any) and remove the run dir. */
function cleanup(runDir, sessionName) {
  if (sessionName) {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  }
  rmSync(runDir, { recursive: true, force: true });
}

function readMeta(runDir) {
  return JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` (a sync function returning boolean) until it's true or the timeout elapses. */
async function waitUntil(check, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

// --- session naming: deterministic, collision-free (task 6.3's own words) -----------------

test('the session name is deterministic and matches the documented format', () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const res = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(res.status, 0, res.stderr);
    const meta = readMeta(runDir);
    sessionName = meta.tmuxSessionName;

    assert.match(sessionName, /^pi-[0-9a-f]{12}$/);
    // Deterministic: independently recomputing the formula against the SAME resolved absolute
    // run dir must produce the exact name `start` actually used.
    assert.strictEqual(sessionName, expectedSessionName(path.resolve(runDir)));
  } finally {
    cleanup(runDir, sessionName);
  }
});

test('two different run dirs yield two different session names', () => {
  const runDirA = newRunDir();
  const runDirB = newRunDir();
  const nameA = expectedSessionName(path.resolve(runDirA));
  const nameB = expectedSessionName(path.resolve(runDirB));
  assert.notStrictEqual(nameA, nameB);
  rmSync(runDirA, { recursive: true, force: true });
  rmSync(runDirB, { recursive: true, force: true });
});

test('start against a run dir whose tmux session already exists exits 2 and creates nothing', () => {
  const runDir = newRunDir();
  const collidingName = expectedSessionName(path.resolve(runDir));
  // Pre-create a tmux session under the EXACT name `start` would compute, without going
  // through pi-tmux.js at all — this proves the guard checks the real tmux session table, not
  // just meta.json.
  const created = spawnSync('tmux', ['new-session', '-d', '-s', collidingName, '-c', '/tmp', 'sleep', '30'], {
    stdio: 'ignore',
  });
  assert.strictEqual(created.status, 0, 'test setup: could not pre-create the colliding tmux session');
  try {
    const res = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(res.status, 2, res.stderr);
    assert.ok(!existsSync(path.join(runDir, 'meta.json')), 'start must not have written meta.json');
  } finally {
    cleanup(runDir, collidingName);
  }
});

// --- death: dead-pane detection maps to the "died" exit code (task 6.3's own words) --------

test('a killed pane is detected as dead, and read reports it as died with the captured screen', async () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const startRes = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(startRes.status, 0, startRes.stderr);
    const meta = readMeta(runDir);
    sessionName = meta.tmuxSessionName;

    // Alive before the kill.
    const deadBefore = run(['dead', '--run-dir', runDir]);
    assert.strictEqual(deadBefore.status, 1, 'expected the pane to be alive immediately after start');

    const paneList = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { encoding: 'utf8' });
    assert.strictEqual(paneList.status, 0, paneList.stderr);
    const panePid = Number(paneList.stdout.trim().split('\n')[0]);
    assert.ok(Number.isInteger(panePid) && panePid > 0, `bad pane pid: ${paneList.stdout}`);
    process.kill(panePid, 'SIGKILL');

    const becameDead = await waitUntil(() => run(['dead', '--run-dir', runDir]).status === 0, { timeoutMs: 5000 });
    assert.ok(becameDead, 'pane did not report dead within 5s of SIGKILL');

    const readRes = run(['read', '--run-dir', runDir]);
    assert.strictEqual(readRes.status, 3, `expected exit 3 (died), got ${readRes.status}: ${readRes.stderr}`);
    assert.match(readRes.stderr, /last screen of the dead pane/);
  } finally {
    cleanup(runDir, sessionName);
  }
});

// --- send: byte-intact delivery, asserted against what the stub actually received ----------

test('send delivers multi-line text containing $, " and a backtick byte-intact', async () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const startRes = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(startRes.status, 0, startRes.stderr);
    sessionName = readMeta(runDir).tmuxSessionName;

    const text = 'line one $VAR "quoted" `backtick`\nline two, still one send call';
    const sendRes = run(['send', '--run-dir', runDir, text]);
    assert.strictEqual(sendRes.status, 0, sendRes.stderr);

    const captureFile = path.join(runDir, 'stub-stdin.log');
    const arrived = await waitUntil(() => existsSync(captureFile) && readFileSync(captureFile, 'utf8').includes('still one send call'), {
      timeoutMs: 5000,
    });
    assert.ok(arrived, 'the stub never received the sent text');

    const captured = readFileSync(captureFile, 'utf8');
    // Byte-intact: every line of the ORIGINAL text appears verbatim, dollar sign, quotes and
    // backtick unmangled — asserted against what the stub actually received, never the pane.
    for (const line of text.split('\n')) {
      assert.ok(captured.includes(line), `capture is missing the exact line: ${JSON.stringify(line)}\ngot: ${JSON.stringify(captured)}`);
    }
  } finally {
    cleanup(runDir, sessionName);
  }
});

// --- settled: an absent session file is "not yet", never a throw ---------------------------

test('settled on a session whose file does not exist yet exits 1 and does not throw', () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const startRes = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(startRes.status, 0, startRes.stderr);
    sessionName = readMeta(runDir).tmuxSessionName;

    // The stub never writes a session file unless handed --stub-fixture-file, so this session
    // has none — exactly the "no assistant message yet" case.
    assert.ok(!existsSync(path.join(runDir, 'sessions')), 'test invariant: no sessions dir should exist yet');

    const res = run(['settled', '--run-dir', runDir, '--wait', '1']);
    assert.strictEqual(res.status, 1);
    assert.strictEqual(res.signal, null, 'settled must not crash/throw — no signal, a clean exit 1');
  } finally {
    cleanup(runDir, sessionName);
  }
});

// --- stop: leaves no tmux session behind ----------------------------------------------------

test('stop leaves no tmux session behind', () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const startRes = run(['start', '--run-dir', runDir, '--', '--no-tools']);
    assert.strictEqual(startRes.status, 0, startRes.stderr);
    sessionName = readMeta(runDir).tmuxSessionName;
    assert.ok(tmuxHasSession(sessionName), 'test invariant: session should exist right after start');

    const stopRes = run(['stop', '--run-dir', runDir, '--kill']);
    assert.strictEqual(stopRes.status, 0, stopRes.stderr);
    assert.ok(!tmuxHasSession(sessionName), 'tmux session must be gone after stop');
  } finally {
    cleanup(runDir, sessionName);
  }
});

// --- usage errors: exit 2, and create nothing -----------------------------------------------

test('a usage error (missing --run-dir) exits 2 and creates nothing', () => {
  const res = run(['start']);
  assert.strictEqual(res.status, 2);
});

test('a usage error (unqualified model id) exits 2, creates no run dir, no tmux session', () => {
  const runDir = newRunDir();
  rmSync(runDir, { recursive: true, force: true }); // start must create it itself, or not at all
  try {
    const res = run(['start', '--run-dir', runDir, '--model', 'qwen3.8-27b']);
    assert.strictEqual(res.status, 2);
    assert.ok(!existsSync(runDir), 'the unqualified model id must be rejected before the run dir is created');
    const sessionName = expectedSessionName(path.resolve(runDir));
    assert.ok(!tmuxHasSession(sessionName), 'no tmux session may have been created for a rejected model id');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// --- bonus: exercises decision 7 (uuid-embedded filename discovery) end-to-end against a ----
// real, previously-captured fixture, through real tmux and the real glob-by-uuid logic.

test('read returns the fixture answer once the stub writes a settled session file (decision 7, end to end)', () => {
  const runDir = newRunDir();
  let sessionName;
  try {
    const fixturePath = path.join(FIXTURES_DIR, 'session-settled.jsonl');
    const startRes = run(['start', '--run-dir', runDir, '--', '--no-tools', '--stub-fixture-file', fixturePath]);
    assert.strictEqual(startRes.status, 0, startRes.stderr);
    sessionName = readMeta(runDir).tmuxSessionName;

    const settledRes = run(['settled', '--run-dir', runDir, '--wait', '5']);
    assert.strictEqual(settledRes.status, 0, `expected settled within 5s; stderr: ${settledRes.stderr}`);

    const readRes = run(['read', '--run-dir', runDir]);
    assert.strictEqual(readRes.status, 0, readRes.stderr);
    assert.strictEqual(readRes.stdout.trim(), 'REDACTED-assistant-text');
  } finally {
    cleanup(runDir, sessionName);
  }
});

// --- verb surface: exactly six verbs, no seventh --------------------------------------------

test('an unknown verb exits 2 (the driver accepts exactly the documented six verbs)', () => {
  const res = run(['status']); // not one of start|send|settled|dead|read|stop
  assert.strictEqual(res.status, 2);
});
