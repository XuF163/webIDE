# Hugging Face Web IDE 容器镜像（VS Code + 终端）开发计划

## 1. 目标与范围

**目标**：构建一个面向 Hugging Face（优先考虑 HF Spaces / Docker SDK）的容器镜像，并提供一个**无需登录**即可访问的网页 IDE，包含：
- **VS Code 集成**（浏览器内使用 VS Code）
- **Web 终端**（预装 `codex` CLI、Claude Code、`git` 等）
- **任务栏/标签页**：在 VS Code 与终端之间快速切换
- **断线不影响后台工作**：浏览器关闭或未登录时，容器内的开发/脚本任务仍持续运行（例如长时间构建、vibe coding 任务等）
- **GitHub Actions 预编译/预构建**：在 GitHub 工作流中构建并发布镜像（例如推送到 GHCR），以加速 Hugging Face 侧构建/部署与版本迭代

**非目标（第一阶段不做）**：
- 多用户隔离/权限系统（MVP 默认单容器单环境）
- 多租户安全沙箱（MVP 仅提供基础安全阀门与可选认证）
- 完整的项目管理/协作（先保证 IDE 能用）

---

## 2. MVP 需求拆解（可验收）

### 2.1 Web 体验
- 访问 `/` 打开一个页面，包含底部或侧边**任务栏**，至少有三个入口：`VS Code`、`Terminal`、`Split（分屏）`
- 支持两种模式：
  - 单窗：显示 VS Code 或终端，通过任务栏切换
  - 分屏：VS Code + 终端同屏显示，并可**拖拽分隔条**调节两侧大小（默认左右分屏）
- 默认启动为**单窗（不分屏）**（建议默认打开 VS Code）；状态可记忆（`localStorage` 记住上次选中模式与分屏比例）

### 2.2 VS Code（浏览器内）
推荐方案二选一（优先 OpenVSCode-Server）：
- **OpenVSCode-Server**：更接近开源 VS Code Web 体验，适合容器化
- **code-server**：生态成熟，但部分场景涉及扩展市场/许可与配置差异

验收：能打开 `/workspace` 目录，能安装/启用基础扩展（如 Python/JS/Markdown）并编辑文件。

实现落地（本仓库默认）：为便于在同一域名下以 `/vscode/` 子路径反代并嵌入 iframe，MVP 先采用 **code-server**；后续如需切换到 OpenVSCode-Server，可在镜像层与反代配置中替换实现。

#### 2.2.1 VS Code 挂机（断线后任务继续）
为保证“在 VS Code 里启动的任务”在浏览器断线/关闭后仍持续运行，MVP 采用 **tmux 作为统一的任务承载层**：
- VS Code 服务本身作为常驻进程由进程守护（supervisor/s6 等）拉起，不因无人访问自动退出
- 引导在 VS Code 的终端/任务中使用 `tmux`（可选：将 VS Code 默认终端配置为自动 `tmux new-session -A -s main`）
- 用户也可在 `/terminal/` 直接 attach 到同一 `tmux` session，断线再连可继续查看/接管任务

验收：在 VS Code 终端里启动长任务（如 `sleep 600`/构建脚本），关闭浏览器后再打开页面，仍可通过 `/terminal/`（tmux）观察任务仍在运行。

说明：本“挂机”范围仅覆盖**浏览器断线**场景（容器进程仍在）；不覆盖平台休眠/容器重启后的任务自动恢复。

### 2.3 Web 终端
推荐：`ttyd`（轻量、稳定、易反代）+ `tmux`（保证断线任务不丢）。
- `ttyd` 启动命令直接 attach 到固定 `tmux` session：`tmux new-session -A -s main`
- 浏览器断线后，`tmux` session 仍在，任务继续跑

验收：在终端里运行长任务（`sleep 600`/构建脚本），刷新页面/断开再连仍可看到任务继续。

### 2.4 工具链（镜像内预装）
- 基础：`git`、`openssh-client`、`curl`、`ca-certificates`、`bash`、`tmux`
- 语言运行时（按实际需求选）：`nodejs`、`python3`、`pip`、`uv`（可选）
- **Codex CLI**：安装并可运行（具体安装方式按官方发布渠道确定）
- **Claude Code**：安装并可运行（同上；通常需要 `ANTHROPIC_API_KEY` 等环境变量）

验收：终端中 `git --version`、`codex --version`、`claude --version`（或对应命令）可用。

---

## 3. 总体架构（推荐实现）

### 3.1 进程与路由
容器内运行 3 类服务：
1) **反向代理/静态站点**（推荐 `caddy` 或 `nginx`）
2) **VS Code Web 服务**（openvscode-server 或 code-server）
3) **Web 终端服务**（`ttyd`）

建议统一同源路由，便于 iframe 嵌入与 cookie/安全策略管理：
- `/`：任务栏壳页面（静态 HTML/JS/CSS）
- `/vscode/`：反代到 VS Code Web 服务
- `/terminal/`：反代到 ttyd
- `/healthz`：健康检查（可选）

### 3.2 “无需登录”与“可选认证”
默认：不做登录（符合需求）。
但为避免公开部署风险，保留开关（环境变量控制）：
- `AUTH_MODE=none|basic`（MVP 先做 basic）
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`

HF Spaces 若公开可访问，建议至少支持 `basic` 以免被滥用（尤其是终端能力）。

---

## 4. 容器镜像设计

### 4.1 兼容 Hugging Face 的约束（Docker Space）
- 监听端口遵循 `$PORT`（未设置则默认 `7860`）
- 进程以前台方式运行（便于平台健康检查）
- 尽量使用非 root 用户运行服务（降低风险）

### 4.2 镜像分层（建议多阶段构建）
- **builder**：安装构建依赖、拉取/编译前端壳页面资源、准备 VS Code server 依赖
- **runtime**：仅保留运行时依赖 + 产物，体积更小、启动更快

### 4.3 运行目录与持久化策略
- `/workspace`：默认工作目录（HF 场景可挂载持久化卷时映射到此）
- `~/.cache`：包管理缓存（可选）
- 建议提供 `WORKSPACE_DIR` 环境变量覆盖

---

## 5. GitHub Actions（预编译/预构建）方案

目标：在 GitHub 侧完成重依赖构建并发布镜像，HF 侧只需 `FROM ghcr.io/...` 拉取即可（或极少量二次层）。

### 5.1 工作流建议
- 触发：`push` 到 `main`、以及 `tags/v*`
- 动作：
  - `docker buildx build`（可选多架构：`linux/amd64`、`linux/arm64`）
  - 使用 GHA cache（`--cache-to/--cache-from`）
  - 推送到 **GHCR**（`ghcr.io/<org>/<image>`）
  - 产物：`latest`、`sha-<short>`、`vX.Y.Z`
  - 可选：生成 SBOM（Syft）/扫描（Trivy）/签名（Cosign）

### 5.2 Hugging Face 侧使用方式（两种）
- **方式 A（推荐）**：HF Space 仓库内仅放轻量 `Dockerfile`：
  - `FROM ghcr.io/<org>/<image>:<tag>`
  - `ENV PORT=7860`
  - `CMD ...`（若镜像内已含 entrypoint 则可省）
- **方式 B**：直接在 HF Space 仓库维护完整 Dockerfile（但失去“预编译”的优势）

---

## 6. Web 前端壳页面（任务栏 + 分屏）设计

MVP：纯静态页面即可（无需前端框架）。
- 布局：顶部/底部 taskbar + 内容区（100vh）
- 内容区：两个 iframe（`/vscode/` 与 `/terminal/`），支持三种视图状态：VS Code 单窗 / 终端单窗 / 分屏
- 分屏：使用 CSS flex/grid + 拖拽分隔条（可用轻量库如 `Split.js`，或自研 pointer 事件），并把比例写入 `localStorage`
- 默认：不分屏（首次打开默认 VS Code 单窗）
- 快捷键：`Ctrl+1`/`Ctrl+2`/`Ctrl+3`（VS Code/终端/分屏，可选）
- 兼容：全屏高度、移动端最小可用（移动端可降级为单窗切换）

后续增强（非 MVP）：
- 多窗口/停靠布局（更像“远程桌面”窗口管理）
- 进程状态小组件（tmux session、磁盘占用、CPU）

---

## 7. 里程碑与交付物

### M0：仓库脚手架（1 天）
交付：
- `DEVELOPMENT_PLAN.md`（本文件）
- 目录结构约定（见下方“建议目录结构”）

验收：
- 约定清晰，可开始编码与 CI。

### M1：容器内跑通 VS Code + 终端 + 反代（2–4 天）
交付：
- `Dockerfile`（或 `docker/` 下多文件）
- `entrypoint.sh` / `supervisord`/`s6` 配置（任选其一）
- 静态壳页面（任务栏 + 可拖拽分屏）

验收：
- 本地 `docker run -p 7860:7860 ...` 可访问：
  - `/`：任务栏页面
  - `/vscode/`：VS Code 可编辑 `/workspace`
  - `/terminal/`：可进终端并进入 tmux
  - `/` 分屏模式下可拖拽调整 VS Code/终端窗口大小，刷新后比例仍可恢复

### M2：预装 codex CLI / Claude Code / git 体验打磨（1–2 天）
交付：
- 工具安装脚本与版本锁定策略（尽量可复现）
- 环境变量约定（OpenAI/Anthropic keys 等）

验收：
- 终端内可直接运行相关 CLI（无 key 时给出可理解的错误提示）。

### M3：GitHub Actions 构建发布到 GHCR（1 天）
交付：
- `.github/workflows/build-image.yml`
- 版本/标签策略（`latest` + `sha` + `semver`）

验收：
- Push main 后自动发布镜像；HF 侧可 `FROM` 并成功拉取启动。

### M4：HF Space 集成与运行守护（1–2 天）
交付：
- `README.md`（部署/使用说明：HF 与本地）
- `healthz`、日志输出、资源限制建议

验收：
- HF Space 上能稳定运行；断线后 tmux 保留；重启后行为符合预期。

---

## 8. 建议目录结构（落地后）

> 目前仓库为空，建议按以下方式组织，便于 CI 与维护。

- `Dockerfile`
- `entrypoint/`
  - `entrypoint.sh`
  - `caddy/` 或 `nginx/`
- `web/`
  - `index.html`
  - `app.js`
  - `styles.css`
- `.github/workflows/`
  - `build-image.yml`
- `docs/`
  - `security.md`（可选）

---

## 9. 风险与注意事项

- **无登录 + 终端**：公开环境极易被滥用（挖矿、扫描、滥发请求）。建议至少提供可选 basic auth，并在 HF Space 默认开启（或只做私有 Space）。
- **密钥管理**：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 只通过环境变量注入，不写入镜像层，不写入仓库。
- **平台休眠/重启**：若 HF Space 因闲置进入休眠/被重启，容器内“挂机任务”会中断（本项目当前不覆盖该恢复能力）；要实现更强的“一直跑”，需启用 Always-on/付费硬件，或把长任务迁移到外部 CI（如 GitHub Actions）。
- **扩展市场/下载**：VS Code 扩展可能需要联网下载；HF 环境网络策略与镜像构建阶段策略需评估（必要时在构建阶段预装常用扩展）。

---

## 10. 待确认（你回复后我再落地到代码）

1) 目标平台是否确定为 **Hugging Face Spaces（Docker）**？是否要求公开可访问？
2) VS Code 选择：**OpenVSCode-Server**（推荐）还是 **code-server**？
3) 终端方案能否接受 `ttyd + tmux`（最省事），还是必须要 `xterm.js + node-pty` 深度集成？
4) `codex` CLI 与 Claude Code 的期望安装方式/命令名分别是什么（例如 `codex` / `claude`）？是否需要预装特定版本？
5) ✅ 已确认：支持“分屏 + 可拖拽调节大小”，但默认不分屏，并保留任务栏快速切换（单窗/分屏）。
6) ✅ 已确认：只覆盖**浏览器断线后**任务继续（容器不重启），不要求 Space 休眠/重启后自动恢复。
