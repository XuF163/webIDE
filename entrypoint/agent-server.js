#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT || "8092");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const AGENT_DIR = process.env.HFIDE_AGENT_DIR || path.join(WORKSPACE_DIR, ".hfide", "agent");
const TASKS_DIR = path.join(AGENT_DIR, "tasks");

const MAX_JSON_BYTES = Number(process.env.AGENT_MAX_JSON_BYTES || "1048576"); // 1MiB
const SSE_PING_MS = Number(process.env.AGENT_SSE_PING_MS || "15000");

const DEFAULT_RUNNER_CMD = process.env.AGENT_DEFAULT_CMD || "codex";
const DEFAULT_GIT_NAME = process.env.HFIDE_GIT_NAME || process.env.GIT_AUTHOR_NAME || "hfide-agent";
const DEFAULT_GIT_EMAIL = process.env.HFIDE_GIT_EMAIL || process.env.GIT_AUTHOR_EMAIL || "hfide-agent@local";

function nowMs() {
  return Date.now();
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function randomId(prefix) {
  const rnd = crypto.randomBytes(8).toString("hex");
  const ts = nowMs().toString(36);
  return `${prefix}-${ts}-${rnd}`;
}

function sanitizeBranchName(input) {
  const raw = String(input || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return raw || "hfide-agent";
}

function sendJson(res, status, body, headers = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(raw);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_JSON_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      const parsed = safeJsonParse(raw);
      if (!parsed) return reject(new Error("invalid_json"));
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${nowMs().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const raw = JSON.stringify(data);
  try {
    await fsp.writeFile(tmp, raw, { encoding: "utf8", flag: "wx" });
    await fsp.rename(tmp, filePath);
  } catch (e) {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function getGitToken() {
  const t = process.env.HFIDE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || "";
  return typeof t === "string" ? t.trim() : "";
}

async function ensureGitAskpassScript() {
  const scriptPath = path.join(AGENT_DIR, "git-askpass.sh");
  if (await fileExists(scriptPath)) return scriptPath;
  await ensureDir(AGENT_DIR);
  const content = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'token="${HFIDE_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GITHUB_PAT:-}}}"',
    'case "${1:-}" in',
    '  *Username*) echo "x-access-token" ;;',
    '  *Password*) echo "${token}" ;;',
    '  *) echo "" ;;',
    "esac",
    ""
  ].join("\n");
  await fsp.writeFile(scriptPath, content, { encoding: "utf8", mode: 0o700 });
  return scriptPath;
}

async function gitEnv() {
  const token = getGitToken();
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const askpass = await ensureGitAskpassScript();
  return {
    ...process.env,
    HFIDE_GITHUB_TOKEN: token,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function parseGitHubOwnerRepo(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;

  // https://github.com/owner/repo(.git)
  const httpsMatch = raw.match(/^https?:\/\/([^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) return { owner: httpsMatch[2], repo: httpsMatch[3] };

  // git@github.com:owner/repo(.git)
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return null;
}

async function githubApiJson(method, apiPath, body) {
  const token = getGitToken();
  if (!token) throw new Error("missing_github_token");

  const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
  const opts = {
    method,
    hostname: "api.github.com",
    path: apiPath,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hfide-agent",
      Authorization: `Bearer ${token}`,
      ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {})
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const json = safeJsonParse(text);
        if (!json || res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`github_api_${res.statusCode || 0}`);
          err.statusCode = res.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * In-memory task registry (authoritative while process is running).
 * On restart, we best-effort hydrate from disk.
 */
const tasks = new Map();

/**
 * @type {Map<string, Set<http.ServerResponse>>}
 */
const sseClientsByTask = new Map();

async function loadTasksFromDisk() {
  try {
    await ensureDir(TASKS_DIR);
    const ids = await fsp.readdir(TASKS_DIR).catch(() => []);
    for (const id of ids) {
      const taskFile = path.join(TASKS_DIR, id, "task.json");
      try {
        const raw = await fsp.readFile(taskFile, "utf8");
        const task = safeJsonParse(raw);
        if (!task || typeof task !== "object" || task.id !== id) continue;
        task.processes = {}; // runtime-only
        task.nextSeq = typeof task.nextSeq === "number" ? task.nextSeq : 1;
        tasks.set(id, task);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function taskDir(taskId) {
  return path.join(TASKS_DIR, taskId);
}

function taskEventsFile(taskId) {
  return path.join(taskDir(taskId), "events.ndjson");
}

function taskMetaFile(taskId) {
  return path.join(taskDir(taskId), "task.json");
}

async function persistTaskMeta(task) {
  const clone = { ...task };
  delete clone.processes;
  await writeJsonAtomic(taskMetaFile(task.id), clone);
}

async function appendEvent(task, event) {
  const seq = task.nextSeq || 1;
  task.nextSeq = seq + 1;
  const enriched = { seq, ts: nowMs(), ...event };

  const line = JSON.stringify(enriched) + "\n";
  await ensureDir(taskDir(task.id));
  await fsp.appendFile(taskEventsFile(task.id), line, { encoding: "utf8" }).catch(() => undefined);

  const clients = sseClientsByTask.get(task.id);
  if (clients) {
    for (const res of clients) {
      try {
        res.write(`data: ${JSON.stringify(enriched)}\n\n`);
      } catch {
        // ignore
      }
    }
  }
}

async function replayEvents(taskId, sinceSeq, res) {
  const filePath = taskEventsFile(taskId);
  let raw = "";
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const ev = safeJsonParse(line);
    if (!ev || typeof ev.seq !== "number") continue;
    if (ev.seq <= sinceSeq) continue;
    try {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      return;
    }
  }
}

async function detectOriginDefaultBranch(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const ref = stdout.trim(); // origin/main
    const parts = ref.split("/");
    return parts.length >= 2 ? parts.slice(1).join("/") : "main";
  } catch {
    return "main";
  }
}

async function ensureGitIdentity(dir) {
  try {
    await execFileAsync("git", ["-C", dir, "config", "user.name", DEFAULT_GIT_NAME]);
    await execFileAsync("git", ["-C", dir, "config", "user.email", DEFAULT_GIT_EMAIL]);
  } catch {
    // ignore
  }
}

async function prepareRepo(task, repo) {
  const repoId = repo.id;
  const repoRoot = path.join(taskDir(task.id), "repos", repoId);
  const workdir = path.join(repoRoot, "workdir");
  await ensureDir(repoRoot);

  repo.workdir = workdir;
  repo.repoRoot = repoRoot;
  repo.diffFile = path.join(repoRoot, "diff.patch");

  if (repo.type === "local") {
    const src = String(repo.path || "").trim() || WORKSPACE_DIR;
    repo.src = src;
    const branch = sanitizeBranchName(`hfide-agent/${task.id}/${repoId}`.slice(0, 120));
    repo.branch = branch;

    await appendEvent(task, { type: "repo_status", repoId, status: "worktree_create", src });
    const parent = path.dirname(workdir);
    await ensureDir(parent);
    const env = await gitEnv();
    // (re)create worktree
    await execFileAsync("git", ["-C", src, "worktree", "add", "-B", branch, workdir], { env });
    await ensureGitIdentity(workdir);
    repo.prepared = true;
    return;
  }

  if (repo.type === "git") {
    let url = String(repo.url || "").trim();
    if (!url) throw new Error("missing_repo_url");
    const token = getGitToken();
    const gh = token ? parseGitHubOwnerRepo(url) : null;
    // If user pasted an SSH URL but only provided a token, transparently switch to https:// for git auth.
    if (token && gh) url = `https://github.com/${gh.owner}/${gh.repo}.git`;
    repo.url = url;
    const branch = sanitizeBranchName(`hfide-agent/${task.id}/${repoId}`.slice(0, 120));
    repo.branch = branch;

    await appendEvent(task, { type: "repo_status", repoId, status: "clone", url });
    const env = await gitEnv();
    await execFileAsync("git", ["clone", url, workdir], { env });
    await execFileAsync("git", ["-C", workdir, "checkout", "-B", branch], { env });
    await ensureGitIdentity(workdir);
    repo.prepared = true;
    return;
  }

  throw new Error("invalid_repo_type");
}

function computeTaskStatus(task) {
  const procs = task.processes && typeof task.processes === "object" ? Object.keys(task.processes).length : 0;
  if (procs > 0) return "running";
  const repos = Array.isArray(task.repos) ? task.repos : [];
  if (!repos.length) return "done";
  if (repos.some((r) => r.status === "running" || r.status === "preparing" || r.status === "pending")) return "running";
  if (repos.some((r) => r.status === "error")) return "error";
  if (repos.some((r) => r.status === "canceled")) return "canceled";
  return "done";
}

function spawnRunner(task, repo, command, prompt) {
  const repoId = repo.id;
  const cwd = repo.workdir;
  if (!cwd) throw new Error("repo_not_prepared");

  const child = cp.spawn("bash", ["-lc", command], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  task.processes[repoId] = child;
  repo.pid = child.pid || null;
  repo.status = "running";

  const onData = (stream) => (buf) => {
    const text = String(buf || "");
    if (!text) return;
    void appendEvent(task, { type: "log", repoId, stream, text });
  };
  child.stdout.on("data", onData("stdout"));
  child.stderr.on("data", onData("stderr"));

  child.on("close", (code, signal) => {
    repo.exitCode = typeof code === "number" ? code : null;
    repo.signal = signal || null;
    repo.status = code === 0 ? "done" : "error";
    repo.finishedAt = nowMs();
    delete task.processes[repoId];

    void (async () => {
      await appendEvent(task, { type: "repo_exit", repoId, code, signal });
      await generateRepoDiff(task, repo).catch(() => undefined);
      const nextStatus = computeTaskStatus(task);
      if (nextStatus !== task.status) {
        task.status = nextStatus;
        await appendEvent(task, { type: "task_status", status: nextStatus });
      }
      task.updatedAt = nowMs();
      await persistTaskMeta(task).catch(() => undefined);
    })();
  });

  if (prompt && child.stdin) {
    try {
      child.stdin.write(String(prompt) + "\n");
    } catch {
      // ignore
    }
  }
}

async function generateRepoDiff(task, repo) {
  const repoId = repo.id;
  if (!repo.workdir) return;
  const dir = repo.workdir;

  try {
    const env = await gitEnv();
    await execFileAsync("git", ["-C", dir, "add", "-A"], { env });
    const { stdout } = await execFileAsync("git", ["-C", dir, "diff", "--cached", "--no-color"], { env });
    const patch = String(stdout || "");
    await fsp.writeFile(repo.diffFile, patch, { encoding: "utf8" });
    await execFileAsync("git", ["-C", dir, "reset"], { env }).catch(() => undefined);
    await appendEvent(task, { type: "diff_ready", repoId, bytes: Buffer.byteLength(patch, "utf8") });
  } catch (e) {
    await appendEvent(task, { type: "diff_error", repoId, message: e && e.message ? String(e.message) : "diff_failed" });
  }
}

async function runTask(task) {
  task.status = "running";
  task.updatedAt = nowMs();
  await persistTaskMeta(task).catch(() => undefined);
  await appendEvent(task, { type: "task_status", status: "running" });

  for (const repo of task.repos) {
    try {
      repo.status = "preparing";
      await persistTaskMeta(task).catch(() => undefined);
      await prepareRepo(task, repo);
      await appendEvent(task, { type: "repo_status", repoId: repo.id, status: "ready" });
      spawnRunner(task, repo, task.command, task.prompt);
    } catch (e) {
      repo.status = "error";
      repo.error = e && e.message ? String(e.message) : "prepare_failed";
      await appendEvent(task, { type: "repo_error", repoId: repo.id, message: repo.error });
    }
  }
}

async function cancelTask(task) {
  task.status = "canceled";
  task.updatedAt = nowMs();
  await appendEvent(task, { type: "task_status", status: "canceled" });

  for (const repo of task.repos) {
    const child = task.processes[repo.id];
    if (!child) continue;
    try {
      repo.status = "canceled";
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  await persistTaskMeta(task).catch(() => undefined);
}

async function resumeTask(task) {
  if (!task || typeof task !== "object") return;
  if (!task.repos || !Array.isArray(task.repos)) return;

  task.status = "running";
  task.updatedAt = nowMs();
  await appendEvent(task, { type: "task_status", status: "running" });
  await persistTaskMeta(task).catch(() => undefined);

  for (const repo of task.repos) {
    if (task.processes[repo.id]) continue;
    if (repo.status === "running") continue;
    if (!repo.workdir || !(await fileExists(repo.workdir))) continue;
    repo.status = "running";
    spawnRunner(task, repo, task.command, task.prompt);
  }
}

async function promoteRepo(task, repo, opts) {
  const repoId = repo.id;
  const dir = repo.workdir;
  if (!dir) throw new Error("repo_not_ready");

  const env = await gitEnv();

  await ensureGitIdentity(dir);
  await execFileAsync("git", ["-C", dir, "add", "-A"], { env });

  // Commit may fail if nothing to commit.
  const message = (opts && typeof opts.message === "string" && opts.message.trim()) || `hfide-agent: ${task.id}`;
  try {
    await execFileAsync("git", ["-C", dir, "commit", "-m", message], { env });
  } catch (e) {
    const stderr = e && typeof e.stderr === "string" ? e.stderr : "";
    if (stderr && /nothing to commit/i.test(stderr)) {
      await appendEvent(task, { type: "promote_skip", repoId, reason: "nothing_to_commit" });
      return { ok: true, skipped: true };
    }
    throw e;
  }

  let remoteUrl = "";
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { env });
    remoteUrl = stdout.trim();
  } catch {
    // no origin
  }

  const gh = parseGitHubOwnerRepo(remoteUrl);
  const token = getGitToken();
  const branch = typeof repo.branch === "string" ? repo.branch : "";

  await appendEvent(task, { type: "promote_status", repoId, status: "push" });
  if (token && gh && branch) {
    // Avoid SSH auth requirements when user only provided a token.
    const pushUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
    await execFileAsync("git", ["-C", dir, "push", pushUrl, `HEAD:refs/heads/${branch}`], { env });
  } else {
    await execFileAsync("git", ["-C", dir, "push", "-u", "origin", repo.branch || "HEAD"], { env });
  }

  // PR (GitHub only)
  if (!gh) {
    await appendEvent(task, { type: "promote_status", repoId, status: "pushed_no_pr" });
    return { ok: true, pushed: true };
  }
  if (!token) {
    await appendEvent(task, { type: "promote_status", repoId, status: "pushed_no_pr", reason: "missing_github_token" });
    return { ok: true, pushed: true, prSkipped: true };
  }

  const base = await detectOriginDefaultBranch(dir);
  const title = (opts && typeof opts.prTitle === "string" && opts.prTitle.trim()) || message;
  const body = (opts && typeof opts.prBody === "string" && opts.prBody.trim()) || (task.prompt ? `Prompt:\n\n${task.prompt}\n` : "");

  await appendEvent(task, { type: "promote_status", repoId, status: "create_pr", base });
  const pr = await githubApiJson("POST", `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/pulls`, {
    title,
    head: repo.branch,
    base,
    body,
    draft: false
  });
  const prUrl = pr && typeof pr.html_url === "string" ? pr.html_url : "";
  repo.prUrl = prUrl;
  await appendEvent(task, { type: "pr_created", repoId, url: prUrl });
  return { ok: true, prUrl };
}

async function handlePromote(task, req, res, repoId) {
  let body = {};
  try {
    body = await readJson(req);
  } catch {
    body = {};
  }
  const opts = {
    message: body && typeof body.message === "string" ? body.message : undefined,
    prTitle: body && typeof body.prTitle === "string" ? body.prTitle : undefined,
    prBody: body && typeof body.prBody === "string" ? body.prBody : undefined
  };

  const targets = repoId ? task.repos.filter((r) => r.id === repoId) : task.repos;
  if (!targets.length) return sendError(res, 404, "not_found", "Repo not found");

  const results = [];
  for (const repo of targets) {
    try {
      const out = await promoteRepo(task, repo, opts);
      results.push({ repoId: repo.id, ok: true, ...out });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "promote_failed";
      await appendEvent(task, { type: "promote_error", repoId: repo.id, message: msg });
      results.push({ repoId: repo.id, ok: false, message: msg });
    }
  }

  task.updatedAt = nowMs();
  await persistTaskMeta(task).catch(() => undefined);
  sendJson(res, 200, { ok: true, results });
}

function taskSummary(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    prompt: task.prompt,
    command: task.command,
    repos: (task.repos || []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      url: r.url,
      path: r.path,
      branch: r.branch,
      status: r.status,
      exitCode: r.exitCode,
      prUrl: r.prUrl || null
    }))
  };
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  };
}

function addSseClient(taskId, res) {
  let set = sseClientsByTask.get(taskId);
  if (!set) {
    set = new Set();
    sseClientsByTask.set(taskId, set);
  }
  set.add(res);
  res.on("close", () => {
    const cur = sseClientsByTask.get(taskId);
    if (!cur) return;
    cur.delete(res);
    if (!cur.size) sseClientsByTask.delete(taskId);
  });
}

function getTaskFromPathname(pathname) {
  const m = pathname.match(/^\/tasks\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  return { taskId: m[1], rest: m[2] || "" };
}

async function main() {
  await loadTasksFromDisk();
  await ensureDir(TASKS_DIR);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (pathname === "/healthz") return sendText(res, 200, "ok\n");

      if (pathname === "/tasks" && req.method === "GET") {
        const list = Array.from(tasks.values())
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .map((t) => taskSummary(t));
        return sendJson(res, 200, { ok: true, tasks: list });
      }

      if (pathname === "/tasks" && req.method === "POST") {
        const body = await readJson(req);
        const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
        const command = body && typeof body.command === "string" && body.command.trim() ? body.command.trim() : DEFAULT_RUNNER_CMD;
        const title =
          body && typeof body.title === "string" && body.title.trim()
            ? body.title.trim()
            : prompt
              ? prompt.trim().split("\n")[0].slice(0, 80)
              : `Task ${new Date().toLocaleString()}`;

        const reposIn = body && Array.isArray(body.repos) ? body.repos : [];
        const repos =
          reposIn.length > 0
            ? reposIn
            : [
                {
                  id: "workspace",
                  name: "Workspace",
                  type: "local",
                  path: WORKSPACE_DIR
                }
              ];

        /** @type {any} */
        const task = {
          id: randomId("task"),
          title,
          prompt,
          command,
          status: "queued",
          createdAt: nowMs(),
          updatedAt: nowMs(),
          nextSeq: 1,
          processes: {},
          repos: repos.map((r, idx) => {
            const type = r && typeof r.type === "string" ? r.type : r && r.url ? "git" : "local";
            const repoId = r && typeof r.id === "string" && r.id ? r.id : `repo${idx + 1}`;
            return {
              id: repoId,
              name: (r && typeof r.name === "string" && r.name) || repoId,
              type,
              url: r && typeof r.url === "string" ? r.url : undefined,
              path: r && typeof r.path === "string" ? r.path : undefined,
              status: "pending",
              prepared: false,
              pid: null,
              exitCode: null,
              prUrl: null
            };
          })
        };

        tasks.set(task.id, task);
        await persistTaskMeta(task);
        await appendEvent(task, { type: "task_created", title, command });

        // Fire-and-forget run
        void runTask(task).catch(async (e) => {
          task.status = "error";
          task.updatedAt = nowMs();
          await appendEvent(task, { type: "task_error", message: e && e.message ? String(e.message) : "run_failed" });
          await persistTaskMeta(task).catch(() => undefined);
        });

        return sendJson(res, 200, { ok: true, task: taskSummary(task) });
      }

      const p = getTaskFromPathname(pathname);
      if (p) {
        const task = tasks.get(p.taskId);
        if (!task) return sendError(res, 404, "not_found", "Task not found");

        const rest = p.rest;

        if (!rest && req.method === "GET") return sendJson(res, 200, { ok: true, task: taskSummary(task) });

        if (rest === "events" && req.method === "GET") {
          const since = Number(url.searchParams.get("since") || "0");
          res.writeHead(200, sseHeaders());
          res.write(": ok\n\n");
          await replayEvents(task.id, Number.isFinite(since) ? since : 0, res);
          addSseClient(task.id, res);
          const ping = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              // ignore
            }
          }, SSE_PING_MS);
          res.on("close", () => clearInterval(ping));
          return;
        }

        if (rest === "cancel" && req.method === "POST") {
          await cancelTask(task);
          await persistTaskMeta(task).catch(() => undefined);
          return sendJson(res, 200, { ok: true });
        }

        if (rest === "resume" && req.method === "POST") {
          await resumeTask(task);
          await persistTaskMeta(task).catch(() => undefined);
          return sendJson(res, 200, { ok: true });
        }

        if (rest === "input" && req.method === "POST") {
          const body = await readJson(req).catch(() => ({}));
          const text = body && typeof body.text === "string" ? body.text : "";
          if (!text) return sendError(res, 400, "bad_request", "Missing text");
          const repoId = body && typeof body.repoId === "string" ? body.repoId : "";
          const targets = repoId ? [repoId] : Object.keys(task.processes || {});
          for (const id of targets) {
            const child = task.processes[id];
            if (!child || !child.stdin) continue;
            try {
              child.stdin.write(text.endsWith("\n") ? text : text + "\n");
            } catch {
              // ignore
            }
          }
          await appendEvent(task, { type: "stdin", repoId: repoId || null, text });
          return sendJson(res, 200, { ok: true });
        }

        if (rest.startsWith("repos/") && req.method === "GET") {
          // /tasks/:id/repos/:repoId/diff
          const m = rest.match(/^repos\/([^/]+)\/diff$/);
          if (m) {
            const repoId = m[1];
            const repo = task.repos.find((r) => r.id === repoId);
            if (!repo) return sendError(res, 404, "not_found", "Repo not found");
            const diffPath = repo.diffFile || path.join(taskDir(task.id), "repos", repoId, "diff.patch");
            try {
              const raw = await fsp.readFile(diffPath, "utf8");
              res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
              res.end(raw);
              return;
            } catch {
              return sendError(res, 404, "not_found", "Diff not ready");
            }
          }
        }

        if (rest === "promote" && req.method === "POST") {
          return handlePromote(task, req, res, null);
        }

        // /tasks/:id/repos/:repoId/promote
        const promoteRepoMatch = rest.match(/^repos\/([^/]+)\/promote$/);
        if (promoteRepoMatch && req.method === "POST") {
          return handlePromote(task, req, res, promoteRepoMatch[1]);
        }

        return sendError(res, 404, "not_found", "Unknown endpoint");
      }

      return sendError(res, 404, "not_found", "Unknown endpoint");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "internal_error";
      // eslint-disable-next-line no-console
      console.error(`[agent-server] error: ${msg}`);
      return sendError(res, 500, "internal_error", msg);
    }
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`agent-server listening on http://${HOST}:${PORT} (dir: ${AGENT_DIR})`);
  });
}

void main();
