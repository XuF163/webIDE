#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${TMUX:-}" ]]; then
  exec bash
fi
exec tmux new-session -A -s main
