#!/usr/bin/env bash
#
# smoke.sh — the RPC driver's live proof. NOT part of `node --test` (it needs a real model
# endpoint and costs real seconds, so a unit-test run must never depend on it). Run it by
# hand, or as a gate step, against a fresh run directory:
#
#   .claude/skills/pi-subagent-rpc/smoke.sh <run-dir>
#
# Two scenarios, both scripted so a reviewer can re-run them and both against a --no-tools
# session (via pi-rpc.js's `--` pass-through) so they cost seconds, not minutes:
#
#   Smoke:  start -> send "Reply with exactly: OK" -> settled --wait 120 -> read prints text
#           containing OK, exit 0 -> stop, and the run directory afterwards contains a
#           non-empty events.jsonl whose last event is agent_settled.
#   Death:  start -> send -> stop --kill while it is streaming -> dead exits 0 and read
#           exits 3.
#
# Exits non-zero on the first mismatch. Does not mock `pi` — a smoke test that never runs
# `pi` proves nothing about this driver.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_RPC="$HERE/pi-rpc.js"

RUN_DIR_BASE="${1:?usage: smoke.sh <run-dir>}"
SMOKE_DIR="${RUN_DIR_BASE}-smoke"
DEATH_DIR="${RUN_DIR_BASE}-death"

fail() { printf 'smoke: FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'smoke: ok: %s\n' "$*"; }

cleanup() {
  # Best-effort: stop whatever is still alive so a failed run doesn't leave an orphaned `pi`
  # behind to pin the model it loaded for the next run (see pi-agent.sh's own trap note).
  for d in "$SMOKE_DIR" "$DEATH_DIR"; do
    if [ -f "$d/meta.json" ] && [ ! -f "$d/status.json" ]; then
      node "$PI_RPC" stop --run-dir "$d" --kill >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

rm -rf "$SMOKE_DIR" "$DEATH_DIR"

# --- Smoke: start -> send -> settled --wait -> read -> stop ----------------------------
printf 'smoke: starting the smoke-scenario session (--no-tools via pass-through)...\n'
node "$PI_RPC" start --run-dir "$SMOKE_DIR" -- -nt -ne -nc >/dev/null
node "$PI_RPC" send --run-dir "$SMOKE_DIR" "Reply with exactly: OK"

if ! node "$PI_RPC" settled --run-dir "$SMOKE_DIR" --wait 120; then
  fail "smoke: session did not settle within 120s"
fi
pass "smoke: settled"

set +e
READ_OUT="$(node "$PI_RPC" read --run-dir "$SMOKE_DIR")"
READ_RC=$?
set -e
[ "$READ_RC" -eq 0 ] || fail "smoke: read exited $READ_RC, expected 0"
case "$READ_OUT" in
  *OK*) : ;;
  *) fail "smoke: read output did not contain OK: $READ_OUT" ;;
esac
pass "smoke: read exit 0, output contains OK"

node "$PI_RPC" stop --run-dir "$SMOKE_DIR" >/dev/null
pass "smoke: stop"

[ -s "$SMOKE_DIR/events.jsonl" ] || fail "smoke: events.jsonl is empty"
LAST_EVENT_TYPE="$(tail -1 "$SMOKE_DIR/events.jsonl" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(d).type || ""); } catch { process.stdout.write(""); }
  });
')"
[ "$LAST_EVENT_TYPE" = "agent_settled" ] || fail "smoke: last event was \"$LAST_EVENT_TYPE\", expected agent_settled"
pass "smoke: events.jsonl non-empty, last event is agent_settled"

# --- Death: start -> send -> stop --kill while streaming -> dead / read -----------------
printf 'smoke: starting the death-scenario session...\n'
node "$PI_RPC" start --run-dir "$DEATH_DIR" -- -nt -ne -nc >/dev/null
node "$PI_RPC" send --run-dir "$DEATH_DIR" "Reply with exactly: OK"
# No settle wait here on purpose: --kill needs to land while the run is still in flight, not
# after it has already finished on its own.
node "$PI_RPC" stop --run-dir "$DEATH_DIR" --kill >/dev/null

if node "$PI_RPC" dead --run-dir "$DEATH_DIR"; then
  pass "death: dead exit 0"
else
  fail "death: dead exited nonzero, expected 0"
fi

set +e
node "$PI_RPC" read --run-dir "$DEATH_DIR" >/dev/null 2>&1
READ_DEAD_RC=$?
set -e
[ "$READ_DEAD_RC" -eq 3 ] || fail "death: read exited $READ_DEAD_RC, expected 3"
pass "death: read exit 3"

printf 'smoke: PASS\n'
