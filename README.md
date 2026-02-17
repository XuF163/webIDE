# Hugging Face Web IDE (VS Code + Terminal)

一个面向 Hugging Face Spaces（Docker）的 Web IDE 镜像：外部入口仍是“桌面壳”，内置 **VS Code（code-server）** 与 **Web 终端（ttyd+tmux）**；断线后 tmux 任务可继续运行（容器不重启前提下）。

## Features
- `/`：任务栏壳页面（默认 VS Code 单窗，支持 Split 分屏拖拽、Desktop 自由多窗、Lock 锁屏）
- `/vscode/`：VS Code（code-server）
- `/terminal/`：ttyd（默认进入 `tmux new-session -A -s main`，开启鼠标滚轮回看日志）
- `/api/fs/`：文件 API（用于网页版文件管理器上传/下载与状态保存）
- `Agent` 窗口：Web 端提交任务 -> 容器内运行 CLI（如 `codex`）-> 产出 diff -> 审批后自动 `commit/push/PR`
- `CC Switch` 窗口：在 WebIDE 内管理 Claude/Codex/Gemini Provider，并直接写入 `~/.claude` / `~/.codex` / `~/.gemini` 配置
- `/api/agent/`：Agent 任务 API（含 SSE 日志流与 approve/promote 接口）
- 预装：`git`、`tmux`、`codex`、`claude`（并提供 `claudecode` 兼容命令）
- 集成 `cc-switch`：容器内提供 `cc-switch` 命令（基于官方 Linux AppImage）

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
- Desktop：窗口位置/大小等保存到容器侧（`/api/fs/state` => `/workspace/.hfide/ui-state.json`），同 PIN 多端登录可同步
- Lock：仅前端遮罩锁屏（不替代服务端鉴权）；忘记 PIN 可用 Reset 或清理站点数据

## CC Switch
- Built-in tabs now include `Providers`, `MCP`, and `Skills` in pure Web mode.
- `MCP` tab manages Claude MCP servers in `~/.claude.json` (`mcpServers`).
- `Skills` tab manages files under `~/.claude/skills` (create/edit/delete `SKILL.md`).
- `MCP` / `Skills` tabs support import/export (`.json`; skills also support `.md` single import).
- 推荐直接使用 WebIDE 内置的 `CC Switch` 窗口（纯 Web 重新实现，不依赖 `Xvfb + noVNC`）。
- 内置面板支持 Provider 新增/编辑/删除、激活、导入导出，并将配置落盘到 CLI 实际读取路径。
- 仍可在容器终端执行 `cc-switch`，但它是桌面 GUI 应用，headless 环境通常不可用。

## Environment variables
- `PORT`：对外监听端口（默认 `7860`）
- `AUTH_MODE`：`none`（默认）或 `basic`
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`：basic auth 凭证
- `WORKSPACE_DIR`：工作目录（默认 `/workspace`）
- `LOCK_PIN` / `PIN`：锁屏 PIN（建议配合 `LOCK_ON_START=1`；会通过 `/auth/*` + nginx `auth_request` 保护 `/vscode/` 与 `/terminal/`，未解锁不会传输 IDE 内容）
- `LOCK_ON_START`：`1|true|yes` 时启动即锁定并启用上述保护（仅当设置了 `LOCK_PIN`/`PIN` 时生效；默认会自动开启）
- `PIN_AUTH_COOKIE_PARTITIONED`：`0` 禁用 `Partitioned` cookie 属性（默认启用；用于 iframe/第三方上下文下保持解锁态）
- `PIN_AUTH_COOKIE_SECURE`：`1` 强制设置 `Secure` cookie 属性（默认自动根据 `X-Forwarded-Proto` 判断）

### GitHub / PR (Agent)
- `HFIDE_GITHUB_TOKEN`（或 `GITHUB_TOKEN`）：用于私库 clone、push、创建 PR（**不要**打印到日志）
- `HFIDE_GIT_NAME` / `HFIDE_GIT_EMAIL`：Agent 自动 commit 的作者信息（默认 `hfide-agent` / `hfide-agent@local`）

### AI CLI keys
- `OPENAI_API_KEY`：用于 `codex`
- `ANTHROPIC_API_KEY`：用于 `claude` / `claudecode`
