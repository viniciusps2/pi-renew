#!/usr/bin/env bash
#
# cross-verify.sh — cross-verification of the two long-lived `pi` drivers. NOT part of
# `node --test` (it needs a live model endpoint and a real tmux session, so an offline
# unit-test run must never depend on it). Run it by hand:
#
#   skills/pi-driver-common/cross-verify.sh <run-dir>
#
# Proves that pi-subagent-rpc and pi-subagent-tmux AGREE: identical exit codes at every
# step, and identical captured answer text (by the "contains" rule both smoke.sh files
# use — never a byte-compare of raw model output), across two scripted scenarios:
#
#   Scenario A — the trivial session: one turn, "Reply with exactly: OK"
#   Scenario B — the scripted restart: two turns, "TURN-ONE" then "TURN-TWO", on the same
#                long-lived session; the driver must report settled only after the SECOND
#                turn's answer is in.
#
# Endpoint-gated: a 20s CONTROL-OK probe runs first; if the endpoint is down, the script
# prints a SKIP line and exits 0 (a down endpoint is not a defect in the drivers).
#
# Does not mock `pi` or tmux — a cross-verify that never drives a real `pi` proves
# nothing about the agreement of the two backends.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PI_RPC="$REPO_ROOT/.claude/skills/pi-subagent-rpc/pi-rpc.js"
PI_TMUX="$REPO_ROOT/.claude/skills/pi-subagent-tmux/pi-tmux.js"

MODEL="llm-1/qwen3.8-27b"

RUN_DIR_BASE="${1:?usage: cross-verify.sh <run-dir>}"
RPC_A_DIR="$RUN_DIR_BASE/rpc-A"
TMUX_A_DIR="$RUN_DIR_BASE/tmux-A"
RPC_B_DIR="$RUN_DIR_BASE/rpc-B"
TMUX_B_DIR="$RUN_DIR_BASE/tmux-B"

fail() { printf 'cross-verify: FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'cross-verify: ok: %s\n' "$*"; }

# --- Control probe: is the model endpoint answering? ---------------------------------
printf 'cross-verify: running control probe (20s deadline)...\n'
PROBE_OUT=""
PROBE_RC=0
PROBE_OUT=$(timeout 20 pi -p --mode json -ne -nt --no-session --model "$MODEL" "Reply with exactly: CONTROL-OK" 2>/dev/null) || PROBE_RC=$?
if [ "$PROBE_RC" -ne 0 ]; then
  printf 'cross-verify: SKIP — model endpoint not answering; live cross-verification cannot run\n'
  exit 0
fi
case "$PROBE_OUT" in
  *CONTROL-OK*) pass "control probe: endpoint is up" ;;
  *)
    printf 'cross-verify: SKIP — model endpoint not answering; live cross-verification cannot run\n'
    exit 0
    ;;
esac

# --- tmux session-name helper (mirrors pi-tmux.js's own scheme) ---------------------
tmux_session_name_for() {
  node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1] + '/meta.json','utf8')).tmuxSessionName)" "$1" 2>/dev/null || true
}

# --- Cleanup trap: stop/kill any driver session left running ------------------------
cleanup() {
  for d in "$RPC_A_DIR" "$RPC_B_DIR"; do
    if [ -f "$d/meta.json" ] && [ ! -f "$d/status.json" ]; then
      node "$PI_RPC" stop --run-dir "$d" --kill >/dev/null 2>&1 || true
    fi
  done
  for d in "$TMUX_A_DIR" "$TMUX_B_DIR"; do
    if [ -f "$d/meta.json" ]; then
      name="$(tmux_session_name_for "$d")"
      if [ -n "$name" ]; then
        tmux kill-session -t "$name" >/dev/null 2>&1 || true
      fi
    fi
  done
}
trap cleanup EXIT

# Freshness: drivers refuse a run-dir with existing state (meta.json / tmux session).
rm -rf "$RPC_A_DIR" "$TMUX_A_DIR" "$RPC_B_DIR" "$TMUX_B_DIR"

# --- run_driver helper ----------------------------------------------------------------
# Drives one driver through one scenario. Sets LAST_READ_OUT (A) or B1_READ_OUT /
# B2_READ_OUT (B) for the caller to capture. Fails the whole run on the first mismatch.
run_driver() {
  local driver="$1" run_dir="$2" scenario="$3"
  local driver_script=""
  local pass_flags=""

  case "$driver" in
    rpc)  driver_script="$PI_RPC";  pass_flags="-nt -ne -nc" ;;
    tmux) driver_script="$PI_TMUX"; pass_flags="--no-tools" ;;
    *) fail "internal: unknown driver '$driver'" ;;
  esac

  # start
  node "$driver_script" start --run-dir "$run_dir" -- $pass_flags >/dev/null \
    || fail "$driver/$scenario: start failed (exit $?)"
  pass "$driver/$scenario: start"

  case "$scenario" in
    A)
      node "$driver_script" send --run-dir "$run_dir" "Reply with exactly: OK" \
        || fail "$driver/$scenario: send failed"
      pass "$driver/$scenario: send"

      if ! node "$driver_script" settled --run-dir "$run_dir" --wait 120; then
        fail "$driver/$scenario: settled --wait 120 did not exit 0"
      fi
      pass "$driver/$scenario: settled (exit 0)"

      set +e
      LAST_READ_OUT="$(node "$driver_script" read --run-dir "$run_dir")"
      local rc=$?
      set -e
      [ "$rc" -eq 0 ] || fail "$driver/$scenario: read exited $rc, expected 0"
      case "$LAST_READ_OUT" in
        *OK*) pass "$driver/$scenario: read exit 0, contains OK" ;;
        *) fail "$driver/$scenario: read output did not contain OK: $LAST_READ_OUT" ;;
      esac

      node "$driver_script" stop --run-dir "$run_dir" >/dev/null \
        || fail "$driver/$scenario: stop failed"
      pass "$driver/$scenario: stop"
      ;;

    B)
      # Turn 1
      node "$driver_script" send --run-dir "$run_dir" "Reply with exactly: TURN-ONE" \
        || fail "$driver/$scenario: send TURN-ONE failed"
      pass "$driver/$scenario: send TURN-ONE"

      if ! node "$driver_script" settled --run-dir "$run_dir" --wait 120; then
        fail "$driver/$scenario: settled (turn 1) did not exit 0"
      fi
      pass "$driver/$scenario: settled turn 1 (exit 0)"

      set +e
      B1_READ_OUT="$(node "$driver_script" read --run-dir "$run_dir")"
      local rc=$?
      set -e
      [ "$rc" -eq 0 ] || fail "$driver/$scenario: read (turn 1) exited $rc, expected 0"
      case "$B1_READ_OUT" in
        *TURN-ONE*) pass "$driver/$scenario: read turn 1 contains TURN-ONE" ;;
        *) fail "$driver/$scenario: read turn 1 did not contain TURN-ONE: $B1_READ_OUT" ;;
      esac

      # Turn 2. A brief stabilization delay lets the driver observe the new turn's start
      # (the RPC supervisor's ~200ms poll + pi's agent_start; the tmux pane's new user
      # message in the session file) before we begin the settled wait. Without it, the
      # first poll of settled --wait can see the PREVIOUS turn's agent_settled as the last
      # agent event and exit 0 prematurely — the exact race the brief's "non-vacuous core"
      # section describes as the failure mode this scenario guards against.
      node "$driver_script" send --run-dir "$run_dir" "Reply with exactly: TURN-TWO" \
        || fail "$driver/$scenario: send TURN-TWO failed"
      pass "$driver/$scenario: send TURN-TWO"
      sleep 2

      if ! node "$driver_script" settled --run-dir "$run_dir" --wait 120; then
        fail "$driver/$scenario: settled (turn 2) did not exit 0"
      fi
      pass "$driver/$scenario: settled turn 2 (exit 0)"

      set +e
      B2_READ_OUT="$(node "$driver_script" read --run-dir "$run_dir")"
      local rc=$?
      set -e
      [ "$rc" -eq 0 ] || fail "$driver/$scenario: read (turn 2) exited $rc, expected 0"
      case "$B2_READ_OUT" in
        *TURN-TWO*) pass "$driver/$scenario: read turn 2 contains TURN-TWO" ;;
        *) fail "$driver/$scenario: read turn 2 did not contain TURN-TWO: $B2_READ_OUT" ;;
      esac

      node "$driver_script" stop --run-dir "$run_dir" >/dev/null \
        || fail "$driver/$scenario: stop failed"
      pass "$driver/$scenario: stop"
      ;;
  esac
}

# --- Scenario A: the trivial session, both drivers ------------------------------------
printf 'cross-verify: Scenario A (trivial) — driving RPC...\n'
run_driver rpc "$RPC_A_DIR" A
A_RPC_OUT="$LAST_READ_OUT"

printf 'cross-verify: Scenario A (trivial) — driving tmux...\n'
run_driver tmux "$TMUX_A_DIR" A
A_TMUX_OUT="$LAST_READ_OUT"

# Cross-driver comparison: both drivers' captured texts must contain OK.
case "$A_RPC_OUT" in
  *OK*) pass "cross-driver: rpc-A contains OK" ;;
  *) fail "cross-driver: rpc-A read does not contain OK" ;;
esac
case "$A_TMUX_OUT" in
  *OK*) pass "cross-driver: tmux-A contains OK" ;;
  *) fail "cross-driver: tmux-A read does not contain OK" ;;
esac

# --- Scenario B: the scripted restart (two turns), both drivers ----------------------
printf 'cross-verify: Scenario B (two-turn) — driving RPC...\n'
run_driver rpc "$RPC_B_DIR" B
B_RPC_T1="$B1_READ_OUT"
B_RPC_T2="$B2_READ_OUT"

printf 'cross-verify: Scenario B (two-turn) — driving tmux...\n'
run_driver tmux "$TMUX_B_DIR" B
B_TMUX_T1="$B1_READ_OUT"
B_TMUX_T2="$B2_READ_OUT"

# Cross-driver comparison: both drivers' turn-1 must contain TURN-ONE, turn-2 must
# contain TURN-TWO. (A driver that settled turn 2 too early — before its assistant
# message landed — would surface turn-1's text on the second read, failing here.)
case "$B_RPC_T1" in
  *TURN-ONE*) pass "cross-driver: rpc-B turn 1 contains TURN-ONE" ;;
  *) fail "cross-driver: rpc-B turn 1 does not contain TURN-ONE" ;;
esac
case "$B_TMUX_T1" in
  *TURN-ONE*) pass "cross-driver: tmux-B turn 1 contains TURN-ONE" ;;
  *) fail "cross-driver: tmux-B turn 1 does not contain TURN-ONE" ;;
esac
case "$B_RPC_T2" in
  *TURN-TWO*) pass "cross-driver: rpc-B turn 2 contains TURN-TWO" ;;
  *) fail "cross-driver: rpc-B turn 2 does not contain TURN-TWO" ;;
esac
case "$B_TMUX_T2" in
  *TURN-TWO*) pass "cross-driver: tmux-B turn 2 contains TURN-TWO" ;;
  *) fail "cross-driver: tmux-B turn 2 does not contain TURN-TWO" ;;
esac

# --- Final verdict ---------------------------------------------------------------------
printf 'cross-verify: PASS\n'
