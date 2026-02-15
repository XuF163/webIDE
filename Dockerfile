FROM node:20-bookworm-slim AS web-build

WORKDIR /app/web-src

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

ARG TTYD_VERSION=1.7.7
ARG KASMVNC_VERSION=1.4.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    ncurses-term \
    openssh-client \
    tmux \
    tini \
    nginx \
    apache2-utils \
    chromium \
    openbox \
    dbus-x11 \
    xauth \
    x11-xserver-utils \
    fonts-noto-cjk \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
      amd64) kasmvnc_arch="amd64" ;; \
      arm64) kasmvnc_arch="arm64" ;; \
      *) echo "Unsupported architecture for KasmVNC: $arch" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/kasmvncserver.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${kasmvnc_arch}.deb" \
  && apt-get install -y --no-install-recommends /tmp/kasmvncserver.deb \
  && rm -f /tmp/kasmvncserver.deb \
  && rm -rf /var/lib/apt/lists/*

# Install code-server (VS Code in the browser)
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install ttyd (web terminal)
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
      amd64) ttyd_arch="x86_64" ;; \
      arm64) ttyd_arch="aarch64" ;; \
      *) echo "Unsupported architecture for ttyd: $arch" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
  && chmod +x /usr/local/bin/ttyd

# Install Codex CLI and Claude Code (Node-based installers; provide binaries)
RUN npm install -g @openai/codex @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash ide \
  && mkdir -p /workspace \
  && chown -R ide:ide /workspace

WORKDIR /workspace

COPY --from=web-build /app/web-src/dist/ /app/web/
COPY entrypoint/ /app/entrypoint/
COPY vscode-extension/ /app/vscode-extension/

RUN chmod +x /app/entrypoint/entrypoint.sh /app/entrypoint/tmux-shell.sh /app/entrypoint/tmux-new-session.sh /app/entrypoint/claudecode.sh /app/entrypoint/kasmvnc-xstartup.sh

EXPOSE 7860

ENTRYPOINT ["tini","--","/app/entrypoint/entrypoint.sh"]
