#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/ide}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-$(id -u)}"
mkdir -p "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"

if command -v dbus-launch >/dev/null 2>&1; then
  # shellcheck disable=SC2046
  eval "$(dbus-launch --sh-syntax)"
fi

xsetroot -solid "#1e1e1e" || true

openbox-session >/tmp/openbox.log 2>&1 &

CODE_URL="${HFIDE_CODE_SERVER_URL:-http://127.0.0.1:8080/}"
PROFILE_DIR="${HFIDE_CHROME_PROFILE_DIR:-/workspace/.hfide/chrome-profile}"
mkdir -p "${PROFILE_DIR}"

CHROME_BIN="${HFIDE_CHROME_BIN:-chromium}"
if ! command -v "${CHROME_BIN}" >/dev/null 2>&1; then
  CHROME_BIN="chromium-browser"
fi

CHROME_FLAGS=(
  --no-sandbox
  --disable-dev-shm-usage
  --no-first-run
  --disable-default-apps
  --disable-features=TranslateUI
  --disable-component-update
  --disable-background-networking
  --disable-sync
  --disable-session-crashed-bubble
  --kiosk
  "--user-data-dir=${PROFILE_DIR}"
  "${CODE_URL}"
)

while true; do
  "${CHROME_BIN}" "${CHROME_FLAGS[@]}" >/tmp/chromium.log 2>&1 || true
  sleep 1
done

