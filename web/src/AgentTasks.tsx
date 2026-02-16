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

function isOk<T>(res: ApiResponse<T>): res is ApiOk<T> {
  return Boolean(res && (res as ApiOk<T>).ok === true);
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json || typeof json !== "object") return { ok: false, code: "bad_json", message: "Bad JSON response" };
  return json;
}

function repoIdFromUrl(url: string, idx: number) {
  const raw = url.trim().replace(/\.git$/i, "");
  const m = raw.match(/([^/:]+)\/([^/]+)$/);
  const base = m ? `${m[1]}-${m[2]}` : `repo-${idx + 1}`;
  return base
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
}

export default function AgentTasks() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) || null, [tasks, selectedId]);

  const [prompt, setPrompt] = useState("");
  const [command, setCommand] = useState("codex");
  const [includeWorkspace, setIncludeWorkspace] = useState(true);
  const [repoUrls, setRepoUrls] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [logText, setLogText] = useState("");
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  const [diffRepoId, setDiffRepoId] = useState<string>("");
  const [diffText, setDiffText] = useState<string>("");
  const [stdinRepoId, setStdinRepoId] = useState<string>("");
  const [stdinText, setStdinText] = useState<string>("");

  async function refresh() {
    const res = await apiJson<{ tasks: TaskSummary[] }>("/api/agent/tasks");
    if (!isOk(res)) return;
    setTasks(res.tasks || []);
  }

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Reset streams when switching tasks
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setLogText("");
    lastSeqRef.current = 0;
    setDiffText("");
    setDiffRepoId("");
    setStdinRepoId("");
    setStdinText("");

    if (!selectedId) return;

    const es = new EventSource(`/api/agent/tasks/${encodeURIComponent(selectedId)}/events?since=0`);
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(String(msg.data || "{}")) as { seq?: number; type?: string; repoId?: string; stream?: string; text?: string };
        const seq = typeof ev.seq === "number" ? ev.seq : 0;
        if (seq && seq <= lastSeqRef.current) return;
        if (seq) lastSeqRef.current = seq;

        if (ev.type === "log") {
          const prefix = `[${ev.repoId || "task"}${ev.stream ? `/${ev.stream}` : ""}] `;
          const chunk = prefix + String(ev.text || "");
          setLogText((prev) => {
            const next = prev + chunk;
            const max = 200_000;
            return next.length > max ? next.slice(next.length - max) : next;
          });
        } else {
          // keep a small trail of non-log events in the log view
          const line = `[event] ${ev.type || "message"}\n`;
          setLogText((prev) => {
            const next = prev + line;
            const max = 200_000;
            return next.length > max ? next.slice(next.length - max) : next;
          });
        }

        void refresh();
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      // EventSource auto-retries; we de-dupe via seq.
    };

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function createTask() {
    setError("");
    setBusy(true);
    try {
      const urls = repoUrls
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const repos: Array<{ id: string; name: string; type: string; url?: string; path?: string }> = [];
      if (includeWorkspace) repos.push({ id: "workspace", name: "Workspace", type: "local" });
      urls.forEach((u, idx) => repos.push({ id: repoIdFromUrl(u, idx), name: u, type: "git", url: u }));

      const res = await apiJson<{ task: TaskSummary }>("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, command, repos })
      });
      if (!isOk(res)) return setError(res.message || "Failed to create task.");
      await refresh();
      setSelectedId(res.task.id);
    } catch {
      setError("Failed to create task.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedId)}/cancel`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function resumeSelected() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedId)}/resume`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function promoteSelected() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const res = await apiJson<{ results: Array<{ repoId: string; ok: boolean; prUrl?: string }> }>(
        `/api/agent/tasks/${encodeURIComponent(selectedId)}/promote`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
      );
      if (!isOk(res)) setError(res.message || "Promote failed.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff() {
    if (!selectedId || !diffRepoId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/agent/tasks/${encodeURIComponent(selectedId)}/repos/${encodeURIComponent(diffRepoId)}/diff`, { cache: "no-store" });
      if (!res.ok) {
        setError("Diff not ready.");
        setDiffText("");
        return;
      }
      const raw = await res.text();
      setDiffText(raw);
    } catch {
      setError("Failed to load diff.");
    } finally {
      setBusy(false);
    }
  }

  async function sendStdin() {
    if (!selectedId) return;
    const text = stdinText.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const payload = { text, repoId: stdinRepoId || undefined };
      const res = await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedId)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!isOk(res)) setError(res.message || "Failed to send input.");
      setStdinText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agent">
      <div className="agent-sidebar">
        <div className="agent-section">
          <div className="agent-title">New task</div>
          <label className="agent-label">
            Command
            <input className="agent-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="codex / claudecode / gemini / ..." />
          </label>
          <label className="agent-label">
            Prompt (sent to stdin)
            <textarea className="agent-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want the agent to do..." />
          </label>
          <label className="agent-row">
            <input type="checkbox" checked={includeWorkspace} onChange={(e) => setIncludeWorkspace(e.target.checked)} /> Include /workspace
          </label>
          <label className="agent-label">
            Extra repos (one git URL per line)
            <textarea className="agent-textarea" value={repoUrls} onChange={(e) => setRepoUrls(e.target.value)} placeholder="https://github.com/owner/repo.git" />
          </label>
          <button className="agent-btn" type="button" disabled={busy} onClick={() => void createTask()}>
            Start
          </button>
        </div>

        <div className="agent-section">
          <div className="agent-title">Tasks</div>
          <div className="agent-tasks">
            {tasks.map((t) => (
              <button
                key={t.id}
                className="agent-task"
                type="button"
                data-selected={t.id === selectedId ? "true" : undefined}
                onClick={() => setSelectedId(t.id)}
                title={t.id}
              >
                <div className="agent-task-title">{t.title || t.id}</div>
                <div className="agent-task-meta">
                  <span className="agent-pill">{t.status}</span>
                  <span className="agent-task-time">{new Date(t.createdAt).toLocaleString()}</span>
                </div>
              </button>
            ))}
            {!tasks.length ? <div className="agent-muted">No tasks yet.</div> : null}
          </div>
        </div>
      </div>

      <div className="agent-main">
        {error ? <div className="agent-error">{error}</div> : null}

        {selected ? (
          <>
            <div className="agent-toolbar">
              <div className="agent-toolbar-left">
                <div className="agent-selected-title">{selected.title}</div>
                <div className="agent-selected-sub">
                  <span className="agent-pill">{selected.status}</span>
                  <span className="agent-muted">cmd: {selected.command}</span>
                </div>
              </div>
              <div className="agent-toolbar-right">
                <button className="agent-btn" type="button" disabled={busy} onClick={() => void cancelSelected()}>
                  Cancel
                </button>
                <button className="agent-btn" type="button" disabled={busy} onClick={() => void resumeSelected()}>
                  Resume
                </button>
                <button className="agent-btn primary" type="button" disabled={busy} onClick={() => void promoteSelected()}>
                  Approve → Commit/PR
                </button>
              </div>
            </div>

            <div className="agent-grid">
              <div className="agent-panel">
                <div className="agent-panel-title">Repos</div>
                <div className="agent-repos">
                  {selected.repos.map((r) => (
                    <div key={r.id} className="agent-repo">
                      <div className="agent-repo-row">
                        <div className="agent-repo-name">{r.id}</div>
                        <span className="agent-pill">{r.status || "?"}</span>
                        {typeof r.exitCode === "number" ? <span className="agent-pill">exit {r.exitCode}</span> : null}
                      </div>
                      {r.prUrl ? (
                        <a className="agent-link" href={r.prUrl} target="_blank" rel="noreferrer">
                          PR: {r.prUrl}
                        </a>
                      ) : null}
                      {r.url ? <div className="agent-muted">{r.url}</div> : null}
                      {r.path ? <div className="agent-muted">{r.path}</div> : null}
                    </div>
                  ))}
                </div>

                <div className="agent-panel-title">Send input</div>
                <div className="agent-stdin">
                  <select className="agent-input" value={stdinRepoId} onChange={(e) => setStdinRepoId(e.target.value)}>
                    <option value="">All running repos</option>
                    {selected.repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                  </select>
                  <div className="agent-row">
                    <input className="agent-input" value={stdinText} onChange={(e) => setStdinText(e.target.value)} placeholder="Type a reply (sent with newline)..." />
                    <button className="agent-btn" type="button" disabled={busy} onClick={() => void sendStdin()}>
                      Send
                    </button>
                  </div>
                </div>

                <div className="agent-panel-title">Diff</div>
                <div className="agent-row">
                  <select className="agent-input" value={diffRepoId} onChange={(e) => setDiffRepoId(e.target.value)}>
                    <option value="">Select repo…</option>
                    {selected.repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                  </select>
                  <button className="agent-btn" type="button" disabled={busy || !diffRepoId} onClick={() => void loadDiff()}>
                    Load diff
                  </button>
                </div>
              </div>

              <div className="agent-panel">
                <div className="agent-panel-title">Logs (tail)</div>
                <pre className="agent-logs">{logText || "No logs yet."}</pre>
              </div>

              <div className="agent-panel">
                <div className="agent-panel-title">Diff</div>
                <pre className="agent-diff">{diffText || "Select a repo and click “Load diff”."}</pre>
              </div>
            </div>
          </>
        ) : (
          <div className="agent-empty">Select a task to view logs and approve changes.</div>
        )}
      </div>
    </div>
  );
}
