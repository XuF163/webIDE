import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Types ---

type RepoSummary = {
  id: string;
  name: string;
  type: string;
  url?: string;
  path?: string;
  branch?: string;
  status?: string;
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

type TerminalState = {
  lines: string[];
  history: string[]; // Command history
  activeTaskId?: string;
};

// --- Constants ---

const RUNNER_COMMAND: Record<RunnerChoice, string> = { codex: "codex exec --full-auto", claude: "claudecode" };
const PROJECTS_PATH = ".hfide/agent/projects.json";
const TEMP_DIR = ".hfide/tmp";

// --- API Helpers ---

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

async function writeWorkspaceFile(path: string, body: BodyInit) {
  const res = await fetch(`/api/fs/file?root=workspace&path=${encodeURIComponent(path)}`, { method: "PUT", cache: "no-store", body });
  if (!res.ok) throw new Error(`Write failed: ${path}`);
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

// --- Components ---

function TerminalView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="agent-term-view" ref={ref} style={{
      flex: 1,
      background: "#0c0c0c",
      color: "#cccccc",
      fontFamily: "Consolas, monospace",
      padding: "8px",
      overflowY: "auto",
      fontSize: "13px",
      lineHeight: "1.4",
      whiteSpace: "pre-wrap"
    }}>
      {lines.map((line, i) => (
        <div key={i} className="agent-term-line">{line}</div>
      ))}
      <div className="agent-term-cursor" style={{ display: "inline-block", width: "8px", height: "14px", background: "#cccccc" }} />
    </div>
  );
}

export default function AgentTasks() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [terminals, setTerminals] = useState<Record<string, TerminalState>>({});
  const [inputVal, setInputVal] = useState("");
  const [busy, setBusy] = useState(false);

  // Project Modal State
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectRunner, setProjectRunner] = useState<RunnerChoice>("codex");
  const [projectBranch, setProjectBranch] = useState("");
  const [cloneMode, setCloneMode] = useState<"single" | "all">("single");

  // SSE Refs
  const esRef = useRef<EventSource | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);

  // --- Load Projects ---
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadProjectsFromDisk();
        setProjects(loaded);
        if (loaded.length > 0 && !selectedProjectId) {
          setSelectedProjectId(loaded[0].id);
        }
      } catch { }
    })();
  }, []);

  // --- Initialize Terminal State ---
  useEffect(() => {
    if (selectedProjectId && !terminals[selectedProjectId]) {
      setTerminals(prev => ({
        ...prev,
        [selectedProjectId]: { lines: ["Welcome to Agent Terminal. Ready for commands."], history: [] }
      }));
    }
  }, [selectedProjectId]);

  const activeTerminal = terminals[selectedProjectId] || { lines: [], history: [] };

  // --- SSE Connection for Active Task ---
  useEffect(() => {
    // Determine the active task ID from the current terminal state
    const currentTerm = terminals[selectedProjectId];
    const taskId = currentTerm?.activeTaskId;

    // If the task ID hasn't changed, do nothing
    if (activeTaskIdRef.current === taskId) return;

    // Close existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    activeTaskIdRef.current = taskId || null;

    if (!taskId) return;

    const es = new EventSource(`/api/agent/tasks/${encodeURIComponent(taskId)}/events?since=0`);
    esRef.current = es;

    es.onmessage = (msg) => {
      try {
        const ev = safeJsonParse<TaskEvent>(String(msg.data || "{}")) || {};
        if (ev.type === "log" && ev.text) {
          const newLines = ev.text.split("\n");
          setTerminals(prev => {
            const term = prev[selectedProjectId];
            if (!term) return prev;
            return {
              ...prev,
              [selectedProjectId]: {
                ...term,
                lines: [...term.lines, ...newLines]
              }
            };
          });
        }
      } catch { }
    };

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [selectedProjectId, terminals]); // Depend on terminals to catch activeTaskId updates

  // --- Actions ---

  async function handleAddProject() {
    if (!projectUrl.trim()) return;
    const now = Date.now();
    const id = repoIdFromUrl(projectUrl);
    const name = projectNameFromUrl(projectUrl);

    const newProject: Project = {
      id,
      url: projectUrl,
      name,
      runner: projectRunner,
      createdAt: now,
      branch: cloneMode === "single" ? projectBranch : undefined,
      cloneMode
    };

    const nextProjects = [newProject, ...projects.filter(p => p.id !== id)];
    setProjects(nextProjects);
    await saveProjectsToDisk(nextProjects);
    setSelectedProjectId(id);
    setShowProjectModal(false);

    // Reset form
    setProjectUrl("");
    setProjectBranch("");
    setCloneMode("single");
  }

  async function handleRemoveProject(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const next = projects.filter(p => p.id !== id);
    setProjects(next);
    await saveProjectsToDisk(next);
    if (selectedProjectId === id) {
      setSelectedProjectId(next[0]?.id || "");
    }
  }

  async function runCommand() {
    if (!selectedProjectId || !inputVal.trim()) return;
    const project = projects.find(p => p.id === selectedProjectId);
    if (!project) return;

    const cmdText = inputVal.trim();
    setInputVal("");
    setBusy(true);

    // Append user input to terminal immediately
    setTerminals(prev => {
      const term = prev[selectedProjectId] || { lines: [], history: [] };
      return {
        ...prev,
        [selectedProjectId]: {
          ...term,
          lines: [...term.lines, `> ${cmdText}`], // Echo command
          history: [...term.history, cmdText]
        }
      };
    });

    try {
      const runner = project.runner || "codex";
      const baseCmd = RUNNER_COMMAND[runner];

      const reposPayload: Record<string, unknown> = {
        id: project.id,
        name: project.name,
        type: "git",
        url: project.url
      };
      if (project.cloneMode === "single" && project.branch) {
        reposPayload.branch = project.branch;
      }

      const res = await apiJson<{ task: TaskSummary }>("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: cmdText.slice(0, 50),
          prompt: cmdText,
          command: baseCmd,
          repos: [reposPayload]
        })
      });

      if (isOk(res)) {
        setTerminals(prev => ({
          ...prev,
          [selectedProjectId]: {
            ...prev[selectedProjectId],
            activeTaskId: res.task.id
          }
        }));
      } else {
        throw new Error(res.message || "Task creation failed");
      }

    } catch (e) {
      const err = e instanceof Error ? e.message : "Unknown error";
      setTerminals(prev => ({
        ...prev,
        [selectedProjectId]: {
          ...prev[selectedProjectId],
          lines: [...prev[selectedProjectId].lines, `Error: ${err}`]
        }
      }));
    } finally {
      setBusy(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      await processFiles(files);
    }
  }

  async function handlePaste(e: React.ClipboardEvent) {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      const files = Array.from(e.clipboardData.files);
      await processFiles(files);
    }
  }

  async function processFiles(files: File[]) {
    if (!selectedProjectId) return;
    setBusy(true);
    let insertedPaths = "";

    for (const file of files) {
      try {
        const timestamp = Date.now();
        const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const path = `${TEMP_DIR}/${timestamp}_${safeName}`;

        const buffer = await file.arrayBuffer();
        await writeWorkspaceFile(path, buffer);

        insertedPaths += ` "${path}"`;

        setTerminals(prev => ({
          ...prev,
          [selectedProjectId]: {
            ...prev[selectedProjectId],
            lines: [...prev[selectedProjectId].lines, `[System] Uploaded ${file.name} to ${path}`]
          }
        }));
      } catch (err) {
        console.error(err);
      }
    }

    if (insertedPaths) {
      setInputVal(prev => prev + insertedPaths);
    }
    setBusy(false);
  }

  return (
    <div className="agent win10-agent" style={{ display: "flex", height: "100%", background: "#1e1e1e" }}>
      {/* Sidebar */}
      <aside className="win10-sidebar" style={{ width: "260px", borderRight: "1px solid #333", display: "flex", flexDirection: "column" }}>
        <div style={{ height: "40px", padding: "0 12px", borderBottom: "1px solid #333", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="win10-title">Git 项目</div>
          <button className="win10-btn primary" onClick={() => setShowProjectModal(true)}>+ 添加</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {projects.map(p => (
            <div
              key={p.id}
              className="win10-project-row"
              data-active={p.id === selectedProjectId}
              onClick={() => setSelectedProjectId(p.id)}
              style={{
                display: "flex", alignItems: "center", padding: "8px 12px", cursor: "pointer",
                background: p.id === selectedProjectId ? "#37373d" : "transparent",
                borderLeft: p.id === selectedProjectId ? "3px solid #0078d4" : "3px solid transparent",
                color: p.id === selectedProjectId ? "#fff" : "#ccc"
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: "11px", color: "#888" }}>{p.branch || "default"}</div>
              </div>
              <button className="win10-icon-btn remove" onClick={(e) => handleRemoveProject(p.id, e)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Area */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", background: "#1e1e1e" }}>
        {selectedProjectId ? (
          <>
            {/* Top: Terminal */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderBottom: "1px solid #333" }}>
              <div style={{ height: "32px", background: "#252526", padding: "0 12px", display: "flex", alignItems: "center", fontSize: "12px", color: "#ccc" }}>
                <span>Terminal - {projects.find(p => p.id === selectedProjectId)?.name}</span>
              </div>
              <TerminalView lines={activeTerminal.lines} />
            </div>

            {/* Bottom: Input */}
            <div
              style={{ height: "120px", background: "#252526", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
            >
              <textarea
                style={{ flex: 1, background: "#1e1e1e", color: "#fff", border: "1px solid #333", padding: "8px", fontFamily: "Consolas", fontSize: "13px", resize: "none", outline: "none" }}
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void runCommand();
                  }
                }}
                placeholder="输入命令或描述... (支持拖拽/粘贴文件)"
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="win10-btn primary" disabled={busy || !inputVal.trim()} onClick={() => void runCommand()}>
                  发送 (Enter)
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="win10-placeholder">
            <div>Select a project to start terminal session</div>
          </div>
        )}
      </main>

      {/* Add Project Modal */}
      {showProjectModal && (
        <div className="win10-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowProjectModal(false)}>
          <div className="win10-modal">
            <div className="win10-modal-header">
              <span className="win10-modal-title">添加 Git 项目</span>
              <button className="win10-icon-btn" onClick={() => setShowProjectModal(false)}>×</button>
            </div>
            <div className="win10-modal-body">
              <div className="win10-form-group">
                <label>仓库 URL</label>
                <input className="win10-input" value={projectUrl} onChange={e => setProjectUrl(e.target.value)} placeholder="https://github.com/..." autoFocus />
              </div>

              <div className="win10-form-group">
                <label>分支 / 克隆策略</label>
                <div className="win10-radio-group">
                  <label className="win10-radio">
                    <input type="radio" name="cloneMode" checked={cloneMode === "single"} onChange={() => setCloneMode("single")} />
                    <span>单分支</span>
                  </label>
                  <label className="win10-radio">
                    <input type="radio" name="cloneMode" checked={cloneMode === "all"} onChange={() => setCloneMode("all")} />
                    <span>全部分支</span>
                  </label>
                </div>
              </div>

              {cloneMode === "single" && (
                <div className="win10-form-group">
                  <label>分支名称 (可选)</label>
                  <input className="win10-input" value={projectBranch} onChange={(e) => setProjectBranch(e.target.value)} placeholder="main" />
                </div>
              )}

              <div className="win10-form-group">
                <label>Runner</label>
                <select className="win10-select" value={projectRunner} onChange={e => setProjectRunner(e.target.value as RunnerChoice)}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </div>
              <div className="win10-modal-footer">
                <button className="win10-btn" onClick={() => setShowProjectModal(false)}>取消</button>
                <button className="win10-btn primary" onClick={() => void handleAddProject()}>确定</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
