#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${1:-/workspace}"
PREFIX="${TTYD_TMUX_SESSION_PREFIX:-term}"

create_session_name() {
  local ts pid rnd
  ts="$(date +%s)"
  pid="$$"
  rnd="${RANDOM:-0}"
  echo "${PREFIX}-${ts}-${pid}-${rnd}"
}

session="$(create_session_name)"
for _ in $(seq 1 10); do
  if tmux has-session -t "$session" 2>/dev/null; then
    session="$(create_session_name)"
    continue
  fi
  break
done

exec tmux new-session -s "$session" -c "$WORKDIR"

