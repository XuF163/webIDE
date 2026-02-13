#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-7860}"
AUTH_MODE="${AUTH_MODE:-none}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"

CODE_SERVER_HOST="${CODE_SERVER_HOST:-127.0.0.1}"
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"

TTYD_HOST="${TTYD_HOST:-127.0.0.1}"
TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_BASE_PATH="${TTYD_BASE_PATH:-/terminal}"

export HOME="/home/ide"

mkdir -p /run/nginx /var/lib/nginx /var/log/nginx

pids=()
terminate() {
  echo "Shutting down..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}
trap terminate SIGINT SIGTERM

if [[ "$AUTH_MODE" == "basic" ]]; then
  BASIC_AUTH_USER="${BASIC_AUTH_USER:-}"
  BASIC_AUTH_PASS="${BASIC_AUTH_PASS:-}"

  if [[ -z "$BASIC_AUTH_USER" || -z "$BASIC_AUTH_PASS" ]]; then
    echo "AUTH_MODE=basic requires BASIC_AUTH_USER and BASIC_AUTH_PASS" >&2
    exit 1
  fi

  htpasswd -bc /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS" >/dev/null
fi

auth_block=""
if [[ "$AUTH_MODE" == "basic" ]]; then
  auth_block=$'auth_basic "Restricted";\n    auth_basic_user_file /etc/nginx/.htpasswd;'
fi

cat >/etc/nginx/nginx.conf <<EOF
worker_processes  1;
pid /run/nginx.pid;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;

  log_format main '\$remote_addr - \$remote_user [\$time_local] "\$request" '
                  '\$status \$body_bytes_sent "\$http_referer" '
                  '"\$http_user_agent" "\$http_x_forwarded_for"';

  access_log /dev/stdout main;
  error_log /dev/stderr info;

  sendfile on;
  keepalive_timeout 65;

  map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
  }

  server {
    listen ${PORT};
    server_name _;

    ${auth_block}

    location = /healthz {
      auth_basic off;
      add_header Content-Type text/plain;
      return 200 "ok\n";
    }

    # Enforce trailing slashes for subpath apps (relative URL correctness).
    location = /vscode {
      return 301 /vscode/;
    }
    location = /terminal {
      return 301 /terminal/;
    }

    location /vscode/ {
      proxy_pass http://${CODE_SERVER_HOST}:${CODE_SERVER_PORT}/;
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 3600;
    }

    location /terminal/ {
      proxy_pass http://${TTYD_HOST}:${TTYD_PORT}${TTYD_BASE_PATH}/;
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 3600;
    }

    location / {
      root /app/web;
      try_files \$uri \$uri/ /index.html;
    }
  }
}
EOF

start_as_ide() {
  su - ide -s /bin/bash -c "$1" &
  pids+=("$!")
}
start_root() {
  "$@" &
  pids+=("$!")
}

if ! command -v claudecode >/dev/null 2>&1; then
  ln -sf /app/entrypoint/claudecode.sh /usr/local/bin/claudecode || true
fi
ln -sf /app/entrypoint/tmux-shell.sh /usr/local/bin/tmux-shell || true

echo "Starting code-server on ${CODE_SERVER_HOST}:${CODE_SERVER_PORT} (workspace: ${WORKSPACE_DIR})"
start_as_ide "code-server --bind-addr ${CODE_SERVER_HOST@Q}:${CODE_SERVER_PORT@Q} --auth none --disable-telemetry --disable-update-check ${WORKSPACE_DIR@Q}"

echo "Starting ttyd on ${TTYD_HOST}:${TTYD_PORT} (base-path: ${TTYD_BASE_PATH})"
start_as_ide "/usr/local/bin/ttyd --interface ${TTYD_HOST@Q} --port ${TTYD_PORT@Q} --base-path ${TTYD_BASE_PATH@Q} --writable tmux new-session -A -s main -c ${WORKSPACE_DIR@Q}"

echo "Starting nginx on :${PORT} (AUTH_MODE=${AUTH_MODE})"
start_root nginx -g "daemon off;"

wait -n
terminate
exit 1
