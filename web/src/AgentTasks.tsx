import React, { useEffect, useMemo, useRef, useState } from "react";

type RepoSummary = {
  id: string;
  name: string;
  type: string;
  url?: string;
  path?: string;
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
type FlowState = "pending" | "active" | "done" | "error";
type TimelineLevel = "info" | "success" | "warn" | "error";
type TimelinePhase = "create" | "prepare" | "run" | "diff" | "promote" | "other";

type TaskEvent = {
  seq?: number;
  type?: string;
  repoId?: string;
  status?: string;
  stream?: string;
  text?: string;
  code?: number | null;
  message?: string;
  bytes?: number;
};

type TimelineEntry = {
  seq: number;
  at: number;
  type: string;
  repoId?: string;
  status?: string;
  level: TimelineLevel;
  text: string;
  tool: string;
  phase: TimelinePhase;
  detail?: string;
};

type TimelinePhaseGroup = {
  id: TimelinePhase;
  label: string;
  entries: TimelineEntry[];
  failed: number;
  tools: string[];
  level: TimelineLevel;
};

const RUNNER_COMMAND: Record<RunnerChoice, string> = { codex: "codex exec --full-auto", claude: "claudecode" };
const HISTORY_KEY = "hfide.agent.repo-history.v1";
const HISTORY_LIMIT = 12;
const PHASE_ORDER: TimelinePhase[] = ["create", "prepare", "run", "diff", "promote", "other"];
const PHASE_LABEL: Record<TimelinePhase, string> = {
  create: "Create",
  prepare: "Prepare",
  run: "Run",
  diff: "Diff",
  promote: "Promote",
  other: "Other"
};
const DEFAULT_PHASE_COLLAPSE: Record<TimelinePhase, boolean> = {
  create: true,
  prepare: true,
  run: false,
  diff: false,
  promote: false,
  other: true
};

function levelWeight(level: TimelineLevel) {
  const rank: Record<TimelineLevel, number> = { info: 0, success: 1, warn: 2, error: 3 };
  return rank[level];
}

function timelinePhaseForEvent(ev: TaskEvent): TimelinePhase {
  const type = String(ev.type || "event");
  const status = String(ev.status || "").toLowerCase();
  if (type === "task_created") return "create";
  if (type === "repo_status" && ["clone", "fetch_all", "worktree_create", "ready"].includes(status)) return "prepare";
  if (type === "repo_status" || type === "task_status" || type === "log" || type === "repo_exit" || type === "stdin") return "run";
  if (type === "diff_ready" || type === "diff_error") return "diff";
  if (type === "promote_status" || type === "promote_error" || type === "pr_created" || type === "promote_skip") return "promote";
  return "other";
}

function timelineToolForEvent(ev: TaskEvent) {
  const type = String(ev.type || "event");
  const status = String(ev.status || "").toLowerCase();
  if (type === "repo_status") {
    const toolMap: Record<string, string> = {
      clone: "git.clone",
      fetch_all: "git.fetch",
      worktree_create: "git.worktree",
      ready: "repo.ready"
    };
    return toolMap[status] || `repo.${status || "status"}`;
  }
  if (type === "task_created") return "task.create";
  if (type === "task_status") return "task.status";
  if (type === "log") {
    const stream = String(ev.stream || "stdout").toLowerCase();
    return stream === "stderr" ? "runner.stderr" : "runner.stdout";
  }
  if (type === "repo_exit") return "runner.exit";
  if (type === "stdin") return "runner.stdin";
  if (type === "diff_ready" || type === "diff_error") return "git.diff";
  if (type === "promote_status") {
    if (status === "push") return "git.push";
    if (status === "create_pr") return "github.pr.create";
    return `promote.${status || "status"}`;
  }
  if (type === "promote_error") return "promote.error";
  if (type === "pr_created") return "github.pr";
  if (type.endsWith("_error")) return "runner.error";
  return type.replace(/_/g, ".");
}

function timelineDetailForEvent(ev: TaskEvent): string | undefined {
  if (typeof ev.message === "string" && ev.message.trim()) return ev.message.trim();
  if (typeof ev.text === "string" && ev.text.trim()) {
    const text = ev.text.trim();
    return text.length > 2400 ? `${text.slice(0, 2400)}\n...` : text;
  }
  if (typeof ev.code === "number") return `exit code: ${ev.code}`;
  if (typeof ev.status === "string" && ev.status.trim()) return `status: ${ev.status.trim()}`;
  return undefined;
}

function phaseProgressForState(state: FlowState, entryCount: number) {
  if (state === "done") return 100;
  if (state === "error") return 100;
  if (state === "active") return entryCount > 8 ? 78 : 62;
  return entryCount > 0 ? 24 : 8;
}

function phaseFromFlowId(id: string): TimelinePhase | null {
  const map: Record<string, TimelinePhase> = {
    created: "create",
    prepare: "prepare",
    run: "run",
    diff: "diff",
    promote: "promote"
  };
  return map[id] || null;
}

function IconWindows(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M2 3h9v9H2V3Zm11 0h9v9h-9V3ZM2 14h9v7H2v-7Zm11 0h9v7h-9v-7Z" />
    </svg>
  );
}

function IconClose(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function IconResume(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m7 5 12 7-12 7V5Z" />
    </svg>
  );
}

function IconApprove(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

function isOk<T>(res: ApiResponse<T>): res is ApiOk<T> {
  return Boolean(res && (res as ApiOk<T>).ok === true);
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json || typeof json !== "object") return { ok: false, code: "bad_json", message: "Bad JSON response" };
  return json;
}

function repoIdFromUrl(url: string) {
  const raw = url.trim().replace(/\.git$/i, "");
  const m = raw.match(/([^/:]+)\/([^/]+)$/);
  const base = m ? `${m[1]}-${m[2]}` : "repo";
  return base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "repo";
}

function statusLabel(status?: string) {
  const s = String(status || "unknown").toLowerCase();
  const map: Record<string, string> = {
    queued: "queued",
    pending: "pending",
    preparing: "preparing",
    running: "running",
    ready: "ready",
    done: "done",
    canceled: "canceled",
    error: "error",
    clone: "clone",
    fetch_all: "fetch all",
    worktree_create: "worktree",
    create_pr: "create PR"
  };
  return map[s] || s;
}

function fmtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [] as string[];
    return arr.map((x) => String(x || "").trim()).filter(Boolean).slice(0, HISTORY_LIMIT);
  } catch {
    return [] as string[];
  }
}

function saveHistory(items: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
}

function eventSummary(ev: TaskEvent): { level: TimelineLevel; text: string } {
  const type = String(ev.type || "event");
  const repoPrefix = ev.repoId ? `${ev.repoId} · ` : "";
  if (type === "repo_error" || type === "task_error" || type === "promote_error" || type === "diff_error") return { level: "error", text: `${repoPrefix}${type}: ${ev.message || "failed"}` };
  if (type === "repo_exit") return { level: typeof ev.code === "number" && ev.code === 0 ? "success" : "warn", text: `${repoPrefix}exit ${typeof ev.code === "number" ? ev.code : "?"}` };
  if (type === "task_created" || type === "pr_created" || type === "diff_ready") return { level: "success", text: `${repoPrefix}${type}` };
  if (type === "repo_status" || type === "task_status") return { level: "info", text: `${repoPrefix}${statusLabel(ev.status)}` };
  if (type === "log") {
    const preview = String(ev.text || "").replace(/\s+/g, " ").trim().slice(0, 90);
    return { level: "info", text: `${repoPrefix}${ev.stream || "stdout"}: ${preview || "(empty)"}` };
  }
  return { level: "info", text: `${repoPrefix}${type}` };
}

export default function AgentTasks() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) || null, [tasks, selectedId]);

  const [runner, setRunner] = useState<RunnerChoice>("codex");
  const [repoUrl, setRepoUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [repoHistory, setRepoHistory] = useState<string[]>([]);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logText, setLogText] = useState("");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [collapsedPhases, setCollapsedPhases] = useState<Record<TimelinePhase, boolean>>(() => ({ ...DEFAULT_PHASE_COLLAPSE }));
  const [expandedTimelineRows, setExpandedTimelineRows] = useState<Record<string, boolean>>({});
  const [diffRepoId, setDiffRepoId] = useState("");
  const [diffText, setDiffText] = useState("");

  const [stdinRepoId, setStdinRepoId] = useState("");
  const [stdinText, setStdinText] = useState("");
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const repoInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    const res = await apiJson<{ tasks: TaskSummary[] }>("/api/agent/tasks");
    if (!isOk(res)) return;
    setTasks(res.tasks || []);
  }

  function openCreateModal(initialRepo = "") {
    if (initialRepo) setRepoUrl(initialRepo);
    setError("");
    setShowCreateModal(true);
    window.setTimeout(() => repoInputRef.current?.focus(), 0);
  }

  useEffect(() => {
    void refresh();
    setRepoHistory(loadHistory());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tasks.length && !selectedId) setSelectedId(tasks[0].id);
  }, [tasks, selectedId]);

  useEffect(() => {
    const onCreate = () => openCreateModal();
    window.addEventListener("hfide:agent-new-task", onCreate as EventListener);
    return () => window.removeEventListener("hfide:agent-new-task", onCreate as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showCreateModal) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setShowCreateModal(false);
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [showCreateModal]);

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setLogText("");
    setTimeline([]);
    setExpandedTimelineRows({});
    setDiffRepoId("");
    setDiffText("");
    setStdinRepoId("");
    setStdinText("");
    lastSeqRef.current = 0;

    if (!selectedId) return;
    const es = new EventSource(`/api/agent/tasks/${encodeURIComponent(selectedId)}/events?since=0`);
    esRef.current = es;
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(String(msg.data || "{}")) as TaskEvent;
        const seq = typeof ev.seq === "number" ? ev.seq : 0;
        if (seq && seq <= lastSeqRef.current) return;
        const nextSeq = seq || lastSeqRef.current + 1;
        lastSeqRef.current = nextSeq;

        if (ev.type === "log") {
          const prefix = `[${ev.repoId || "task"}${ev.stream ? `/${ev.stream}` : ""}] `;
          setLogText((p) => (p + prefix + String(ev.text || "")).slice(-220_000));
        } else {
          setLogText((p) => (p + `[event] ${String(ev.type || "event")}\n`).slice(-220_000));
        }

        const sum = eventSummary(ev);
        const tool = timelineToolForEvent(ev);
        const phase = timelinePhaseForEvent(ev);
        const detail = timelineDetailForEvent(ev);
        setTimeline((p) => {
          const next = [...p, { seq: nextSeq, at: Date.now(), type: String(ev.type || "event"), repoId: ev.repoId, status: ev.status, level: sum.level, text: sum.text, tool, phase, detail }];
          return next.slice(-280);
        });
        void refresh();
      } catch {
        // ignore
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function createTask() {
    const url = repoUrl.trim();
    if (!url) return setError("Repository URL is required.");
    setBusy(true);
    setError("");
    try {
      const res = await apiJson<{ task: TaskSummary }>("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          command: RUNNER_COMMAND[runner],
          repos: [{ id: repoIdFromUrl(url), name: url, type: "git", url }]
        })
      });
      if (!isOk(res)) return setError(res.message || "Failed to create task.");

      const history = [url, ...repoHistory.filter((x) => x.toLowerCase() !== url.toLowerCase())].slice(0, HISTORY_LIMIT);
      setRepoHistory(history);
      saveHistory(history);

      await refresh();
      setSelectedId(res.task.id);
      setPrompt("");
      setShowCreateModal(false);
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
    try {
      await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedId)}/promote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
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
        setError("Diff is not ready.");
        setDiffText("");
        return;
      }
      setDiffText(await res.text());
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
    try {
      const res = await apiJson(`/api/agent/tasks/${encodeURIComponent(selectedId)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, repoId: stdinRepoId || undefined })
      });
      if (!isOk(res)) setError(res.message || "Failed to send input.");
      setStdinText("");
    } finally {
      setBusy(false);
    }
  }

  const timelineView = useMemo(() => timeline.slice().reverse().slice(0, 160), [timeline]);
  const timelineSections = useMemo(() => {
    const groups = new Map<TimelinePhase, TimelinePhaseGroup>();
    for (const phase of PHASE_ORDER) {
      groups.set(phase, {
        id: phase,
        label: PHASE_LABEL[phase],
        entries: [],
        failed: 0,
        tools: [],
        level: "info"
      });
    }
    for (const entry of timelineView) {
      const group = groups.get(entry.phase);
      if (!group) continue;
      group.entries.push(entry);
      if (entry.level === "error") group.failed += 1;
      if (!group.tools.includes(entry.tool)) group.tools.push(entry.tool);
      if (levelWeight(entry.level) > levelWeight(group.level)) group.level = entry.level;
    }
    return PHASE_ORDER.map((phase) => groups.get(phase)).filter((group): group is TimelinePhaseGroup => Boolean(group && group.entries.length));
  }, [timelineView]);
  const diffReadyRepos = useMemo(() => new Set(timeline.filter((e) => e.type === "diff_ready").map((e) => e.repoId).filter(Boolean) as string[]), [timeline]);
  const promoteErrorRepos = useMemo(() => new Set(timeline.filter((e) => e.type === "promote_error").map((e) => e.repoId).filter(Boolean) as string[]), [timeline]);

  const togglePhaseCollapse = (phase: TimelinePhase) => {
    setCollapsedPhases((p) => ({ ...p, [phase]: !p[phase] }));
  };

  const toggleTimelineRow = (rowKey: string) => {
    setExpandedTimelineRows((p) => ({ ...p, [rowKey]: !p[rowKey] }));
  };

  const flow = useMemo(() => {
    if (!selected) return [] as Array<{ id: string; label: string; state: FlowState }>;
    const s = String(selected.status || "").toLowerCase();
    const reposFinished = selected.repos.length > 0 && selected.repos.every((r) => ["done", "error", "canceled"].includes(String(r.status || "").toLowerCase()));
    const hasErrors = selected.repos.some((r) => String(r.status || "").toLowerCase() === "error") || timeline.some((t) => t.level === "error");
    const diffDone = !!diffText || timeline.some((t) => t.type === "diff_ready");
    const prDone = selected.repos.some((r) => !!r.prUrl) || timeline.some((t) => t.type === "pr_created");
    return [
      { id: "created", label: "Create", state: "done" as FlowState },
      { id: "prepare", label: "Prepare", state: hasErrors ? "error" : reposFinished || s === "running" ? "done" : "active" },
      { id: "run", label: "Run", state: hasErrors ? "error" : reposFinished ? "done" : s === "running" ? "active" : "pending" },
      { id: "diff", label: "Diff", state: hasErrors ? "error" : diffDone ? "done" : reposFinished ? "active" : "pending" },
      { id: "promote", label: "Promote", state: promoteErrorRepos.size ? "error" : prDone ? "done" : timeline.some((t) => t.type === "promote_status") ? "active" : "pending" }
    ];
  }, [selected, timeline, diffText, promoteErrorRepos]);

  const phaseStateMap = useMemo(() => {
    const states: Record<TimelinePhase, FlowState> = {
      create: "pending",
      prepare: "pending",
      run: "pending",
      diff: "pending",
      promote: "pending",
      other: "pending"
    };
    for (const step of flow) {
      const phase = phaseFromFlowId(step.id);
      if (!phase) continue;
      states[phase] = step.state as FlowState;
    }
    if (timeline.some((entry) => entry.phase === "other")) states.other = "active";
    return states;
  }, [flow, timeline]);

  const metrics = useMemo(() => {
    if (!selected) return { duration: "-", failedPoints: 0, artifacts: 0, runningRepos: 0 };
    const running = ["queued", "pending", "running", "preparing"].includes(String(selected.status || "").toLowerCase());
    const end = running ? Date.now() : Math.max(selected.updatedAt || 0, selected.createdAt || 0);
    return {
      duration: fmtDuration(Math.max(0, end - (selected.createdAt || end))),
      failedPoints: timeline.filter((e) => e.level === "error").length + selected.repos.filter((r) => String(r.status || "").toLowerCase() === "error").length,
      artifacts: selected.repos.filter((r) => !!r.prUrl).length + diffReadyRepos.size,
      runningRepos: selected.repos.filter((r) => String(r.status || "").toLowerCase() === "running").length
    };
  }, [selected, timeline, diffReadyRepos]);

  const repoTimelineMetrics = useMemo(() => {
    const metric = new Map<string, { firstAt: number; lastAt: number; events: number; errors: number }>();
    for (const event of timeline) {
      if (!event.repoId) continue;
      const current = metric.get(event.repoId);
      if (!current) {
        metric.set(event.repoId, {
          firstAt: event.at,
          lastAt: event.at,
          events: 1,
          errors: event.level === "error" ? 1 : 0
        });
        continue;
      }
      current.firstAt = Math.min(current.firstAt, event.at);
      current.lastAt = Math.max(current.lastAt, event.at);
      current.events += 1;
      if (event.level === "error") current.errors += 1;
    }
    return metric;
  }, [timeline]);

  return (
    <div className="agent">
      <div className="agent-sidebar">
        <div className="agent-section">
          <div className="agent-header-row">
            <div className="agent-title agent-vibe-brand"><IconWindows className="agent-vibe-logo-svg" />Coding Tasks</div>
            <button className="agent-btn primary" type="button" disabled={busy} onClick={() => openCreateModal()}>
              <span className="agent-btn-icon" aria-hidden="true">+</span>
              <span>New</span>
            </button>
          </div>
          <div className="agent-create-hint">
            <div className="agent-create-title">Task Command Center</div>
            <div className="agent-muted">Unified entry: taskbar + Agent and this button open the same create modal.</div>
          </div>
          {!!repoHistory.length ? (
            <>
              <div className="agent-label">Recent repositories</div>
              <div className="agent-history-chips">
                {repoHistory.slice(0, 6).map((url) => (
                  <button key={url} className="agent-history-chip" type="button" title={url} onClick={() => openCreateModal(url)}>
                    {url}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <div className="agent-section">
          <div className="agent-title">Recent Runs</div>
          <div className="agent-tasks">
            {tasks.map((t) => (
              <button key={t.id} className="agent-task" type="button" data-selected={t.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(t.id)} title={t.id}>
                <div className="agent-task-title">{t.title || t.id}</div>
                <div className="agent-task-meta">
                  <span className="agent-pill">{statusLabel(t.status)}</span>
                  <span className="agent-task-time">{new Date(t.createdAt).toLocaleString()}</span>
                </div>
              </button>
            ))}
            {!tasks.length ? <div className="agent-muted">No tasks yet.</div> : null}
          </div>
        </div>
      </div>

      <div className="agent-main">
        <div className="agent-main-topbar">
          <div className="agent-main-top-title">Workspace Console</div>
          <div className="agent-main-top-actions" aria-hidden="true">
            <span className="agent-main-dot" />
            <span className="agent-main-dot" />
            <span className="agent-main-dot" />
          </div>
        </div>
        {error ? <div className="agent-error">{error}</div> : null}
        {selected ? (
          <>
            <div className="agent-toolbar">
              <div className="agent-toolbar-left">
                <div className="agent-selected-title">{selected.title}</div>
                <div className="agent-selected-sub">
                  <span className="agent-pill">{statusLabel(selected.status)}</span>
                  <span className="agent-muted">Runner: {selected.command.includes("claude") ? "claude" : "codex"}</span>
                  <span className="agent-muted">Repos: {selected.repos.length}</span>
                </div>
              </div>
              <div className="agent-toolbar-right">
                <button className="agent-btn" type="button" disabled={busy} onClick={() => void cancelSelected()}>
                  <IconClose className="agent-btn-svg" />
                  <span>Cancel</span>
                </button>
                <button className="agent-btn" type="button" disabled={busy} onClick={() => void resumeSelected()}>
                  <IconResume className="agent-btn-svg" />
                  <span>Resume</span>
                </button>
                <button className="agent-btn primary" type="button" disabled={busy} onClick={() => void promoteSelected()}>
                  <IconApprove className="agent-btn-svg" />
                  <span>Approve</span>
                </button>
              </div>
            </div>

            <div className="agent-metrics-grid">
              <div className="agent-metric-card"><div className="agent-metric-label">Duration</div><div className="agent-metric-value">{metrics.duration}</div></div>
              <div className="agent-metric-card"><div className="agent-metric-label">Failed points</div><div className="agent-metric-value">{metrics.failedPoints}</div></div>
              <div className="agent-metric-card"><div className="agent-metric-label">Artifacts</div><div className="agent-metric-value">{metrics.artifacts}</div></div>
              <div className="agent-metric-card"><div className="agent-metric-label">Running repos</div><div className="agent-metric-value">{metrics.runningRepos}</div></div>
            </div>

            <div className="agent-grid">
              <div className="agent-panel agent-panel-flow">
                <div className="agent-panel-title">Flow</div>
                <div className="agent-flow">
                  {flow.map((f) => (
                    <div key={f.id} className="agent-flow-step" data-state={f.state}><span className="agent-flow-dot" />{f.label}</div>
                  ))}
                </div>

                <div className="agent-panel-title">Repo Parallel Lanes</div>
                <div className="agent-lanes">
                  {selected.repos.map((r) => {
                    const rs = String(r.status || "").toLowerCase();
                    const hasDiff = diffReadyRepos.has(r.id);
                    const hasPr = !!r.prUrl;
                    const laneMetric = repoTimelineMetrics.get(r.id);
                    const laneDuration = laneMetric ? fmtDuration(Math.max(0, laneMetric.lastAt - laneMetric.firstAt)) : "-";
                    const step = (name: string, state: FlowState) => <span className="agent-lane-step" data-state={state}>{name}</span>;
                    const prepare: FlowState = rs === "error" ? "error" : ["running", "done", "canceled"].includes(rs) ? "done" : "active";
                    const run: FlowState = rs === "error" ? "error" : rs === "running" ? "active" : ["done", "canceled"].includes(rs) ? "done" : "pending";
                    const diff: FlowState = rs === "error" ? "error" : hasDiff ? "done" : run === "done" ? "active" : "pending";
                    const promote: FlowState = promoteErrorRepos.has(r.id) ? "error" : hasPr ? "done" : "pending";
                    return (
                      <div key={r.id} className="agent-lane-card">
                        <div className="agent-lane-head"><div className="agent-repo-name">{r.id}</div><span className="agent-pill">{statusLabel(r.status)}</span>{typeof r.exitCode === "number" ? <span className="agent-pill">exit {r.exitCode}</span> : null}</div>
                        <div className="agent-lane-metrics">
                          <span className="agent-pill">elapsed {laneDuration}</span>
                          <span className="agent-pill">events {laneMetric?.events || 0}</span>
                          {laneMetric?.errors ? <span className="agent-pill" data-tone="danger">errors {laneMetric.errors}</span> : null}
                        </div>
                        <div className="agent-lane-track">{step("Prepare", prepare)}{step("Run", run)}{step("Diff", diff)}{step("Promote", promote)}</div>
                        {r.prUrl ? <a className="agent-link" href={r.prUrl} target="_blank" rel="noreferrer">Artifact: PR</a> : null}
                        {r.url ? <div className="agent-muted">{r.url}</div> : null}
                      </div>
                    );
                  })}
                </div>

                <div className="agent-panel-title">Input</div>
                <div className="agent-stdin">
                  <select className="agent-input" value={stdinRepoId} onChange={(e) => setStdinRepoId(e.target.value)}>
                    <option value="">All running repos</option>
                    {selected.repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
                  </select>
                  <div className="agent-row">
                    <input className="agent-input" value={stdinText} onChange={(e) => setStdinText(e.target.value)} placeholder="Type and send..." />
                    <button className="agent-btn" type="button" disabled={busy} onClick={() => void sendStdin()}>Send</button>
                  </div>
                </div>
              </div>

              <div className="agent-panel agent-panel-split agent-panel-timeline">
                <div className="agent-panel-title agent-panel-title-row">
                  <span>Timeline</span>
                  <span className="agent-panel-meta">events {timeline.length} | failed {metrics.failedPoints}</span>
                </div>
                <div className="agent-timeline">
                  {timelineSections.length ? timelineSections.map((section) => {
                    const isCollapsed = Boolean(collapsedPhases[section.id]);
                    const phaseState = phaseStateMap[section.id] || "pending";
                    const phaseProgress = phaseProgressForState(phaseState, section.entries.length);
                    return (
                      <div key={section.id} className="agent-phase" data-level={section.level}>
                        <button className="agent-phase-header" type="button" onClick={() => togglePhaseCollapse(section.id)}>
                          <span className="agent-phase-caret" aria-hidden="true">{isCollapsed ? ">" : "v"}</span>
                          <span className="agent-phase-state" data-state={phaseState} />
                          <span className="agent-phase-title">{section.label}</span>
                          <span className="agent-phase-progress" aria-hidden="true">
                            <span className="agent-phase-progress-fill" data-state={phaseState} style={{ width: `${phaseProgress}%` }} />
                          </span>
                          <span className="agent-phase-meta">{section.entries.length} events</span>
                          {section.failed ? <span className="agent-phase-failed">failed {section.failed}</span> : null}
                          {section.tools.length ? <span className="agent-phase-tools">{section.tools.slice(0, 3).join(" | ")}</span> : null}
                        </button>
                        {!isCollapsed ? (
                          <div className="agent-phase-body">
                            {section.entries.map((entry) => {
                              const rowKey = `${entry.seq}-${entry.repoId || "task"}`;
                              const hasDetail = Boolean(entry.detail);
                              const detailText = entry.detail || "";
                              const isLongDetail = detailText.length > 220;
                              const shouldToggle = hasDetail && (entry.level === "error" || isLongDetail);
                              const expanded = Boolean(expandedTimelineRows[rowKey]);
                              const preview = expanded || !isLongDetail ? detailText : `${detailText.slice(0, 220)}...`;
                              return (
                                <div key={`${section.id}-${entry.seq}-${entry.at}`} className="agent-event" data-level={entry.level}>
                                  <div className="agent-event-dot" />
                                  <div className="agent-event-main">
                                    <div className="agent-event-top"><span className="agent-event-text">{entry.text}</span><span className="agent-event-time">{new Date(entry.at).toLocaleTimeString()}</span></div>
                                    <div className="agent-event-meta-row">
                                      <span className="agent-tool-chip" data-level={entry.level}>{entry.tool}</span>
                                      {entry.repoId ? <span className="agent-muted">repo: {entry.repoId}</span> : null}
                                    </div>
                                    {hasDetail ? <div className="agent-event-detail">{preview}</div> : null}
                                    {shouldToggle ? (
                                      <button className="agent-event-toggle" type="button" onClick={() => toggleTimelineRow(rowKey)}>
                                        {expanded ? "Collapse details" : "Expand details"}
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : <div className="agent-empty-inline">No events yet.</div>}
                </div>
                <div className="agent-panel-title">Logs</div>
                <pre className="agent-logs">{logText || "No logs yet."}</pre>
              </div>

              <div className="agent-panel agent-panel-artifacts">
                <div className="agent-panel-title">Artifacts / Diff</div>
                <div className="agent-repos">
                  <div className="agent-row agent-inline-actions">
                    <select className="agent-input" value={diffRepoId} onChange={(e) => setDiffRepoId(e.target.value)}>
                      <option value="">Select repo...</option>
                      {selected.repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
                    </select>
                    <button className="agent-btn" type="button" disabled={busy || !diffRepoId} onClick={() => void loadDiff()}>Load Diff</button>
                  </div>
                  <div className="agent-artifacts-list">
                    {selected.repos.filter((r) => !!r.prUrl).map((r) => <a key={`${r.id}-${r.prUrl || ""}`} className="agent-link" href={r.prUrl || "#"} target="_blank" rel="noreferrer">{r.id}: PR</a>)}
                    {!selected.repos.some((r) => !!r.prUrl) ? <div className="agent-muted">No PR artifact yet.</div> : null}
                  </div>
                </div>
                <pre className="agent-diff">{diffText || "Select a repo and click Load Diff."}</pre>
              </div>
            </div>
          </>
        ) : <div className="agent-empty agent-empty-card">Select a task to view flow, timeline and repo lanes.</div>}
      </div>

      {showCreateModal ? (
        <div className="agent-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowCreateModal(false)}>
          <form className="agent-modal" onSubmit={(e) => { e.preventDefault(); void createTask(); }}>
            <div className="agent-modal-header">
              <div><div className="agent-modal-title">Create Agent Task</div><div className="agent-muted">Required: Runner + Repository URL</div></div>
              <button className="agent-btn" type="button" onClick={() => setShowCreateModal(false)}>Close</button>
            </div>
            <div className="agent-modal-body">
              <label className="agent-label">Runner<select className="agent-input" value={runner} onChange={(e) => setRunner(e.target.value as RunnerChoice)}><option value="codex">codex</option><option value="claude">claude</option></select></label>
              <label className="agent-label">Repository URL<input ref={repoInputRef} className="agent-input" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" required /></label>
              <label className="agent-label">Prompt (optional)<textarea className="agent-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what to do..." /></label>
              <div className="agent-label">Local history</div>
              <div className="agent-history-grid">
                {repoHistory.length ? repoHistory.map((url) => <button key={url} className="agent-history-chip" type="button" title={url} onClick={() => setRepoUrl(url)}>{url}</button>) : <div className="agent-muted">No history yet.</div>}
              </div>
            </div>
            <div className="agent-modal-footer">
              <button className="agent-btn" type="button" disabled={!repoHistory.length || busy} onClick={() => { setRepoHistory([]); saveHistory([]); }}>Clear history</button>
              <div className="agent-row"><button className="agent-btn" type="button" disabled={busy} onClick={() => setShowCreateModal(false)}>Cancel</button><button className="agent-btn primary" type="submit" disabled={busy}>Start Task</button></div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

