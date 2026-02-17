#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  cat >&2 <<'EOF'
cc-switch is installed in this image, but it is a desktop GUI app.
Current session is headless, so no display server is available.

To use it interactively, run the container in a desktop-enabled Linux session,
or install it on your local machine:
https://github.com/farion1231/cc-switch/releases/latest
EOF
  exit 1
fi

exec /opt/cc-switch/cc-switch.AppImage "$@"
