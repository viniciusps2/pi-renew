#!/usr/bin/env bash
#
# pi-agent — run `pi` as a one-shot sub-agent and return just its final answer.
#
# Drives `pi -p --mode json` (non-interactive; process exit = the stop signal),
# then extracts the last assistant message's text from the `agent_end` event.
# Tools (read/bash/edit/...) run headlessly with no approval prompt. Errors from
# the model/server surface as events and are turned into a non-zero exit.
# It stops on process exit, or after --idle s of silence while no tool is running (a running tool suspends idle).
#
# Usage:
#   pi-agent [options] "PROMPT"
#   pi-agent [options] @prompt.md          # read the prompt from a file
#   printf '...' | pi-agent [options] -     # read the prompt from stdin
#   pi-agent --extract <file.jsonl>         # recover the answer from a finished run's event stream
#
# The model is pinned to llm-1/qwen3.8-27b — not overridable, and the wrapper never does model discovery.
#
# Options:
#   -C, --cwd <dir>      Run the sub-agent in this directory
#   -t, --timeout <sec>  Absolute wall-clock ceiling in sec; 0 = disabled (default)
#       --idle <sec>     Stop after N s of no output while NO tool is running (default: computed
#                        from the loaded tool/extension surface and the prompt size — a floor of
#                        60s, more once a large surface is loaded; see SKILL.md and
#                        ../pi-driver-common/idle.js)
#       --tool-timeout <sec>  Max seconds a single tool call may run with no completion; 0 = unlimited (default)
#       --no-tools       Pure reasoning: disable all tools (fastest, safest)
#       --tools <list>   Allowlist built-in tools, e.g. read,grep,find,ls (read-only)
#       --thinking <lvl> off|minimal|low|medium|high|xhigh (default: low)
#       --system <text>  Append to the system prompt (text or @file)
#       --session <id>   Persist to a named, resumable session (default: ephemeral)
#       --session-dir <dir>  Where named sessions are stored (default: ~/.pi/agent/sessions)
#       --log <file>     Keep the raw JSONL event stream at <file> (default: a deleted temp file)
#       --extract <file> Print the final answer from an existing event stream and exit (recovery)
#       --with-ext       Keep the user's pi extensions (incl. pi-continue) loaded
#       --keep-context   Load AGENTS.md / CLAUDE.md from the cwd
#       --allow          Trust project-local files for this run (pi -a)
#       --report         Require a structured report at the end of the answer
#       --raw            Emit pi's raw JSONL event stream instead of just the answer
#   -v, --verbose        Print model / stopReason / tokens / duration to stderr
#   -h, --help           This help
#
# Following a run live:
#   The path of the JSONL event stream is printed to stderr as `pi-agent: events -> <path>`
#   the moment the sub-agent starts. Attach from another terminal with the bundled follower:
#       pi-follow <path>
#   Without --log that path is a temp file deleted when the run ends, so it is followable
#   during the run but gone afterwards. Pass --log <file> to keep it, or --session <id> to
#   also keep pi's own resumable transcript.
#
# Losing an answer to a dead wrapper:
#   The sub-agent runs in its own process group and outlives this script, so a wrapper that
#   dies late (killed, disk full, edited underfoot) leaves a COMPLETED run with nothing on
#   stdout. Two defences: run with --log, then `pi-agent --extract <that file>` replays the
#   exact same extraction; and the whole body below is wrapped in main() so bash parses the
#   entire script up front (see the note there).
#
# Exit codes: 0 ok · 2 usage · 3 no completion (server/model error) · 4 completed but empty · 124 ceiling exceeded
set -uo pipefail

# MUST be enabled here, before main() is PARSED: the trim below uses an extglob pattern inside a
# parameter expansion, and bash resolves that at parse time. Enabling it inside main() would be too
# late — the body is already parsed by then.
shopt -s extglob

die()  { printf 'pi-agent: %s\n' "$*" >&2; exit 2; }
# Print the header block (every comment line after the shebang) — no hardcoded line range,
# so editing the header above cannot silently truncate --help.
help() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0; }

# --- answer extraction ------------------------------------------------------
# Factored out so `--extract` recovers an answer from a finished run byte-for-byte the way a
# live run reports one. Args: <jsonl> <errfile|""> <rc> <dur-seconds>
emit_answer() {
  local tmp="$1" err="$2" rc="$3" dur="$4" answer stop
  local jq_final='select(.type=="agent_end") | .messages | map(select(.role=="assistant")) | last
                  | (.content // []) | map(select(.type=="text") | .text) | join("")'

  answer="$(jq -r "$jq_final" "$tmp" 2>/dev/null)"

  if ! grep -q '"type":"agent_end"' "$tmp"; then
    printf 'pi-agent: no completion (agent_end) — model/server error (rc=%s)\n' "$rc" >&2
    jq -r 'select(.type=="auto_retry_end" and .success==false) | "  error: \(.finalError)"' "$tmp" 2>/dev/null | tail -1 >&2
    jq -r 'select(.type=="extension_error") | "  extension_error: \(.error)"' "$tmp" 2>/dev/null | tail -1 >&2
    [ -n "$err" ] && [ -s "$err" ] && { printf '  stderr: '; tail -1 "$err"; } >&2
    return 3
  fi

  # trim leading/trailing whitespace (models often prefix a newline)
  answer="${answer##+([[:space:]])}"; answer="${answer%%+([[:space:]])}"

  if [ -z "$answer" ]; then
    stop="$(jq -r 'select(.type=="agent_end") | .messages | map(select(.role=="assistant")) | last | .stopReason // "unknown"' "$tmp" 2>/dev/null)"
    printf 'pi-agent: completed but produced no text (stopReason=%s)\n' "$stop" >&2
    return 4
  fi

  if [ "${VERBOSE:-0}" -eq 1 ]; then
    jq -rs 'map(select(.type=="agent_end"))[-1].messages | map(select(.role=="assistant")) | last
            | "  model=\(.model) stop=\(.stopReason) in=\(.usage.input) out=\(.usage.output) cost=\(.usage.cost.total // 0)"' \
       "$tmp" 2>/dev/null | sed "s/\$/ dur=${dur}s/" >&2
  fi

  printf '%s\n' "$answer"
  return 0
}

# --- everything else --------------------------------------------------------
# The entire executable body lives in main() ON PURPOSE. Bash reads a script incrementally from a
# file offset, so a script edited or replaced while it runs resumes mid-token and dies with a
# syntax error — after the sub-agent has already finished, which silently throws away a completed
# run's answer. A function definition is parsed as ONE unit before any of it executes, so the
# running copy can no longer change underfoot. (This is not hypothetical: regenerating a variant of
# this wrapper with `sed >` while a run was in flight is exactly how it was found.)
main() {
  command -v pi >/dev/null 2>&1 || die "pi not found on PATH"
  command -v jq >/dev/null 2>&1 || die "jq not found on PATH"
  command -v node >/dev/null 2>&1 || die "node not found on PATH"

  # Model is pinned: always llm-1/qwen3.8-27b. No -m/--model override, no PI_AGENT_MODEL, no discovery.
  # Use the fully-qualified catalog id, not a bare alias: the old pin "Q3.5-27B" stopped resolving
  # and every run then died with `Model "Q3.5-27B" not found` before emitting a single event.
  # 2026-08-13: the `qwen/qwen3.5-27b` pin went the same way — the `qwen` provider is gone from
  # `pi --list-models` and every run ended `stopReason=error` with no text. Re-pinned to the
  # llm-1 catalog id, which is what the catalog actually serves.
  # 2026-08-23: re-pinned again, llm-1/Q3.6-27B -> llm-1/qwen3.8-27b (both are in the catalog;
  # this is a deliberate upgrade, not a broken-alias fix). Note the smaller max-output window
  # (16.4K vs 190K) — ask a sub-agent for a report, not for a giant file dumped inline.
  # 2026-08-28: the 27b row was temporarily re-pinned to llm-1/Qwen3.8-Flash-Next because the 27b
  # endpoint went silent (a no-tools control prompt produced no assistant event in 120s; F131) — the
  # worst form of the broken-alias case, since the row stayed in the catalogue. As of the 2026-08-28
  # 18:08 check the 27b endpoint answers in ~1s, and on user instruction the pin is FLIPPED BACK to
  # llm-1/qwen3.8-27b (D-H87). It is also `defaultModel` in ~/.pi/agent/settings.json.
  local MODEL="llm-1/qwen3.8-27b"
  # IDLE is left UNSET here rather than defaulting to 60: with extensions and MCP tools loaded
  # the prompt reaches ~23.5K input tokens and a cold first token can take longer than a flat
  # 60s (observed: 90s) — the watchdog cannot tell "large surface, slow prefill" from "model is
  # stuck". Once PROMPT (and TOOLSMODE/WITH_EXT) are known below, IDLE is computed from the
  # shared floor formula in ../pi-driver-common/idle.js via idle-cli.js (task 6.4) — see the
  # "idle wiring" block after prompt parsing. IDLE_EXPLICIT tracks whether --idle was passed on
  # the command line, so an explicit value still reaches the watchdog verbatim (including 0).
  CWD="" ; TIMEOUT=0 ; IDLE="" ; IDLE_EXPLICIT=0 ; TOOL_TIMEOUT=0 ; THINKING="low" ; SYSTEM="" ; SESSION=""
  SESSION_DIR="" ; LOGFILE="" ; EXTRACT=""
  RAW=0 ; VERBOSE=0 ; WITH_EXT=0 ; KEEP_CTX=0 ; ALLOW=0 ; REPORT=0
  TOOLSMODE="all"   # all | none | <list>

  while [ $# -gt 0 ]; do
    case "$1" in
      -m|--model)     printf 'pi-agent: model is pinned to %s; ignoring --model %s\n' "$MODEL" "$2" >&2; shift 2 ;;
      -C|--cwd)       CWD="$2"; shift 2 ;;
      -t|--timeout)   TIMEOUT="$2"; shift 2 ;;
      --idle)         IDLE="$2"; IDLE_EXPLICIT=1; shift 2 ;;
      --tool-timeout) TOOL_TIMEOUT="$2"; shift 2 ;;
      --no-tools)     TOOLSMODE="none"; shift ;;
      --tools)        TOOLSMODE="$2"; shift 2 ;;
      --thinking)     THINKING="$2"; shift 2 ;;
      --system)       SYSTEM="$2"; shift 2 ;;
      --session)      SESSION="$2"; shift 2 ;;
      --session-dir)  SESSION_DIR="$2"; shift 2 ;;
      --log)          LOGFILE="$2"; shift 2 ;;
      --extract)      EXTRACT="$2"; shift 2 ;;
      --with-ext)     WITH_EXT=1; shift ;;
      --keep-context) KEEP_CTX=1; shift ;;
      --allow)        ALLOW=1; shift ;;
      --report)       REPORT=1; shift ;;
      --raw)          RAW=1; shift ;;
      -v|--verbose)   VERBOSE=1; shift ;;
      -h|--help)      help ;;
      --)             shift; break ;;
      -)              break ;;   # stdin sentinel (positional), not an option
      -*)             die "unknown option: $1" ;;
      *)              break ;;
    esac
  done

  # Recovery mode: no sub-agent, just re-run the extraction over an existing event stream.
  if [ -n "$EXTRACT" ]; then
    [ -r "$EXTRACT" ] || die "cannot read --extract file: $EXTRACT"
    emit_answer "$EXTRACT" "" 0 0
    exit $?
  fi

  [ $# -ge 1 ] || die "no prompt given (pass \"PROMPT\", @file, or - for stdin)"
  PROMPT="$1"
  case "$PROMPT" in
    @*) f="${PROMPT#@}"; [ -r "$f" ] || die "cannot read prompt file: $f"; PROMPT="$(cat "$f")" ;;
    -)  PROMPT="$(cat)" ;;
  esac
  [ -n "$PROMPT" ] || die "empty prompt"

  # --- idle wiring (task 6.4) -------------------------------------------------
  # ONE implementation of the idle-floor formula across all three driver skills is the spec's
  # own requirement (see ../pi-driver-common/CONTRACT.md, Rule 4); this wrapper is bash, so it
  # shells out to the shared CLI seam (../pi-driver-common/idle-cli.js) rather than
  # reimplementing computeIdleSeconds's formula here — the latter is exactly the drift
  # skills/pi-driver-common exists to prevent.
  #
  # promptBytes is the byte length of the prompt this run is actually about to send — already
  # known, no extra measurement needed. surfaceBytes: this driver does NOT do a round trip to
  # measure the loaded surface the way the RPC supervisor now does (O32) — a second `pi` spawn
  # purely to size the surface would double a one-shot run's startup for a number derivable
  # from the flags already parsed above. So it is binary: 0 when the run has neither tools nor
  # extensions loaded (TOOLSMODE=none and WITH_EXT=0), else the F90-anchored full-surface
  # constant — the same measured anchor idle.js's own header comment calls "~96KB" (23,974
  # input tokens x 4 bytes; see CONTRACT.md Rule 4). This is task 6.4's option 1 ("raise the
  # default when a large tool set is loaded") composed with its option 2 ("scale an idle floor
  # with the observed prompt size").
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  IDLE_CLI="$SCRIPT_DIR/../pi-driver-common/idle-cli.js"
  FULL_SURFACE_BYTES=95896
  PROMPT_BYTES=$(printf '%s' "$PROMPT" | wc -c)
  if [ "$TOOLSMODE" = "none" ] && [ "$WITH_EXT" -eq 0 ]; then
    SURFACE_BYTES=0
  else
    SURFACE_BYTES=$FULL_SURFACE_BYTES
  fi
  idle_cli_args=(--prompt-bytes "$PROMPT_BYTES" --surface-bytes "$SURFACE_BYTES")
  [ "$IDLE_EXPLICIT" -eq 1 ] && idle_cli_args+=(--explicit-idle "$IDLE")
  # --idle still wins everywhere, verbatim, including 0: idle_cli_args above hands
  # --explicit-idle straight to computeIdleSeconds, whose own contract returns it unchanged
  # rather than consulting the formula — this call does not special-case that itself.
  IDLE_CLI_ERR="$(mktemp -t pi-agent-idle-cli.XXXXXX.err)"
  if computed_idle="$(node "$IDLE_CLI" "${idle_cli_args[@]}" 2>"$IDLE_CLI_ERR")" && [ -n "$computed_idle" ]; then
    IDLE="$computed_idle"
  else
    printf 'pi-agent: idle-cli helper failed — falling back to the 60s floor\n' >&2
    [ -s "$IDLE_CLI_ERR" ] && cat "$IDLE_CLI_ERR" >&2
    IDLE=60
  fi
  rm -f "$IDLE_CLI_ERR"

  # --- assemble the pi command ----------------------------------------------
  cmd=(pi -p --mode json --model "$MODEL")
  [ "$WITH_EXT"  -eq 1 ] || cmd+=(--no-extensions)
  [ "$KEEP_CTX"  -eq 1 ] || cmd+=(--no-context-files)
  [ "$ALLOW"     -eq 1 ] && cmd+=(--approve)
  [ -n "$THINKING" ]     && cmd+=(--thinking "$THINKING")
  # Compose final system prompt: --system value + optional report-back contract
  FINAL_SYSTEM=""
  if [ -n "$SYSTEM" ]; then
    FINAL_SYSTEM="$SYSTEM"
  fi
  if [ "$REPORT" -eq 1 ]; then
    REPORT_BLOCK=$'\n\n## Report-back\nEnd your final answer with a structured report using these four labeled sections:\n\n- Files changed: each path + one line why (or "none")\n- Commands run: key commands executed and their result (pass/fail, test counts)\n- Acceptance: point-by-point confirmation each acceptance criterion was met\n- Findings & gaps: anything surprising, assumptions, spec gaps, follow-ups (or "none")'
    if [ -n "$FINAL_SYSTEM" ]; then
      FINAL_SYSTEM="${FINAL_SYSTEM}${REPORT_BLOCK}"
    else
      FINAL_SYSTEM="$REPORT_BLOCK"
    fi
  fi
  [ -n "$FINAL_SYSTEM" ] && cmd+=(--append-system-prompt "$FINAL_SYSTEM")
  [ -n "$SESSION_DIR" ] && cmd+=(--session-dir "$SESSION_DIR")
  if [ -n "$SESSION" ]; then cmd+=(--session-id "$SESSION"); else cmd+=(--no-session); fi
  case "$TOOLSMODE" in
    none) cmd+=(--no-tools) ;;
    all)  : ;;
    *)    cmd+=(--tools "$TOOLSMODE") ;;
  esac
  cmd+=("$PROMPT")

  # --- run ------------------------------------------------------------------
  ERR="$(mktemp -t pi-agent.XXXXXX.err)"
  if [ -n "$LOGFILE" ]; then
    # Caller-chosen transcript: survives the run, so it can be followed live AND read afterwards.
    d="$(dirname "$LOGFILE")"; [ -d "$d" ] || mkdir -p "$d" || die "cannot create --log directory: $d"
    : >"$LOGFILE" || die "cannot write --log file: $LOGFILE"
    TMP="$LOGFILE"
    trap 'rm -f "$ERR"' EXIT
  else
    TMP="$(mktemp -t pi-agent.XXXXXX.jsonl)"
    trap 'rm -f "$TMP" "$ERR"' EXIT
  fi

  # Announce the live event stream BEFORE starting, so a `pi-follow` in another terminal can
  # attach to the whole run. Without this the only transcript is an unnamed temp file and a
  # long sub-agent is a black box until it exits.
  if [ -n "$LOGFILE" ]; then
    printf 'pi-agent: events -> %s   (follow: pi-follow %s)\n' "$TMP" "$TMP" >&2
  else
    printf 'pi-agent: events -> %s   (temporary — pass --log FILE to keep it)\n' "$TMP" >&2
  fi
  if [ -n "$SESSION" ]; then
    printf 'pi-agent: session %s under %s\n' \
      "$SESSION" "${SESSION_DIR:-${PI_CODING_AGENT_SESSION_DIR:-$HOME/.pi/agent/sessions}}" >&2
  fi
  start=$(date +%s)

  # Run pi in its OWN process group (set -m) so the whole subtree can be signalled
  # by group id on an idle/ceiling stop. Killing the leader alone would orphan its
  # children (they reparent to init and survive a -P sweep of the dead leader).
  set -m
  if [ -n "$CWD" ]; then
    ( cd "$CWD" && exec "${cmd[@]}" ) >"$TMP" 2>"$ERR" &
  else
    "${cmd[@]}" >"$TMP" 2>"$ERR" &
  fi
  pid=$!
  set +m

  last_active=$start
  last_bytes=0
  tool_since=0        # time the current "a tool is in flight" streak began (0 = none pending)
  outcome=done

  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    now=$(date +%s)

    # Any new output (model tokens, tool updates, tool boundaries) counts as activity.
    bytes=$(( $(wc -c <"$TMP" 2>/dev/null || echo 0) + $(wc -c <"$ERR" 2>/dev/null || echo 0) ))
    if [ "$bytes" -ne "$last_bytes" ]; then
      last_bytes=$bytes
      last_active=$now
    fi

    # Event-aware: count tools currently in flight from the JSONL stream.
    starts=$(grep -c '"type":"tool_execution_start"' "$TMP" 2>/dev/null); starts=${starts:-0}
    ends=$(grep -c '"type":"tool_execution_end"' "$TMP" 2>/dev/null); ends=${ends:-0}
    pending=$(( starts - ends ))
    if [ "$pending" -gt 0 ]; then
      [ "$tool_since" -eq 0 ] && tool_since=$now
    else
      tool_since=0
    fi

    # Absolute wall-clock ceiling: ultimate backstop, applies regardless of tool state.
    if [ "$TIMEOUT" -gt 0 ] && [ $(( now - start )) -ge "$TIMEOUT" ]; then
      outcome=timeout
      break
    fi

    if [ "$pending" -gt 0 ]; then
      # A tool is running -> pi is busy, never idle-kill. Optionally cap a single silent tool streak.
      if [ "$TOOL_TIMEOUT" -gt 0 ] && [ $(( now - tool_since )) -ge "$TOOL_TIMEOUT" ]; then
        outcome=tooltimeout
        break
      fi
    else
      # No tool running -> apply the model-idle watchdog (true "stuck" signature).
      if [ "$IDLE" -gt 0 ] && [ $(( now - last_active )) -ge "$IDLE" ]; then
        outcome=idle
        break
      fi
    fi
  done

  if [ "$outcome" != done ]; then
    # negative pid = the whole process group (pi + every descendant)
    kill -TERM -"$pid" 2>/dev/null; sleep 1; kill -KILL -"$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null; rc=$?
  dur=$(( $(date +%s) - start ))

  # --raw: pass the event stream straight through
  if [ "$RAW" -eq 1 ]; then cat "$TMP"; exit "$rc"; fi

  if [ "$outcome" = "timeout" ]; then
    printf 'pi-agent: exceeded absolute ceiling of %ss\n' "$TIMEOUT" >&2; exit 124
  fi

  if [ "$outcome" = "tooltimeout" ]; then
    printf 'pi-agent: a tool ran %ss with no completion — stopped (treated as finished)\n' "$TOOL_TIMEOUT" >&2
  fi

  if [ "$outcome" = "idle" ]; then
    printf 'pi-agent: no output for %ss with no tool running — stopped (treated as finished)\n' "$IDLE" >&2
  fi

  emit_answer "$TMP" "$ERR" "$rc" "$dur"
  exit $?
}

main "$@"
