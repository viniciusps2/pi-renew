#!/usr/bin/env bash
#
# smoke.sh — the tmux driver's live proof. NOT part of `node --test` (it needs a real model
# endpoint and a real tmux session, so a unit-test run must never depend on it). Run it by
# hand, or as a gate step, against a fresh run directory:
#
#   .claude/skills/pi-subagent-tmux/smoke.sh <run-dir>
#
# Two scenarios, both scripted so a reviewer can re-run them and both against a --no-tools
# session (via pi-tmux.js's `--` pass-through) so they cost seconds, not minutes:
#
#   Smoke:  start -> send "Reply with exactly: OK" -> settled --wait 120 -> read prints text
#           containing OK, exit 0 -> stop, and the tmux session is gone afterwards.
#   Death:  start -> send -> SIGKILL the pane's OWN process directly (not `stop --kill`, which
#           tears the tmux session down entirely and leaves nothing for capture-pane to see —
#           this instead exercises remain-on-exit the way an actual crash would) -> dead exits
#           0 and read exits 3, with the last screen on stderr.
#
# Exits non-zero on the first mismatch. Does not mock `pi` or tmux — a smoke test that never
# drives a real pane proves nothing about this driver.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_TMUX="$HERE/pi-tmux.js"

RUN_DIR_BASE="${1:?usage: smoke.sh <run-dir>}"
SMOKE_DIR="${RUN_DIR_BASE}-smoke"
DEATH_DIR="${RUN_DIR_BASE}-death"

fail() { printf 'smoke: FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'smoke: ok: %s\n' "$*"; }

session_name_for() {
  # Mirrors pi-tmux.js's own tmuxSessionNameFor exactly, read from the run's own meta.json —
  # this script never re-derives the hash itself.
  node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1] + '/meta.json','utf8')).tmuxSessionName)" "$1"
}

cleanup() {
  # Best-effort: kill whatever tmux session is still alive so a failed run doesn't leave one
  # behind (see pi-rpc.js's smoke.sh, which does the same for its own supervisor-owned child).
  for d in "$SMOKE_DIR" "$DEATH_DIR"; do
    if [ -f "$d/meta.json" ]; then
      name="$(session_name_for "$d" 2>/dev/null || true)"
      if [ -n "$name" ]; then
        tmux kill-session -t "$name" >/dev/null 2>&1 || true
      fi
    fi
  done
}
trap cleanup EXIT

rm -rf "$SMOKE_DIR" "$DEATH_DIR"

# --- Smoke: start -> send -> settled --wait -> read -> stop ----------------------------
printf 'smoke: starting the smoke-scenario session (--no-tools via pass-through)...\n'
node "$PI_TMUX" start --run-dir "$SMOKE_DIR" -- --no-tools >/dev/null
node "$PI_TMUX" send --run-dir "$SMOKE_DIR" "Reply with exactly: OK"

if ! node "$PI_TMUX" settled --run-dir "$SMOKE_DIR" --wait 120; then
  fail "smoke: session did not settle within 120s"
fi
pass "smoke: settled"

set +e
READ_OUT="$(node "$PI_TMUX" read --run-dir "$SMOKE_DIR")"
READ_RC=$?
set -e
[ "$READ_RC" -eq 0 ] || fail "smoke: read exited $READ_RC, expected 0"
case "$READ_OUT" in
  *OK*) : ;;
  *) fail "smoke: read output did not contain OK: $READ_OUT" ;;
esac
pass "smoke: read exit 0, output contains OK"

node "$PI_TMUX" stop --run-dir "$SMOKE_DIR" >/dev/null
pass "smoke: stop"

SMOKE_SESSION="$(session_name_for "$SMOKE_DIR")"
if tmux has-session -t "$SMOKE_SESSION" 2>/dev/null; then
  fail "smoke: tmux session $SMOKE_SESSION still exists after stop"
fi
pass "smoke: no tmux session left behind"

# --- Death: start -> send -> SIGKILL the pane's process -> dead / read -------------------
printf 'smoke: starting the death-scenario session...\n'
node "$PI_TMUX" start --run-dir "$DEATH_DIR" -- --no-tools >/dev/null
node "$PI_TMUX" send --run-dir "$DEATH_DIR" "Reply with exactly: OK"

DEATH_SESSION="$(session_name_for "$DEATH_DIR")"
PANE_PID="$(tmux list-panes -t "$DEATH_SESSION" -F '#{pane_pid}')"
[ -n "$PANE_PID" ] || fail "death: could not read the pane's pid"
# `stop --kill` was considered here and rejected: it tears the tmux session down entirely
# (decision 19 — "stop must leave no tmux session behind" either way), which leaves nothing
# for capture-pane to see afterwards. SIGKILL-ing the pane's own process instead leaves the
# pane present-but-dead via remain-on-exit, exercising the actual crash-detection path.
kill -KILL "$PANE_PID"

DEADLINE=$(( $(date +%s) + 10 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  node "$PI_TMUX" dead --run-dir "$DEATH_DIR" >/dev/null 2>&1 && break
  sleep 0.2
done

if node "$PI_TMUX" dead --run-dir "$DEATH_DIR"; then
  pass "death: dead exit 0"
else
  fail "death: dead exited nonzero, expected 0"
fi

set +e
node "$PI_TMUX" read --run-dir "$DEATH_DIR" >/dev/null 2>/tmp/pi-tmux-smoke-death.err
READ_DEAD_RC=$?
set -e
[ "$READ_DEAD_RC" -eq 3 ] || fail "death: read exited $READ_DEAD_RC, expected 3"
grep -q "last screen of the dead pane" /tmp/pi-tmux-smoke-death.err || fail "death: read's stderr did not carry the captured last screen"
rm -f /tmp/pi-tmux-smoke-death.err
pass "death: read exit 3, last screen captured on stderr"

node "$PI_TMUX" stop --run-dir "$DEATH_DIR" --kill >/dev/null
pass "death: stop --kill cleaned up the tmux session"

printf 'smoke: PASS\n'
