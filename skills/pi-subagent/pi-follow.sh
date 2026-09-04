#!/usr/bin/env bash
#
# pi-follow — watch a pi sub-agent run live, rendered for humans.
#
# `pi-agent` prints `pi-agent: events -> <path>` to stderr the moment it starts. Point this
# script at that path (or at a --session transcript) and it tails the JSONL, streaming the
# model's text as it is generated and printing one line per tool call.
#
# Usage:
#   pi-follow [options] <file>              # follow a JSONL transcript
#   pi-follow [options] --session <id>      # find that session's file and follow it
#
# Both of pi's JSONL shapes are understood, because they are different formats:
#   * the `--mode json` EVENT STREAM  (message_update / tool_execution_* / agent_end) — what
#     `pi-agent --log` writes. Carries token-by-token deltas, so text appears as it is produced.
#   * a SESSION TRANSCRIPT            (type:"message" records) — what `pi --session-id` writes.
#     Whole messages only; it gains a record when a message completes, not while it streams.
#
# Options:
#       --session <id>   Resolve <id> to a file under --session-dir instead of passing a path
#       --session-dir <dir>  Where to look (default: $PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions)
#       --wait <sec>     Seconds to wait for the file to appear (default: 60; 0 = don't wait)
#   -n, --no-follow      Render what is already there and exit (default: follow until Ctrl-C)
#       --thinking       Also render the model's reasoning stream (hidden by default — it is noisy)
#       --full           Do not truncate tool arguments and results
#       --no-color       Plain output (also implied when stdout is not a terminal)
#   -h, --help           This help
#
# Ctrl-C stops watching. It does NOT stop the sub-agent — that is a separate process.
#
# Exit codes: 0 ok · 2 usage/not-found
set -uo pipefail

die()  { printf 'pi-follow: %s\n' "$*" >&2; exit 2; }
help() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0; }

command -v jq >/dev/null 2>&1 || die "jq not found on PATH"

FILE="" ; SESSION="" ; SESSION_DIR="" ; WAIT=60 ; FOLLOW=1 ; THINK=0 ; TRUNC=180 ; COLOR=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --session)      SESSION="$2"; shift 2 ;;
    --session-dir)  SESSION_DIR="$2"; shift 2 ;;
    --wait)         WAIT="$2"; shift 2 ;;
    -n|--no-follow) FOLLOW=0; shift ;;
    --thinking)     THINK=1; shift ;;
    --full)         TRUNC=100000; shift ;;
    --no-color)     COLOR=never; shift ;;
    -h|--help)      help ;;
    --)             shift; break ;;
    -*)             die "unknown option: $1" ;;
    *)              break ;;
  esac
done
[ $# -ge 1 ] && FILE="$1"

[ -n "$FILE" ] || [ -n "$SESSION" ] || die "give a <file> or --session <id> (see --help)"

# --- resolve the file -------------------------------------------------------
# A named session lands at <dir>/[<cwd-slug>/]<timestamp>_<id>.jsonl, so the id is a suffix
# match, not a filename. Search depth-2 to cover both the flat and the per-cwd layout.
resolve() {
  if [ -n "$FILE" ]; then [ -e "$FILE" ] && printf '%s\n' "$FILE"; return; fi
  local dir="${SESSION_DIR:-${PI_CODING_AGENT_SESSION_DIR:-$HOME/.pi/agent/sessions}}"
  find "$dir" -maxdepth 2 \( -name "*_${SESSION}.jsonl" -o -name "${SESSION}.jsonl" \) 2>/dev/null \
    | while read -r f; do
        printf '%s %s\n' "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"
      done \
    | sort -rn | head -1 | cut -d' ' -f2-
}

target="$(resolve)"
if [ -z "$target" ] && [ "$WAIT" -gt 0 ]; then
  printf 'pi-follow: waiting up to %ss for the transcript to appear…\n' "$WAIT" >&2
  for _ in $(seq 1 "$WAIT"); do
    sleep 1; target="$(resolve)"; [ -n "$target" ] && break
  done
fi
[ -n "$target" ] || die "no transcript found (${FILE:-session $SESSION})"
printf 'pi-follow: %s\n' "$target" >&2

# --- colors -----------------------------------------------------------------
if [ "$COLOR" = never ] || [ ! -t 1 ]; then
  BD="" ; DIM="" ; CY="" ; GR="" ; YL="" ; RS=""
else
  BD=$'\033[1m' ; DIM=$'\033[2m' ; CY=$'\033[36m' ; GR=$'\033[32m' ; YL=$'\033[33m' ; RS=$'\033[0m'
fi

# --- the renderer -----------------------------------------------------------
# `jq -j` (no implicit newline) is what makes token deltas render as flowing text rather than
# one line per token. Every branch therefore emits its own explicit newlines.
read -r -d '' PROG <<'JQ'
def clean: tostring | gsub("\\s+"; " ");
def trunc($n): clean | if (length > $n) then .[0:$n] + "…" else . end;
def txt: [(.content // [])[] | select(.type == "text") | .text] | join("");
def calls: [(.content // [])[]
            | select(.type == "toolCall")
            | "\n  \($cy)· \(.name)\($rs) \((.arguments // {}) | trunc($trunc))"] | join("");

if .type == "session" then
  "\n\($dim)── session \(.id // "?")   cwd=\(.cwd // "?")\($rs)\n"

# ---------- pi --mode json event stream (has deltas) ----------
elif .type == "message_start" and (.message.role == "user") then
  "\n\($bd)USER\($rs)  \(.message | txt | trunc(4000))\n"

elif .type == "message_update" then
  (.assistantMessageEvent // {}) as $e
  | if   $e.type == "text_start"     then "\n\($bd)ASSISTANT\($rs)  "
    elif $e.type == "text_delta"     then ($e.delta // "")
    elif $e.type == "text_end"       then "\n"
    elif $e.type == "thinking_start" then (if $think == "1" then "\n\($dim)thinking\($rs)  " else "" end)
    elif $e.type == "thinking_delta" then (if $think == "1" then ($e.delta // "") else "" end)
    elif $e.type == "thinking_end"   then (if $think == "1" then "\n" else "" end)
    else "" end

# Deltas already printed the text and tool_execution_start prints the call, so message_end
# only contributes the meter.
elif .type == "message_end" and (.message.role == "assistant") then
  "\n\($dim)  [in \(.message.usage.input // 0)  out \(.message.usage.output // 0)"
  + "  $\(.message.usage.cost.total // 0)  stop=\(.message.stopReason // "?")]\($rs)\n"

elif .type == "tool_execution_start" then
  "\n\($cy)▸ \(.toolName // "?")\($rs) \((.args // {}) | trunc($trunc))\n"

elif .type == "tool_execution_end" then
  ([(.result.content // [])[] | select(.type == "text") | .text] | join(" ")) as $out
  | "\($gr)  → \($rs)\($out | trunc($trunc))\n"

elif .type == "agent_end" then "\n\($dim)── end\($rs)\n"

# ---------- session transcript (whole messages, no deltas) ----------
elif .type == "message" then
  (.message // {}) as $m
  | if   $m.role == "user"      then "\n\($bd)USER\($rs)  \($m | txt | trunc(4000))\n"
    elif $m.role == "assistant" then
      (if ($m | txt) != "" then "\n\($bd)ASSISTANT\($rs)  \($m | txt)\n" else "" end)
      + ($m | calls) + (if ($m | calls) != "" then "\n" else "" end)
    elif $m.role == "toolResult" then
      "\($gr)  → \($rs)\(($m | txt) | trunc($trunc))\n"
    else "" end

elif .type == "model_change" then "\($dim)   model=\(.modelId // "?")\($rs)\n"
else "" end
JQ

render() {
  jq -rj --unbuffered \
     --arg bd "$BD" --arg dim "$DIM" --arg cy "$CY" --arg gr "$GR" --arg yl "$YL" --arg rs "$RS" \
     --arg think "$THINK" --argjson trunc "$TRUNC" \
     "$PROG" 2>/dev/null
}

if [ "$FOLLOW" -eq 1 ]; then
  tail -n +1 -f "$target" | render
else
  render <"$target"
fi
printf '\n'
