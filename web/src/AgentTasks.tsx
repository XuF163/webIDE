import React, { useEffect, useMemo, useRef, useState } from "react";

type RepoSummary = {
  id: string;
  name: string;
  type: string;
  url?: string;
  path?: string;
  branch?: string;
  status?: string;
  exitCode?: number | null;
  prUrl?: string | null;
};

type TaskSummary = {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  command: string;
  repos: RepoSummary[];
};

type ApiOk<T> = { ok: true } & T;
type ApiErr = { ok: false; code?: string; message?: string };
type ApiResponse<T> = ApiOk<T> | ApiErr;

type RunnerChoice = "codex" | "claude";

type TaskEvent = {
  seq?: number;
  ts?: number;
  type?: string;
  repoId?: string;
  status?: string;
  stream?: string;
  text?: string;
  code?: number | null;
  message?: string;
  bytes?: number;
};

type Project = {
  id: string;
  url: string;
  name: string;
  runner: RunnerChoice;
  createdAt: number;
  branch?: string;
  cloneMode?: "single" | "all";
};

type ProjectsFile = { version: 1; projects: Project[] };

const RUNNER_COMMAND: Record<RunnerChoice, string> = { codex: "codex exec --full-auto", claude: "claudecode" };
const ACTIVE_TASK_STATUSES = new Set(["queued", "pending", "preparing", "running"]);
const PROJECTS_PATH = ".hfide/agent/projects.json";
const OUTPUT_MAX_LINES = 2200;

function isOk<T>(res: ApiResponse<T>): res is ApiOk<T> {
  return Boolean(res && (res as ApiOk<T>).ok === true);
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json || typeof json !== "object") return { ok: false, code: "bad_json", message: "Bad JSON response" };
  return json;
}

async function readWorkspaceText(path: string) {
  const res = await fetch(`/api/fs/file?root=workspace&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return await res.text().catch(() => "");
}

async function writeWorkspaceText(path: string, content: string) {
  const res = await fetch(`/api/fs/file?root=workspace&path=${encodeURIComponent(path)}`, { method: "PUT", cache: "no-store", body: content });
  if (!res.ok) throw new Error(`Write failed: ${path}`);
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isTaskActive(status?: string) {
  return ACTIVE_TASK_STATUSES.has(String(status || "").toLowerCase());
}

function repoIdFromUrl(url: string) {
  const raw = String(url || "").trim().replace(/\.git$/i, "");
  const m = raw.match(/([^/:]+)\/([^/]+)$/);
  const base = m ? `${m[1]}-${m[2]}` : "repo";
  return base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "repo";
}

function projectNameFromUrl(url: string) {
  const raw = String(url || "").trim().replace(/\.git$/i, "");
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return u.host || raw;
  } catch {
    const m = raw.match(/([^/:]+)\/([^/]+)$/);
    return m ? `${m[1]}/${m[2]}` : raw;
  }
}

function statusLabel(status?: string) {
  const s = String(status || "unknown").toLowerCase();
  const map: Record<string, string> = {
    queued: "Queued",
    pending: "Pending",
    preparing: "Preparing",
    running: "Running",
    done: "Done",
    canceled: "Canceled",
    error: "Error"
  };
  return map[s] || s;
}

function trimOutputLines(lines: string[]) {
  if (lines.length <= OUTPUT_MAX_LINES) return lines;
  return lines.slice(lines.length - OUTPUT_MAX_LINES);
}

function formatEventLine(ev: TaskEvent) {
  const type = String(ev.type || "event");
  const repoPrefix = ev.repoId ? `${ev.repoId} · ` : "";
  const status = typeof ev.status === "string" ? ev.status.trim() : "";
  const msg = typeof ev.message === "string" ? ev.message.trim() : "";

  if (type === "repo_status") return `${repoPrefix}${status || "status"}`;
  if (type === "task_status") return `task · ${status || "status"}`;
  if (type === "repo_exit") return `${repoPrefix}exit ${typeof ev.code === "number" ? ev.code : "?"}`;
  if (type === "diff_ready") return `${repoPrefix}diff ready (${typeof ev.bytes === "number" ? ev.bytes : 0} bytes)`;
  if (type === "pr_created") return `${repoPrefix}PR created`;
  if (type.endsWith("_error") || type === "repo_error" || type === "task_error") return `ERROR · ${repoPrefix}${msg || type}`;
  if (msg) return `${repoPrefix}${type}: ${msg}`;
  if (status) return `${repoPrefix}${type}: ${status}`;
  return `${repoPrefix}${type}`;
}

function projectStateFromTasks(tasks: TaskSummary[]) {
  const active = tasks.some((t) => isTaskActive(t.status));
  if (active) return "active";
  const last = tasks[0];
  const s = String(last?.status || "").toLowerCase();
  if (s === "error") return "error";
  if (s === "done") return "done";
  if (s === "canceled") return "canceled";
  return "idle";
}

async function loadProjectsFromDisk(): Promise<Project[]> {
  const raw = await readWorkspaceText(PROJECTS_PATH);
  if (!raw) return [];
  const parsed = safeJsonParse<ProjectsFile>(raw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects)) return [];
  return parsed.projects
    .map((p): Project => ({
      id: String(p.id || ""),
      url: String(p.url || ""),
      name: String(p.name || ""),
      runner: p.runner === "claude" ? "claude" : "codex",
      createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
      branch: p.branch,
      cloneMode: p.cloneMode
    }))
    .filter((p) => p.id && p.url);
}

async function saveProjectsToDisk(projects: Project[]) {
  const payload: ProjectsFile = { version: 1, projects };
  await writeWorkspaceText(PROJECTS_PATH, JSON.stringify(payload, null, 2));
}

export default function AgentTasks() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [showProjectModal, setShowProjectModal] = useState(false);

  // Project form state
  const [projectUrl, setProjectUrl] = useState("");
  const [projectRunner, setProjectRunner] = useState<RunnerChoice>("codex");
  const [projectBranch, setProjectBranch] = useState("");
  const [cloneMode, setCloneMode] = useState<"single" | "all">("single");
  const [cloningId, setCloningId] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [sseState, setSseState] = useState<"idle" | "connecting" | "open" | "error" | "offline">("idle");
  const [sseReconnectNonce, setSseReconnectNonce] = useState(0);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  const [outputLines, setOutputLines] = useState<string[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef(0);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId) || null, [projects, selectedProjectId]);

  const tasksForSelectedProject = useMemo(() => {
    if (!selectedProject) return [] as TaskSummary[];
    const target = selectedProject.url.trim().replace(/\/+$/, "");
    const list = tasks.filter((task) => task.repos?.some((r) => String(r.url || "").trim().replace(/\/+$/, "") === target));
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [tasks, selectedProject]);

  const selectedTask = useMemo(() => tasksForSelectedProject.find((t) => t.id === selectedTaskId) || null, [tasksForSelectedProject, selectedTaskId]);

  useEffect(() => {
    if (!projects.length) {
      if (selectedProjectId) setSelectedProjectId("");
      return;
    }
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) return;
    setSelectedProjectId(projects[0].id);
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!tasksForSelectedProject.length) {
      if (selectedTaskId) setSelectedTaskId("");
      return;
    }
    if (selectedTaskId && tasksForSelectedProject.some((t) => t.id === selectedTaskId)) return;
    const active = tasksForSelectedProject.find((t) => isTaskActive(t.status));
    setSelectedTaskId(active?.id || tasksForSelectedProject[0].id);
  }, [tasksForSelectedProject, selectedTaskId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadProjectsFromDisk();
        if (cancelled) return;
        setProjects(loaded);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      const res = await apiJson<{ tasks: TaskSummary[] }>("/api/agent/tasks");
      if (!active) return;
      if (!isOk(res)) return;
      setTasks(res.tasks || []);
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    lastSeqRef.current = 0;
    setOutputLines([]);

    if (!selectedTaskId) {
      setSseState("idle");
      return;
    }

    if (!isOnline) {
      setSseState("offline");
      return;
    }

    setSseState("connecting");
    const es = new EventSource(`/api/agent/tasks/${encodeURIComponent(selectedTaskId)}/events?since=0`);
    esRef.current = es;

    es.onopen = () => setSseState("open");
    es.onerror = () => setSseState(isOnline ? "error" : "offline");

    es.onmessage = (msg) => {
      try {
        const ev = safeJsonParse<TaskEvent>(String(msg.data || "{}")) || {};
        const seq = typeof ev.seq === "number" ? ev.seq : 0;
        if (seq && seq <= lastSeqRef.current) return;
        lastSeqRef.current = seq || lastSeqRef.current + 1;

        if (ev.type === "log") {
          const chunk = String(ev.text || "").replace(/\r\n/g, "\n");
          if (!chunk) return;
          const prefix = `[${ev.repoId || "task"}${ev.stream ? `/${ev.stream}` : ""}] `;
          const lines = chunk.split("\n").filter((line) => line.length > 0);
          if (!lines.length) return;
          setOutputLines((prev) => trimOutputLines([...prev, ...lines.map((line) => prefix + line)]));
          return;
        }

        setOutputLines((prev) => trimOutputLines([...prev, `[event] ${formatEventLine(ev)}`]));
      } catch {
        // ignore
      }
    };

    return () => {
      es.close();
    };
  }, [selectedTaskId, sseReconnectNonce, isOnline]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [outputLines]);

  async function addProject() {
    const url = projectUrl.trim();
    if (!url) return;

    setBusy(true);
    setError("");
    try {
      const now = Date.now();
      const name = projectNameFromUrl(url);
      const id = repoIdFromUrl(url);
      const next: Project = {
        id,
        url,
        name,
        runner: projectRunner,
        createdAt: now,
        branch: cloneMode === "single" ? projectBranch.trim() : undefined,
        cloneMode
      };

      const merged = [next, ...projects.filter((p) => p.id !== id)];
      setProjects(merged);
      await saveProjectsToDisk(merged);

      setSelectedProjectId(id);
      setProjectUrl("");
      setProjectRunner("codex");
      setProjectBranch("");
      setCloneMode("single");
      setShowProjectModal(false);

      // Trigger fake cloning animation
      setCloningId(id);
      setTimeout(() => setCloningId(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save project.");
    } finally {
      setBusy(false);
    }
  }

  async function removeProject(projectId: string) {
    setBusy(true);
    setError("");
    try {
      const next = projects.filter((p) => p.id !== projectId);
      setProjects(next);
      await saveProjectsToDisk(next);
      if (selectedProjectId === projectId) setSelectedProjectId(next[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save project.");
    } finally {
      setBusy(false);
    }
  }

  async function startTask() {
    if (!selectedProject) return;
    const text = prompt.trim();
    if (!text) return;

    setBusy(true);
    setError("");
    try {
      const repoId = repoIdFromUrl(selectedProject.url);
      const runner = selectedProject.runner || "codex";
      const command = RUNNER_COMMAND[runner];

      const reposPayload: Record<string, unknown> = {
        id: repoId,
        name: selectedProject.name,
        type: "git",
        url: selectedProject.url
      };

      if (selectedProject.cloneMode === "single" && selectedProject.branch) {
        reposPayload.branch = selectedProject.branch;
      }

      const res = await apiJson<{ task: TaskSummary }>("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: text.split("\n")[0].slice(0, 80),
          prompt: text,
          command,
          repos: [reposPayload]
        })
      });
      if (!isOk(res)) {
        setError(res.message || "Failed to create task.");
        return;
      }
      setPrompt("");
      setSelectedTaskId(res.task.id);
    } catch {
      setError("Failed to create task.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelTask() {
    if (!selectedTaskId) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedTaskId)}/cancel`, { method: "POST" });
    } finally {
      setBusy(false);
    }
  }

  function openProjectModal() {
    setError("");
    setProjectUrl("");
    setProjectBranch("");
    setCloneMode("single");
    setProjectRunner("codex");
    setShowProjectModal(true);
  }

  const sseLabel =
    sseState === "open"
      ? "Live"
      : sseState === "connecting"
        ? "Connecting"
        : sseState === "error"
          ? "Reconnecting"
          : sseState === "offline"
            ? "Offline"
            : "Idle";

  return (
    <div className="agent win10-agent">
      <aside className="win10-sidebar">
        <div className="win10-sidebar-header">
          <div className="win10-title">Git Projects</div>
          <button className="win10-btn primary" type="button" disabled={busy} onClick={() => openProjectModal()}>
            + Add
          </button>
        </div>
        <div className="win10-projects">
          {projects.map((p) => {
            const projTasks = tasks.filter((t) => t.repos?.some((r) => String(r.url || "").trim().replace(/\/+$/, "") === p.url.trim().replace(/\/+$/, "")));
            const state = projectStateFromTasks(projTasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
            const isCloning = cloningId === p.id;

            return (
              <div key={p.id} className="win10-project-row" data-active={p.id === selectedProjectId}>
                <button
                  className="win10-project-item"
                  type="button"
                  onClick={() => setSelectedProjectId(p.id)}
                  title={p.url}
                >
                  <div className="win10-project-top">
                    <span className="win10-project-name">{p.name}</span>
                    <span className="win10-status-indicator" data-state={isCloning ? "cloning" : state} />
                  </div>
                  <div className="win10-project-meta">
                    {p.branch ? `${p.branch} · ` : ""}{p.cloneMode === "all" ? "All branches · " : ""}{projTasks.length} runs
                  </div>
                  {isCloning && (
                    <div className="win10-progress-bar">
                      <div className="win10-progress-value" />
                    </div>
                  )}
                </button>
                <button className="win10-icon-btn remove" type="button" disabled={busy} onClick={() => void removeProject(p.id)} title="Remove">
                  ×
                </button>
              </div>
            );
          })}
          {!projects.length ? <div className="win10-empty">Add a Git repo to start.</div> : null}
        </div>
      </aside>

      <main className="win10-main">
        <div className="win10-topbar">
          <div className="win10-top-title">{selectedProject ? selectedProject.name : "Agent Workspace"}</div>
          <div className="win10-top-status">
            <div className="win10-conn-badge" data-state={sseState}>
              <span className="win10-conn-dot" />
              {sseLabel}
            </div>
          </div>
        </div>

        {error ? <div className="win10-error-banner">{error}</div> : null}

        {selectedProject ? (
          <div className="win10-content">
            <div className="win10-context-bar">
              <span className="win10-pill" data-state={selectedTask ? selectedTask.status : "idle"}>
                {selectedTask ? statusLabel(selectedTask.status) : "Idle"}
              </span>
              <span className="win10-url" title={selectedProject.url}>{selectedProject.url}</span>
              <div className="win10-spacer" />
              {selectedTask && isTaskActive(selectedTask.status) ? (
                <button className="win10-btn danger" type="button" disabled={busy} onClick={() => void cancelTask()}>
                  Stop
                </button>
              ) : null}
            </div>

            <pre
              ref={outputRef}
              className="win10-console"
              onScroll={() => {
                const el = outputRef.current;
                if (!el) return;
                stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              {outputLines.length ? outputLines.join("\n") : <span className="win10-console-placeholder">Waiting for task execution...</span>}
            </pre>

            <div className="win10-input-area">
              <textarea
                className="win10-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what to build..."
              />
              <button className="win10-btn primary large" type="button" disabled={busy || !prompt.trim()} onClick={() => void startTask()}>
                Run Task
              </button>
            </div>
          </div>
        ) : (
          <div className="win10-placeholder">
            <div className="win10-placeholder-icon"></div>
            <div>Select or add a project to begin</div>
          </div>
        )}
      </main>

      {showProjectModal ? (
        <div className="win10-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowProjectModal(false)}>
          <form
            className="win10-modal"
            onSubmit={(e) => {
              e.preventDefault();
              void addProject();
            }}
          >
            <div className="win10-modal-header">
              <span className="win10-modal-title">Add Git Project</span>
              <button className="win10-icon-btn" type="button" onClick={() => setShowProjectModal(false)}>×</button>
            </div>
            <div className="win10-modal-body">
              <div className="win10-form-group">
                <label>Repository URL</label>
                <input
                  className="win10-input"
                  value={projectUrl}
                  onChange={(e) => setProjectUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  required
                  autoFocus
                />
              </div>

              <div className="win10-form-group">
                <label>Branch / Clone Strategy</label>
                <div className="win10-radio-group">
                  <label className="win10-radio">
                    <input
                      type="radio"
                      name="cloneMode"
                      checked={cloneMode === "single"}
                      onChange={() => setCloneMode("single")}
                    />
                    <span>Single Branch</span>
                  </label>
                  <label className="win10-radio">
                    <input
                      type="radio"
                      name="cloneMode"
                      checked={cloneMode === "all"}
                      onChange={() => setCloneMode("all")}
                    />
                    <span>All Branches</span>
                  </label>
                </div>
              </div>

              {cloneMode === "single" && (
                <div className="win10-form-group">
                  <label>Branch Name (Optional)</label>
                  <input
                    className="win10-input"
                    value={projectBranch}
                    onChange={(e) => setProjectBranch(e.target.value)}
                    placeholder="main (default)"
                  />
                </div>
              )}

              <div className="win10-form-group">
                <label>Runner</label>
                <select className="win10-select" value={projectRunner} onChange={(e) => setProjectRunner(e.target.value as RunnerChoice)}>
                  <option value="codex">Codex (Default)</option>
                  <option value="claude">Claude</option>
                </select>
              </div>
            </div>
            <div className="win10-modal-footer">
              <button className="win10-btn" type="button" disabled={busy} onClick={() => setShowProjectModal(false)}>
                Cancel
              </button>
              <button className="win10-btn primary" type="submit" disabled={busy || !projectUrl.trim()}>
                Add Project
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
