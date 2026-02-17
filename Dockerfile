FROM node:20-bookworm-slim AS web-build

WORKDIR /app/web-src

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

ARG TTYD_VERSION=1.7.7
ARG CC_SWITCH_VERSION=3.10.3

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
  && rm -rf /var/lib/apt/lists/*

# Install CC Switch (AppImage)
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) cc_switch_arch="x86_64" ;; \
    arm64) cc_switch_arch="arm64" ;; \
    *) echo "Unsupported architecture for cc-switch: $arch" >&2; exit 1 ;; \
  esac; \
  version="${CC_SWITCH_VERSION#v}"; \
  release_tag="v${version}"; \
  file="CC-Switch-v${version}-Linux-${cc_switch_arch}.AppImage"; \
  url="https://github.com/farion1231/cc-switch/releases/download/${release_tag}/${file}"; \
  mkdir -p /opt/cc-switch; \
  if ! curl -fL --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 20 -A "webIDE-builder" -o /opt/cc-switch/cc-switch.AppImage "$url"; then \
    echo "Primary cc-switch URL failed: $url" >&2; \
    latest_tag="$(curl -fsSL -A "webIDE-builder" https://api.github.com/repos/farion1231/cc-switch/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"; \
    test -n "$latest_tag"; \
    latest_version="${latest_tag#v}"; \
    latest_file="CC-Switch-v${latest_version}-Linux-${cc_switch_arch}.AppImage"; \
    latest_url="https://github.com/farion1231/cc-switch/releases/download/${latest_tag}/${latest_file}"; \
    echo "Fallback to latest cc-switch asset: $latest_url" >&2; \
    curl -fL --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 20 -A "webIDE-builder" -o /opt/cc-switch/cc-switch.AppImage "$latest_url"; \
  fi; \
  chmod +x /opt/cc-switch/cc-switch.AppImage

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

RUN chmod +x /app/entrypoint/entrypoint.sh /app/entrypoint/tmux-shell.sh /app/entrypoint/tmux-new-session.sh /app/entrypoint/claudecode.sh /app/entrypoint/cc-switch.sh

EXPOSE 7860

ENTRYPOINT ["tini","--","/app/entrypoint/entrypoint.sh"]
