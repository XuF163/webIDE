# Hugging Face Web IDE (VS Code + Terminal)

一个面向 Hugging Face Spaces（Docker）的 Web IDE 镜像：同一网页里提供 **VS Code（code-server）** 和 **Web 终端（ttyd+tmux）**，支持任务栏切换与可拖拽分屏；断线后任务通过 `tmux` 保持继续运行（容器不重启前提下）。

## Features
- `/`：任务栏壳页面（默认 VS Code 单窗，支持 Split 分屏拖拽、Desktop 自由多窗、Lock 锁屏）
- `/vscode/`：code-server（`--auth none`，由反代层可选 basic auth 保护）
- `/terminal/`：ttyd（默认进入 `tmux new-session -A -s main`，开启鼠标滚轮回看日志）
- 预装：`git`、`tmux`、`codex`、`claude`（并提供 `claudecode` 兼容命令）

## Run locally
```bash
docker build -t hf-web-ide .
docker run --rm -p 7860:7860 hf-web-ide
```

打开 `http://localhost:7860/`。

## Frontend (Vite + React)
壳页面位于 `web/`，使用 Vite + React（支持 HMR），Docker 构建时会自动 `npm ci && npm run build` 产出静态资源并由 nginx 提供。

### Dev (HMR)
先启动容器（提供 `/vscode/` 与 `/terminal/`），再启动 Vite 开发服务器（会代理这些路径到容器）：
```bash
docker run --rm -p 7860:7860 hf-web-ide
cd web
npm install
VITE_DEV_PROXY_TARGET=http://localhost:7860 npm run dev
```

### Optional basic auth (recommended if exposed)
```bash
docker run --rm -p 7860:7860 \
  -e AUTH_MODE=basic \
  -e BASIC_AUTH_USER=admin \
  -e BASIC_AUTH_PASS=change-me \
  hf-web-ide
```

## Hugging Face Spaces (Docker)
确保容器监听 `$PORT`（默认 `7860`），本镜像会读取该环境变量。

如果你在 GitHub Actions 里推送到了 GHCR，可在 Space 仓库里写一个极简 `Dockerfile`：
```dockerfile
FROM ghcr.io/<org>/<image>:latest
```

## UI tips
- Terminal：鼠标滚轮回看输出（进入 tmux copy-mode 后按 `q` 退出）
- Desktop：窗口位置/大小会保存在浏览器 `localStorage`
- Lock：仅前端遮罩锁屏（不替代服务端鉴权）；忘记 PIN 可用 Reset 或清理站点数据

## Environment variables
- `PORT`：对外监听端口（默认 `7860`）
- `AUTH_MODE`：`none`（默认）或 `basic`
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`：basic auth 凭证
- `WORKSPACE_DIR`：工作目录（默认 `/workspace`）

### AI CLI keys
- `OPENAI_API_KEY`：用于 `codex`
- `ANTHROPIC_API_KEY`：用于 `claude` / `claudecode`
