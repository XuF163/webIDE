#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${KASMVNC_DISPLAY:-1}"
GEOMETRY="${KASMVNC_GEOMETRY:-1920x1080}"

if ! [[ "${DISPLAY_NUM}" =~ ^[0-9]+$ ]]; then
  echo "KASMVNC_DISPLAY must be a number (got: ${DISPLAY_NUM})" >&2
  exit 1
fi

if ! command -v vncserver >/dev/null 2>&1; then
  echo "vncserver not found" >&2
  exit 1
fi

vncserver ":${DISPLAY_NUM}" -geometry "${GEOMETRY}" -depth 24

# vncserver normally forks into background; keep this process alive and fail if the VNC server exits.
pidfile=""
for _ in $(seq 1 50); do
  pidfile="$(ls -1t "${HOME}/.vnc/"*":${DISPLAY_NUM}.pid" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${pidfile}" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "${pidfile}" || ! -f "${pidfile}" ]]; then
  echo "KasmVNC pidfile not found for display :${DISPLAY_NUM}" >&2
  exit 1
fi

pid="$(cat "${pidfile}" 2>/dev/null || true)"
if ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
  echo "KasmVNC pid invalid (${pidfile}): ${pid}" >&2
  exit 1
fi

while kill -0 "${pid}" 2>/dev/null; do
  sleep 2
done

echo "KasmVNC exited (pid ${pid})" >&2
exit 1

