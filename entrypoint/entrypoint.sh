#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-7860}"
AUTH_MODE="${AUTH_MODE:-none}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"

FILES_HOST="${FILES_HOST:-127.0.0.1}"
FILES_PORT="${FILES_PORT:-8091}"
FILES_ROOT="${FILES_ROOT:-${WORKSPACE_DIR}}"

CODE_SERVER_HOST="${CODE_SERVER_HOST:-127.0.0.1}"
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"

KASMVNC_HOST="${KASMVNC_HOST:-127.0.0.1}"
KASMVNC_DISPLAY="${KASMVNC_DISPLAY:-1}"
if ! [[ "$KASMVNC_DISPLAY" =~ ^[0-9]+$ ]]; then
  echo "KASMVNC_DISPLAY must be a number (got: $KASMVNC_DISPLAY)" >&2
  exit 1
fi
if [[ "$KASMVNC_HOST" != "127.0.0.1" && "$KASMVNC_HOST" != "localhost" ]]; then
  echo "KASMVNC_HOST must be 127.0.0.1/localhost (got: $KASMVNC_HOST)" >&2
  exit 1
fi
if [[ "$KASMVNC_HOST" == "localhost" ]]; then
  KASMVNC_HOST="127.0.0.1"
fi
KASMVNC_PORT="${KASMVNC_PORT:-$((8443 + KASMVNC_DISPLAY))}"
KASMVNC_GEOMETRY="${KASMVNC_GEOMETRY:-1920x1080}"
KASMVNC_USER="${KASMVNC_USER:-kasm}"
KASMVNC_PASS="${KASMVNC_PASS:-}"

TTYD_HOST="${TTYD_HOST:-127.0.0.1}"
TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_BASE_PATH="${TTYD_BASE_PATH:-/terminal}"

TTYD_NEW_PORT="${TTYD_NEW_PORT:-7682}"
TTYD_NEW_BASE_PATH="${TTYD_NEW_BASE_PATH:-/terminal-new}"

LOCK_PIN="${LOCK_PIN:-${PIN:-}}"
LOCK_ON_START="${LOCK_ON_START:-}"
if [[ -n "$LOCK_PIN" && -z "$LOCK_ON_START" ]]; then
  LOCK_ON_START="1"
fi
LOCK_ON_START="${LOCK_ON_START:-0}"

PIN_AUTH_HOST="${PIN_AUTH_HOST:-127.0.0.1}"
PIN_AUTH_PORT="${PIN_AUTH_PORT:-8090}"

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

if [[ ! -f "${HOME}/.tmux.conf" ]]; then
  install -m 0644 /app/entrypoint/tmux.conf "${HOME}/.tmux.conf" 2>/dev/null || true
  chown ide:ide "${HOME}/.tmux.conf" 2>/dev/null || true
fi
install -m 0644 /app/entrypoint/tmux.conf /etc/tmux.conf 2>/dev/null || true

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

pin_hash="null"
if [[ -n "$LOCK_PIN" ]]; then
  pin_hash="$(LOCK_PIN="$LOCK_PIN" node -e "const crypto=require('crypto');const pin=process.env.LOCK_PIN||'';process.stdout.write(JSON.stringify(crypto.createHash('sha256').update(pin,'utf8').digest('base64')));")"
fi
lock_on_start="false"
case "${LOCK_ON_START}" in
  1|true|TRUE|yes|YES|on|ON) lock_on_start="true" ;;
esac

pin_auth_location=""
pin_auth_guard=""
if [[ -n "$LOCK_PIN" && "$lock_on_start" == "true" ]]; then
  pin_auth_location=$(cat <<EOF2
    location /auth/ {
      proxy_pass http://${PIN_AUTH_HOST}:${PIN_AUTH_PORT};
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$hfide_forwarded_proto;
      proxy_http_version 1.1;
    }
EOF2
)
  pin_auth_guard=$'      auth_request /auth/check;\n'
fi

if command -v vncserver >/dev/null 2>&1; then
  if [[ -z "$KASMVNC_PASS" ]]; then
    KASMVNC_PASS="$(node -e "const crypto=require('crypto');process.stdout.write(crypto.randomBytes(18).toString('base64url'));")"
  fi

  kasm_basic_auth="$(
    KASMVNC_USER="$KASMVNC_USER" KASMVNC_PASS="$KASMVNC_PASS" node -e \
      'const u=process.env.KASMVNC_USER||"";const p=process.env.KASMVNC_PASS||"";process.stdout.write(Buffer.from(u+":"+p,"utf8").toString("base64"));'
  )"

  echo "Configuring KasmVNC (:${KASMVNC_DISPLAY} => http://${KASMVNC_HOST}:${KASMVNC_PORT})"
  mkdir -p /etc/kasmvnc
  cat >/etc/kasmvnc/kasmvnc.yaml <<EOF
network:
  protocol: http
  interface: ${KASMVNC_HOST}
  websocket_port: auto
  ssl:
    require_ssl: false
  udp:
    public_ip: ${KASMVNC_HOST}

desktop:
  resolution:
    width: 1920
    height: 1080
  allow_resize: true
  pixel_depth: 24

command_line:
  prompt: false

user_session:
  session_type: shared
  concurrent_connections_prompt: false

data_loss_prevention:
  clipboard:
    delay_between_operations: 0
    up:
      size: unlimited
      allow_mimetypes:
        - "text/plain"
        - "text/html"
        - "image/png"
    down:
      size: unlimited
      allow_mimetypes:
        - "text/plain"
        - "text/html"
        - "image/png"

server:
  http:
    enable: true
    httpd_directory: /usr/share/kasmvnc/www
    httpd_directory_ro: /usr/share/kasmvnc/www-ro
    headers:
      - "Cross-Origin-Embedder-Policy: require-corp"
      - "Cross-Origin-Opener-Policy: same-origin"
      - "X-Content-Type-Options: nosniff"
      - "X-Frame-Options: SAMEORIGIN"
      - "Content-Security-Policy: frame-ancestors 'self'"
EOF

  echo "Creating KasmVNC user (${KASMVNC_USER})"
  su - ide -s /bin/bash -c "set -euo pipefail; mkdir -p ~/.vnc; printf '%s\n%s\n\n' ${KASMVNC_PASS@Q} ${KASMVNC_PASS@Q} | vncpasswd -u ${KASMVNC_USER@Q} -ow >/dev/null"
else
  kasm_basic_auth=""
fi

cat >/app/web/runtime-config.js <<EOF
// Generated at container startup.
window.__HFIDE_RUNTIME_CONFIG__ = { version: 1, lock: { pinSha256Base64: ${pin_hash}, lockOnStart: ${lock_on_start} } };
EOF

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

  map \$http_x_forwarded_proto \$hfide_forwarded_proto {
    default \$http_x_forwarded_proto;
    '' \$scheme;
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

    location = /runtime-config.js {
      add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
      root /app/web;
      try_files /runtime-config.js =404;
    }

${pin_auth_location}

    # Enforce trailing slashes for subpath apps (relative URL correctness).
    location = /vscode {
      return 301 /vscode/;
    }
    location = /terminal {
      return 301 /terminal/;
    }
    location = /terminal-new {
      return 301 /terminal-new/;
    }
    location = /api/fs {
      return 301 /api/fs/;
    }

    location /vscode/ {
${pin_auth_guard}      # auth_request (optional)
      proxy_pass http://${KASMVNC_HOST}:${KASMVNC_PORT}/;
      proxy_redirect ~^(/.*)$ /vscode\$1;
      proxy_set_header Authorization "Basic ${kasm_basic_auth}";
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$hfide_forwarded_proto;
      proxy_set_header X-Forwarded-Prefix /vscode;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 3600;
    }

    location /terminal/ {
${pin_auth_guard}      # auth_request (optional)
      proxy_pass http://${TTYD_HOST}:${TTYD_PORT}${TTYD_BASE_PATH}/;
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$hfide_forwarded_proto;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 3600;
    }

    location /terminal-new/ {
${pin_auth_guard}      # auth_request (optional)
      proxy_pass http://${TTYD_HOST}:${TTYD_NEW_PORT}${TTYD_NEW_BASE_PATH}/;
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$hfide_forwarded_proto;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 3600;
    }

    location /api/fs/ {
${pin_auth_guard}      # auth_request (optional)
      client_max_body_size 200m;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_pass http://${FILES_HOST}:${FILES_PORT}/;
      proxy_set_header Host \$http_host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$hfide_forwarded_proto;
      proxy_http_version 1.1;
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

HFIDE_AGENT_EXT_SRC="/app/vscode-extension/hfide.hfide-agent"
HFIDE_AGENT_EXT_ID="hfide.hfide-agent"
HFIDE_AGENT_EXT_VERSION="0.0.1"
HFIDE_EXT_DIR="${HOME}/.local/share/code-server/extensions"

if [[ -d "$HFIDE_AGENT_EXT_SRC" ]]; then
  echo "Installing HFIDE Agent VS Code extension (${HFIDE_AGENT_EXT_ID}@${HFIDE_AGENT_EXT_VERSION})"
  su - ide -s /bin/bash -c "set -euo pipefail; mkdir -p ${HFIDE_EXT_DIR@Q}; rm -rf ${HFIDE_EXT_DIR@Q}/${HFIDE_AGENT_EXT_ID}-*; cp -r ${HFIDE_AGENT_EXT_SRC@Q} ${HFIDE_EXT_DIR@Q}/${HFIDE_AGENT_EXT_ID}-${HFIDE_AGENT_EXT_VERSION}"
fi

if [[ -n "$LOCK_PIN" && "$lock_on_start" == "true" ]]; then
  echo "Starting PIN auth server on ${PIN_AUTH_HOST}:${PIN_AUTH_PORT}"
  start_as_ide "LOCK_PIN=${LOCK_PIN@Q} PIN_AUTH_HOST=${PIN_AUTH_HOST@Q} PIN_AUTH_PORT=${PIN_AUTH_PORT@Q} node /app/entrypoint/pin-auth-server.js"
fi

echo "Starting files server on ${FILES_HOST}:${FILES_PORT} (root: ${FILES_ROOT})"
start_as_ide "FILES_HOST=${FILES_HOST@Q} FILES_PORT=${FILES_PORT@Q} FILES_ROOT=${FILES_ROOT@Q} node /app/entrypoint/files-server.js"

echo "Starting code-server on ${CODE_SERVER_HOST}:${CODE_SERVER_PORT} (workspace: ${WORKSPACE_DIR})"
start_as_ide "code-server --bind-addr ${CODE_SERVER_HOST@Q}:${CODE_SERVER_PORT@Q} --auth none --disable-telemetry --disable-update-check ${WORKSPACE_DIR@Q}"

if command -v vncserver >/dev/null 2>&1; then
  echo "Starting KasmVNC on ${KASMVNC_HOST}:${KASMVNC_PORT} (display :${KASMVNC_DISPLAY}, geometry: ${KASMVNC_GEOMETRY})"
  start_as_ide "HFIDE_CODE_SERVER_URL=http://${CODE_SERVER_HOST}:${CODE_SERVER_PORT}/ HFIDE_CHROME_PROFILE_DIR=${WORKSPACE_DIR@Q}/.hfide/chrome-profile vncserver :${KASMVNC_DISPLAY@Q} -geometry ${KASMVNC_GEOMETRY@Q} -depth 24 -xstartup /app/entrypoint/kasmvnc-xstartup.sh"
else
  echo "WARNING: vncserver not found; /vscode/ will not be available" >&2
fi

echo "Starting ttyd on ${TTYD_HOST}:${TTYD_PORT} (base-path: ${TTYD_BASE_PATH})"
start_as_ide "/usr/local/bin/ttyd -t scrollback=50000 --interface ${TTYD_HOST@Q} --port ${TTYD_PORT@Q} --base-path ${TTYD_BASE_PATH@Q} --writable tmux new-session -A -s main -c ${WORKSPACE_DIR@Q}"

echo "Starting ttyd(new) on ${TTYD_HOST}:${TTYD_NEW_PORT} (base-path: ${TTYD_NEW_BASE_PATH})"
start_as_ide "/usr/local/bin/ttyd -t scrollback=50000 --interface ${TTYD_HOST@Q} --port ${TTYD_NEW_PORT@Q} --base-path ${TTYD_NEW_BASE_PATH@Q} --writable /app/entrypoint/tmux-new-session.sh ${WORKSPACE_DIR@Q}"

echo "Starting nginx on :${PORT} (AUTH_MODE=${AUTH_MODE})"
start_root nginx -g "daemon off;"

wait -n
terminate
exit 1
