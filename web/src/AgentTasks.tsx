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

type LogEntry = {
  seq: number;
  at: number;
  kind: "log" | "event";
  repoId?: string;
  stream?: string;
  text: string;
};

type ToastTone = "info" | "success" | "error";

type ToastItem = {
  id: string;
  tone: ToastTone;
  title: string;
  message: string;
  taskId?: string;
  createdAt: number;
};

type TimelinePhaseGroup = {
  id: TimelinePhase;
  label: string;
  entries: TimelineEntry[];
  failed: number;
  tools: string[];
  level: TimelineLevel;
  firstAt: number;
  lastAt: number;
  durationMs: number;
};

const RUNNER_COMMAND: Record<RunnerChoice, string> = { codex: "codex exec --full-auto", claude: "claudecode" };
const HISTORY_KEY = "hfide.agent.repo-history.v1";
const SELECTED_TASK_KEY = "hfide.agent.selected-task.v1";
const LAST_SEEN_TASKS_KEY = "hfide.agent.task-last-seen.v1";
const UI_PREFS_KEY = "hfide.agent.ui-prefs.v1";
const HISTORY_LIMIT = 12;
const ACTIVE_TASK_STATUSES = new Set(["queued", "pending", "preparing", "running"]);
const LOG_MAX_ENTRIES = 1600;
const LOG_MAX_CHARS = 220_000;
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

function trimLogEntries(entries: LogEntry[]) {
  let out = entries;
  if (out.length > LOG_MAX_ENTRIES) out = out.slice(out.length - LOG_MAX_ENTRIES);

  let total = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    total += out[i].text.length + 32;
    if (total > LOG_MAX_CHARS) {
      out = out.slice(i + 1);
      break;
    }
  }
  return out;
}

type DiffFile = {
  id: string;
  aPath: string;
  bPath: string;
  additions: number;
  deletions: number;
  text: string;
};

type DiffLineTone = "meta" | "hunk" | "add" | "del" | "ctx";

function parseUnifiedDiff(raw: string): DiffFile[] {
  const text = String(raw || "");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const files: DiffFile[] = [];

  let cur: DiffFile | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!cur) return;
    cur.text = buf.join("\n");
    files.push(cur);
    cur = null;
    buf = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git a/")) {
      flush();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const aPath = m ? m[1] : "";
      const bPath = m ? m[2] : "";
      const id = bPath || aPath || `file${files.length + 1}`;
      cur = { id, aPath, bPath, additions: 0, deletions: 0, text: "" };
      buf.push(line);
      continue;
    }

    if (!cur) continue;
    buf.push(line);
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) cur.additions += 1;
    if (line.startsWith("-")) cur.deletions += 1;
  }

  flush();
  return files;
}

function diffToneForLine(line: string): DiffLineTone {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) return "meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("rename from ") || line.startsWith("rename to ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "ctx";
}

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

function isTaskActive(status?: string) {
  return ACTIVE_TASK_STATUSES.has(String(status || "").toLowerCase());
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

function loadLastSeenTasks() {
  try {
    const raw = localStorage.getItem(LAST_SEEN_TASKS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {} as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num <= 0) continue;
      out[String(k)] = num;
    }
    return out;
  } catch {
    return {} as Record<string, number>;
  }
}

function saveLastSeenTasks(map: Record<string, number>) {
  localStorage.setItem(LAST_SEEN_TASKS_KEY, JSON.stringify(map));
}

type UiPrefs = {
  taskQuery?: string;
  taskFilter?: "all" | "active" | "failed" | "done" | "canceled" | "unread";
  logsFollow?: boolean;
  logsIncludeEvents?: boolean;
  logsStream?: "all" | "stdout" | "stderr";
  logsRepo?: string;
  logsQuery?: string;
  timelineErrorsOnly?: boolean;
  timelineCurrentPhaseOnly?: boolean;
  timelineTool?: string;
  timelineRepo?: string;
  timelineQuery?: string;
  collapsedPhases?: Partial<Record<TimelinePhase, boolean>>;
  diffPretty?: boolean;
};

function loadUiPrefs(): UiPrefs {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const rec = parsed as Record<string, unknown>;

    const out: UiPrefs = {};
    if (typeof rec.taskQuery === "string") out.taskQuery = rec.taskQuery;
    if (rec.taskFilter === "all" || rec.taskFilter === "active" || rec.taskFilter === "failed" || rec.taskFilter === "done" || rec.taskFilter === "canceled" || rec.taskFilter === "unread") {
      out.taskFilter = rec.taskFilter;
    }
    if (typeof rec.logsFollow === "boolean") out.logsFollow = rec.logsFollow;
    if (typeof rec.logsIncludeEvents === "boolean") out.logsIncludeEvents = rec.logsIncludeEvents;
    if (rec.logsStream === "all" || rec.logsStream === "stdout" || rec.logsStream === "stderr") out.logsStream = rec.logsStream;
    if (typeof rec.logsRepo === "string") out.logsRepo = rec.logsRepo;
    if (typeof rec.logsQuery === "string") out.logsQuery = rec.logsQuery;
    if (typeof rec.timelineErrorsOnly === "boolean") out.timelineErrorsOnly = rec.timelineErrorsOnly;
    if (typeof rec.timelineCurrentPhaseOnly === "boolean") out.timelineCurrentPhaseOnly = rec.timelineCurrentPhaseOnly;
    if (typeof rec.timelineTool === "string") out.timelineTool = rec.timelineTool;
    if (typeof rec.timelineRepo === "string") out.timelineRepo = rec.timelineRepo;
    if (typeof rec.timelineQuery === "string") out.timelineQuery = rec.timelineQuery;
    if (typeof rec.diffPretty === "boolean") out.diffPretty = rec.diffPretty;

    const collapsedRaw = rec.collapsedPhases;
    if (collapsedRaw && typeof collapsedRaw === "object") {
      const collapsed: Partial<Record<TimelinePhase, boolean>> = {};
      for (const phase of PHASE_ORDER) {
        const value = (collapsedRaw as Record<string, unknown>)[phase];
        if (typeof value === "boolean") collapsed[phase] = value;
      }
      out.collapsedPhases = collapsed;
    }

    return out;
  } catch {
    return {};
  }
}

function saveUiPrefs(prefs: UiPrefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
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
  const initialPrefs = useMemo(() => loadUiPrefs(), []);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) || null, [tasks, selectedId]);
  const activeTasks = useMemo(
    () => tasks.filter((t) => isTaskActive(t.status)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [tasks]
  );

  const [runner, setRunner] = useState<RunnerChoice>("codex");
  const [repoUrl, setRepoUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [repoHistory, setRepoHistory] = useState<string[]>([]);
  const [lastSeenTasks, setLastSeenTasks] = useState<Record<string, number>>({});
  const [taskQuery, setTaskQuery] = useState(() => initialPrefs.taskQuery || "");
  const [taskFilter, setTaskFilter] = useState<"all" | "active" | "failed" | "done" | "canceled" | "unread">(() => initialPrefs.taskFilter || "all");
  const [sseState, setSseState] = useState<"idle" | "connecting" | "open" | "error" | "offline">("idle");
  const [sseLastEventAt, setSseLastEventAt] = useState(0);
  const [sseLastErrorAt, setSseLastErrorAt] = useState(0);
  const [sseReconnectNonce, setSseReconnectNonce] = useState(0);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logsNewCount, setLogsNewCount] = useState(0);
  const [logsFollow, setLogsFollow] = useState(() => (typeof initialPrefs.logsFollow === "boolean" ? initialPrefs.logsFollow : true));
  const [logsIncludeEvents, setLogsIncludeEvents] = useState(() => Boolean(initialPrefs.logsIncludeEvents));
  const [logsStream, setLogsStream] = useState<"all" | "stdout" | "stderr">(() => initialPrefs.logsStream || "all");
  const [logsRepo, setLogsRepo] = useState(() => initialPrefs.logsRepo || "");
  const [logsQuery, setLogsQuery] = useState(() => initialPrefs.logsQuery || "");
  const [timelineErrorsOnly, setTimelineErrorsOnly] = useState(() => Boolean(initialPrefs.timelineErrorsOnly));
  const [timelineCurrentPhaseOnly, setTimelineCurrentPhaseOnly] = useState(() => Boolean(initialPrefs.timelineCurrentPhaseOnly));
  const [timelineTool, setTimelineTool] = useState(() => initialPrefs.timelineTool || "");
  const [timelineRepo, setTimelineRepo] = useState(() => initialPrefs.timelineRepo || "");
  const [timelineQuery, setTimelineQuery] = useState(() => initialPrefs.timelineQuery || "");
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [collapsedPhases, setCollapsedPhases] = useState<Record<TimelinePhase, boolean>>(() => ({ ...DEFAULT_PHASE_COLLAPSE, ...(initialPrefs.collapsedPhases || {}) }));
  const [expandedTimelineRows, setExpandedTimelineRows] = useState<Record<string, boolean>>({});
  const [diffRepoId, setDiffRepoId] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [diffFileId, setDiffFileId] = useState("__all__");
  const [diffFileQuery, setDiffFileQuery] = useState("");
  const [diffPretty, setDiffPretty] = useState(() => (typeof initialPrefs.diffPretty === "boolean" ? initialPrefs.diffPretty : true));

  const [stdinRepoId, setStdinRepoId] = useState("");
  const [stdinText, setStdinText] = useState("");
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const prevSelectedIdRef = useRef("");
  const selectedIdRef = useRef("");
  const visibleTasksRef = useRef<TaskSummary[]>([]);
  const showCreateModalRef = useRef(false);
  const showShortcutsRef = useRef(false);
  const prevTaskStatusRef = useRef<Record<string, string>>({});
  const didHydrateTaskStatusRef = useRef(false);
  const logsFollowRef = useRef(true);
  const repoInputRef = useRef<HTMLInputElement | null>(null);
  const taskSearchRef = useRef<HTMLInputElement | null>(null);
  const logsRef = useRef<HTMLPreElement | null>(null);

  async function refresh() {
    const res = await apiJson<{ tasks: TaskSummary[] }>("/api/agent/tasks");
    if (!isOk(res)) return;
    setTasks(res.tasks || []);
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function pushToast(input: Omit<ToastItem, "id" | "createdAt">) {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item: ToastItem = { ...input, id, createdAt: Date.now() };
    setToasts((prev) => [item, ...prev].slice(0, 4));
    window.setTimeout(() => dismissToast(id), 8000);
  }

  function openCreateModal(initialRepo = "") {
    if (initialRepo) setRepoUrl(initialRepo);
    setError("");
    setShowCreateModal(true);
    window.setTimeout(() => repoInputRef.current?.focus(), 0);
  }

  function reconnectSse() {
    if (!selectedId) return;
    setSseReconnectNonce((p) => p + 1);
  }

  useEffect(() => {
    void refresh();
    setRepoHistory(loadHistory());
    setLastSeenTasks(loadLastSeenTasks());
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const nextStatus: Record<string, string> = {};
    for (const task of tasks) nextStatus[task.id] = String(task.status || "");

    if (!didHydrateTaskStatusRef.current) {
      didHydrateTaskStatusRef.current = true;
      prevTaskStatusRef.current = nextStatus;
      return;
    }

    const prev = prevTaskStatusRef.current;
    for (const task of tasks) {
      const prevStatus = String(prev[task.id] || "");
      const curStatus = String(task.status || "");
      if (!prevStatus || prevStatus === curStatus) continue;

      const prevActive = isTaskActive(prevStatus);
      const curActive = isTaskActive(curStatus);
      if (prevActive && !curActive) {
        const s = curStatus.toLowerCase();
        const tone: ToastTone = s === "done" ? "success" : s === "error" ? "error" : "info";
        const title = s === "done" ? "Task completed" : s === "error" ? "Task failed" : `Task ${statusLabel(s)}`;
        pushToast({ tone, title, message: task.title || task.id, taskId: task.id });
      }
    }

    prevTaskStatusRef.current = nextStatus;
  }, [tasks]);

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
    if (!tasks.length) {
      if (selectedId) setSelectedId("");
      return;
    }

    if (selectedId && tasks.some((task) => task.id === selectedId)) return;

    let nextSelectedId = "";
    const savedId = localStorage.getItem(SELECTED_TASK_KEY) || "";
    if (savedId && tasks.some((task) => task.id === savedId)) {
      nextSelectedId = savedId;
    } else {
      const active = tasks.find((task) => isTaskActive(task.status));
      nextSelectedId = active?.id || tasks[0].id;
    }
    setSelectedId(nextSelectedId);
  }, [tasks, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    localStorage.setItem(SELECTED_TASK_KEY, selectedId);
  }, [selectedId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    saveLastSeenTasks(lastSeenTasks);
  }, [lastSeenTasks]);

  useEffect(() => {
    saveUiPrefs({
      taskQuery,
      taskFilter,
      logsFollow,
      logsIncludeEvents,
      logsStream,
      logsRepo,
      logsQuery,
      timelineErrorsOnly,
      timelineCurrentPhaseOnly,
      timelineTool,
      timelineRepo,
      timelineQuery,
      collapsedPhases,
      diffPretty
    });
  }, [
    taskQuery,
    taskFilter,
    logsFollow,
    logsIncludeEvents,
    logsStream,
    logsRepo,
    logsQuery,
    timelineErrorsOnly,
    timelineCurrentPhaseOnly,
    timelineTool,
    timelineRepo,
    timelineQuery,
    collapsedPhases,
    diffPretty
  ]);

  useEffect(() => {
    if (!selectedId) return;
    const task = tasks.find((t) => t.id === selectedId);
    if (!task) return;
    const updatedAt = task.updatedAt || task.createdAt || Date.now();
    setLastSeenTasks((prev) => {
      const current = prev[selectedId] || 0;
      if (current >= updatedAt) return prev;
      return { ...prev, [selectedId]: updatedAt };
    });
  }, [selectedId, tasks]);

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
    showCreateModalRef.current = showCreateModal;
  }, [showCreateModal]);

  useEffect(() => {
    showShortcutsRef.current = showShortcuts;
  }, [showShortcuts]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      return target.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (showCreateModalRef.current) return;
      if (showShortcutsRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      if (isEditable(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        taskSearchRef.current?.focus();
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        openCreateModal();
        return;
      }

      if (e.key === "r") {
        e.preventDefault();
        if (!selectedIdRef.current) return;
        setSseReconnectNonce((p) => p + 1);
        return;
      }

      if (e.key === "f") {
        e.preventDefault();
        setLogsFollow((p) => !p);
        return;
      }

      if (e.key === "e") {
        e.preventDefault();
        setTimelineErrorsOnly((p) => !p);
        return;
      }

      if (e.key === "j" || e.key === "k") {
        const list = visibleTasksRef.current || [];
        if (!list.length) return;
        const currentIdx = list.findIndex((t) => t.id === selectedIdRef.current);
        const dir = e.key === "j" ? 1 : -1;
        const start = currentIdx >= 0 ? currentIdx : 0;
        let next = start + dir;
        if (next >= list.length) next = 0;
        if (next < 0) next = list.length - 1;
        const nextId = list[next]?.id;
        if (nextId) {
          e.preventDefault();
          setSelectedId(nextId);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prevSelectedId = prevSelectedIdRef.current;
    const isTaskSwitch = prevSelectedId !== selectedId;
    prevSelectedIdRef.current = selectedId;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (isTaskSwitch) {
      setLogEntries([]);
      setLogsNewCount(0);
      setTimeline([]);
      setExpandedTimelineRows({});
      setDiffRepoId("");
      setDiffText("");
      setDiffFiles([]);
      setDiffFileId("__all__");
      setDiffFileQuery("");
      setStdinRepoId("");
      setStdinText("");
      lastSeqRef.current = 0;
      setSseLastEventAt(0);
      setSseLastErrorAt(0);
    }

    if (!selectedId) {
      setSseState("idle");
      return;
    }

    if (!isOnline) {
      setSseState("offline");
      return;
    }

    setSseState("connecting");
    const since = isTaskSwitch ? 0 : lastSeqRef.current;
    const es = new EventSource(`/api/agent/tasks/${encodeURIComponent(selectedId)}/events?since=${since}`);
    esRef.current = es;

    es.onopen = () => {
      setSseState("open");
      setSseLastErrorAt(0);
    };

    es.onerror = () => {
      setSseLastErrorAt(Date.now());
      setSseState(isOnline ? "error" : "offline");
    };

    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(String(msg.data || "{}")) as TaskEvent & { ts?: number };
        const seq = typeof ev.seq === "number" ? ev.seq : 0;
        if (seq && seq <= lastSeqRef.current) return;
        const nextSeq = seq || lastSeqRef.current + 1;
        lastSeqRef.current = nextSeq;

        const eventTs = typeof ev.ts === "number" && Number.isFinite(ev.ts) && ev.ts > 0 ? ev.ts : Date.now();
        setSseLastEventAt(eventTs);

        if (ev.type === "log") {
          setLogEntries((prev) => trimLogEntries([...prev, { seq: nextSeq, at: eventTs, kind: "log", repoId: ev.repoId, stream: ev.stream, text: String(ev.text || "") }]));
        } else {
          setLogEntries((prev) => trimLogEntries([...prev, { seq: nextSeq, at: eventTs, kind: "event", repoId: ev.repoId, text: String(ev.type || "event") }]));
        }

        if (ev.type === "log" && !logsFollowRef.current) {
          setLogsNewCount((p) => Math.min(999, p + 1));
        }

        const sum = eventSummary(ev);
        const tool = timelineToolForEvent(ev);
        const phase = timelinePhaseForEvent(ev);
        const detail = timelineDetailForEvent(ev);
        setTimeline((p) => {
          const next = [...p, { seq: nextSeq, at: eventTs, type: String(ev.type || "event"), repoId: ev.repoId, status: ev.status, level: sum.level, text: sum.text, tool, phase, detail }];
          return next.slice(-280);
        });
        void refresh();
      } catch {
        // ignore
      }
    };

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sseReconnectNonce, isOnline]);

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

  async function loadDiff(repoIdOverride?: string) {
    const repoId = repoIdOverride || diffRepoId;
    if (!selectedId || !repoId) return;
    if (repoIdOverride && repoIdOverride !== diffRepoId) setDiffRepoId(repoIdOverride);
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/agent/tasks/${encodeURIComponent(selectedId)}/repos/${encodeURIComponent(repoId)}/diff`, { cache: "no-store" });
      if (!res.ok) {
        setError("Diff is not ready.");
        setDiffText("");
        return;
      }
      const raw = await res.text();
      setDiffText(raw.replace(/\r\n/g, "\n"));
    } catch {
      setError("Failed to load diff.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setDiffFileId("__all__");
    setDiffFileQuery("");
  }, [diffRepoId]);

  useEffect(() => {
    const files = parseUnifiedDiff(diffText);
    setDiffFiles(files);
    if (!diffText.trim()) {
      if (diffFileId !== "__all__") setDiffFileId("__all__");
      return;
    }
    if (diffFileId === "__all__") return;
    const ok = files.some((f) => f.id === diffFileId);
    if (!ok) setDiffFileId("__all__");
  }, [diffText, diffFileId]);

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

  async function copyLogs() {
    const text = logViewText || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy logs", text);
    }
  }

  async function copyDiff() {
    const text = diffViewText || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy diff", text);
    }
  }

  function sanitizeFilename(input: string) {
    return String(input || "")
      .replace(/[\\/:*?"<>|\r\n]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  function downloadDiff() {
    const text = diffViewText || "";
    if (!text) return;
    const parts = [sanitizeFilename(selectedId || "task"), sanitizeFilename(diffRepoId || "repo"), diffFileId === "__all__" ? "all" : sanitizeFilename(diffSelected.label)];
    const filename = `${parts.filter(Boolean).join("-")}.patch`;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function clearLogs() {
    setLogEntries([]);
  }

  function resetTimelineFilters() {
    setTimelineErrorsOnly(false);
    setTimelineCurrentPhaseOnly(false);
    setTimelineTool("");
    setTimelineRepo("");
    setTimelineQuery("");
  }

  const unreadByTask = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const task of tasks) {
      const updatedAt = task.updatedAt || task.createdAt || 0;
      const seenAt = lastSeenTasks[task.id] || 0;
      out[task.id] = updatedAt > seenAt;
    }
    return out;
  }, [tasks, lastSeenTasks]);

  const taskCounts = useMemo(() => {
    const failed = tasks.filter((t) => String(t.status || "").toLowerCase() === "error").length;
    const done = tasks.filter((t) => String(t.status || "").toLowerCase() === "done").length;
    const canceled = tasks.filter((t) => String(t.status || "").toLowerCase() === "canceled").length;
    const unread = tasks.filter((t) => unreadByTask[t.id]).length;
    return { all: tasks.length, active: activeTasks.length, failed, done, canceled, unread };
  }, [tasks, activeTasks, unreadByTask]);

  const visibleTasks = useMemo(() => {
    const q = taskQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      const status = String(task.status || "").toLowerCase();
      if (taskFilter === "active" && !isTaskActive(status)) return false;
      if (taskFilter === "failed" && status !== "error") return false;
      if (taskFilter === "done" && status !== "done") return false;
      if (taskFilter === "canceled" && status !== "canceled") return false;
      if (taskFilter === "unread" && !unreadByTask[task.id]) return false;

      if (!q) return true;
      const hay = `${task.title || ""}\n${task.id}\n${task.prompt || ""}\n${task.command || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, taskQuery, taskFilter, unreadByTask]);

  useEffect(() => {
    visibleTasksRef.current = visibleTasks;
  }, [visibleTasks]);

  const logRepoOptions = useMemo(() => {
    const ids = (selected?.repos || []).map((r) => r.id).filter(Boolean);
    return Array.from(new Set(ids));
  }, [selected]);

  useEffect(() => {
    if (!logsRepo) return;
    if (logRepoOptions.includes(logsRepo)) return;
    setLogsRepo("");
  }, [logsRepo, logRepoOptions]);

  const filteredLogEntries = useMemo(() => {
    const q = logsQuery.trim().toLowerCase();
    return logEntries.filter((entry) => {
      if (!logsIncludeEvents && entry.kind !== "log") return false;
      if (logsRepo && entry.repoId !== logsRepo) return false;
      if (entry.kind === "log" && logsStream !== "all" && String(entry.stream || "").toLowerCase() !== logsStream) return false;
      if (!q) return true;
      const hay = `${entry.repoId || ""}\n${entry.stream || ""}\n${entry.text || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [logEntries, logsIncludeEvents, logsRepo, logsStream, logsQuery]);

  const logViewText = useMemo(() => {
    if (!filteredLogEntries.length) return "";
    return filteredLogEntries
      .map((entry) => {
        if (entry.kind === "log") {
          const prefix = `[${entry.repoId || "task"}${entry.stream ? `/${entry.stream}` : ""}] `;
          return prefix + entry.text;
        }
        return `[event] ${entry.text}\n`;
      })
      .join("");
  }, [filteredLogEntries]);

  useEffect(() => {
    logsFollowRef.current = logsFollow;
    if (logsFollow) setLogsNewCount(0);
  }, [logsFollow]);

  useEffect(() => {
    if (!logsFollow) return;
    const el = logsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logsFollow, logViewText, selectedId]);

  const diffReadyRepos = useMemo(() => new Set(timeline.filter((e) => e.type === "diff_ready").map((e) => e.repoId).filter(Boolean) as string[]), [timeline]);
  const promoteErrorRepos = useMemo(() => new Set(timeline.filter((e) => e.type === "promote_error").map((e) => e.repoId).filter(Boolean) as string[]), [timeline]);

  const diffStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of diffFiles) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { files: diffFiles.length, additions, deletions };
  }, [diffFiles]);

  const diffSelected = useMemo(() => {
    if (diffFileId === "__all__") return { label: "All files", text: diffText };
    const file = diffFiles.find((f) => f.id === diffFileId);
    if (!file) return { label: diffFileId, text: diffText };
    const label = file.bPath || file.aPath || file.id;
    return { label, text: file.text };
  }, [diffText, diffFiles, diffFileId]);

  const diffViewText = diffSelected.text || "";
  const diffLineCount = useMemo(() => (diffViewText ? diffViewText.split("\n").length : 0), [diffViewText]);
  const diffIsLarge = diffLineCount > 6000 || diffViewText.length > 420_000;
  const diffShowPretty = diffPretty && !diffIsLarge;

  const diffFileOptions = useMemo(() => {
    const q = diffFileQuery.trim().toLowerCase();
    const filtered = q
      ? diffFiles.filter((f) => {
          const hay = `${f.bPath || ""}\n${f.aPath || ""}\n${f.id}`.toLowerCase();
          return hay.includes(q);
        })
      : diffFiles;

    if (diffFileId !== "__all__" && !filtered.some((f) => f.id === diffFileId)) {
      const selectedFile = diffFiles.find((f) => f.id === diffFileId);
      if (selectedFile) return [selectedFile, ...filtered];
    }
    return filtered;
  }, [diffFiles, diffFileQuery, diffFileId]);

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

  const currentPhase = useMemo(() => {
    for (const phase of PHASE_ORDER) {
      if (phase === "other") continue;
      if (phaseStateMap[phase] === "active") return phase;
    }
    return null as TimelinePhase | null;
  }, [phaseStateMap]);

  const timelineView = useMemo(() => timeline.slice().reverse().slice(0, 160), [timeline]);

  const timelineToolOptions = useMemo(() => {
    const tools = timeline.map((entry) => entry.tool).filter(Boolean);
    return Array.from(new Set(tools)).sort();
  }, [timeline]);

  const timelineRepoOptions = useMemo(() => {
    const repos = timeline.map((entry) => entry.repoId).filter(Boolean) as string[];
    return Array.from(new Set(repos)).sort();
  }, [timeline]);

  useEffect(() => {
    if (!timelineRepo) return;
    if (timelineRepoOptions.includes(timelineRepo)) return;
    setTimelineRepo("");
  }, [timelineRepo, timelineRepoOptions]);

  useEffect(() => {
    if (!timelineTool) return;
    if (timelineToolOptions.includes(timelineTool)) return;
    setTimelineTool("");
  }, [timelineTool, timelineToolOptions]);

  const timelineFiltered = useMemo(() => {
    const q = timelineQuery.trim().toLowerCase();
    return timelineView.filter((entry) => {
      if (timelineErrorsOnly && entry.level !== "error") return false;
      if (timelineCurrentPhaseOnly && currentPhase && entry.phase !== currentPhase) return false;
      if (timelineTool && entry.tool !== timelineTool) return false;
      if (timelineRepo && entry.repoId !== timelineRepo) return false;
      if (!q) return true;
      const hay = `${entry.text}\n${entry.detail || ""}\n${entry.tool}\n${entry.repoId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [timelineView, timelineQuery, timelineErrorsOnly, timelineCurrentPhaseOnly, timelineTool, timelineRepo, currentPhase]);

  const timelineSections = useMemo(() => {
    const groups = new Map<TimelinePhase, TimelinePhaseGroup>();
    for (const phase of PHASE_ORDER) {
      groups.set(phase, {
        id: phase,
        label: PHASE_LABEL[phase],
        entries: [],
        failed: 0,
        tools: [],
        level: "info",
        firstAt: 0,
        lastAt: 0,
        durationMs: 0
      });
    }
    for (const entry of timelineFiltered) {
      const group = groups.get(entry.phase);
      if (!group) continue;
      group.entries.push(entry);
      if (entry.level === "error") group.failed += 1;
      if (!group.tools.includes(entry.tool)) group.tools.push(entry.tool);
      if (levelWeight(entry.level) > levelWeight(group.level)) group.level = entry.level;
      if (!group.firstAt || entry.at < group.firstAt) group.firstAt = entry.at;
      if (!group.lastAt || entry.at > group.lastAt) group.lastAt = entry.at;
    }
    for (const group of groups.values()) {
      if (group.entries.length < 2) {
        group.durationMs = 0;
        continue;
      }
      group.durationMs = Math.max(0, group.lastAt - group.firstAt);
    }
    return PHASE_ORDER.map((phase) => groups.get(phase)).filter((group): group is TimelinePhaseGroup => Boolean(group && group.entries.length));
  }, [timelineFiltered]);

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
  const sseTitleParts: string[] = [];
  if (sseLastEventAt) sseTitleParts.push(`last event: ${new Date(sseLastEventAt).toLocaleString()}`);
  if (sseLastErrorAt) sseTitleParts.push(`last error: ${new Date(sseLastErrorAt).toLocaleString()}`);
  if (!isOnline) sseTitleParts.push("browser offline");
  const sseTitle = sseTitleParts.join(" | ") || "Event stream status";

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

        {activeTasks.length ? (
          <div className="agent-section">
            <div className="agent-title agent-title-row">
              <span>In Progress</span>
              <span className="agent-pill">{activeTasks.length}</span>
            </div>
            <div className="agent-live-list">
              {activeTasks.slice(0, 6).map((task) => (
                <button
                  key={`active-${task.id}`}
                  className="agent-live-item"
                  type="button"
                  data-selected={task.id === selectedId ? "true" : undefined}
                  onClick={() => setSelectedId(task.id)}
                  title={task.id}
                >
                  <span className="agent-live-dot" aria-hidden="true" />
                  <span className="agent-live-title">{task.title || task.id}</span>
                  <span className="agent-live-time">{new Date(task.updatedAt || task.createdAt).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="agent-section">
          <div className="agent-title agent-title-row">
            <span>Recent Runs</span>
            {taskCounts.unread ? <span className="agent-pill">unread {taskCounts.unread}</span> : <span className="agent-pill">{taskCounts.all}</span>}
          </div>
          <div className="agent-run-controls">
            <input
              ref={taskSearchRef}
              className="agent-input agent-input-compact"
              value={taskQuery}
              onChange={(e) => setTaskQuery(e.target.value)}
              placeholder="Search tasks…"
            />
            <div className="agent-filter-row" role="tablist" aria-label="Task filters">
              <button className="agent-filter-btn" type="button" data-selected={taskFilter === "all" ? "true" : undefined} onClick={() => setTaskFilter("all")}>All <span className="agent-filter-count">{taskCounts.all}</span></button>
              <button className="agent-filter-btn" type="button" data-selected={taskFilter === "active" ? "true" : undefined} onClick={() => setTaskFilter("active")}>Active <span className="agent-filter-count">{taskCounts.active}</span></button>
              <button className="agent-filter-btn" type="button" data-selected={taskFilter === "failed" ? "true" : undefined} onClick={() => setTaskFilter("failed")}>Failed <span className="agent-filter-count">{taskCounts.failed}</span></button>
              <button className="agent-filter-btn" type="button" data-selected={taskFilter === "done" ? "true" : undefined} onClick={() => setTaskFilter("done")}>Done <span className="agent-filter-count">{taskCounts.done}</span></button>
              <button className="agent-filter-btn" type="button" data-selected={taskFilter === "unread" ? "true" : undefined} onClick={() => setTaskFilter("unread")}>Unread <span className="agent-filter-count">{taskCounts.unread}</span></button>
            </div>
          </div>
          <div className="agent-tasks">
            {visibleTasks.map((t) => (
              <button key={t.id} className="agent-task" type="button" data-selected={t.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(t.id)} title={t.id}>
                <div className="agent-task-title-row">
                  <span className="agent-task-title-text">{t.title || t.id}</span>
                  {unreadByTask[t.id] && t.id !== selectedId ? <span className="agent-unread-dot" aria-hidden="true" /> : null}
                </div>
                <div className="agent-task-meta">
                  <span className="agent-pill">{statusLabel(t.status)}</span>
                  {isTaskActive(t.status) ? <span className="agent-live-dot" aria-hidden="true" /> : null}
                  <span className="agent-task-time">{new Date(t.createdAt).toLocaleString()}</span>
                </div>
              </button>
            ))}
            {!visibleTasks.length ? <div className="agent-muted">{tasks.length ? "No matches." : "No tasks yet."}</div> : null}
          </div>
        </div>
      </div>

      <div className="agent-main">
        <div className="agent-main-topbar">
          <div className="agent-main-top-title">Workspace Console</div>
          <div className="agent-main-top-actions">
            <div className="agent-conn" data-state={sseState} title={sseTitle}>
              <span className="agent-conn-dot" aria-hidden="true" />
              <span className="agent-conn-text">{sseLabel}</span>
              {selectedId && (sseState === "error" || sseState === "offline") ? (
                <button className="agent-conn-btn" type="button" onClick={() => reconnectSse()}>Reconnect</button>
              ) : null}
            </div>
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
                        {hasDiff ? (
                          <button className="agent-mini-btn" type="button" disabled={busy} onClick={() => void loadDiff(r.id)}>
                            View Diff
                          </button>
                        ) : null}
                        {r.prUrl ? <a className="agent-link" href={r.prUrl} target="_blank" rel="noreferrer">Artifact: PR</a> : null}
                        {r.branch ? <div className="agent-muted">branch: {r.branch}</div> : null}
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
                  <span className="agent-panel-meta">events {timelineFiltered.length}/{timeline.length} | failed {metrics.failedPoints}</span>
                </div>
                <div className="agent-timeline-controls">
                  <button className="agent-mini-btn" type="button" data-selected={timelineErrorsOnly ? "true" : undefined} onClick={() => setTimelineErrorsOnly((p) => !p)}>Errors</button>
                  <button className="agent-mini-btn" type="button" disabled={!currentPhase} data-selected={timelineCurrentPhaseOnly ? "true" : undefined} onClick={() => setTimelineCurrentPhaseOnly((p) => !p)}>Current phase</button>
                  <select className="agent-input agent-input-compact" value={timelineRepo} onChange={(e) => setTimelineRepo(e.target.value)}>
                    <option value="">All repos</option>
                    {timelineRepoOptions.map((id) => <option key={`t-repo-${id}`} value={id}>{id}</option>)}
                  </select>
                  <select className="agent-input agent-input-compact" value={timelineTool} onChange={(e) => setTimelineTool(e.target.value)}>
                    <option value="">All tools</option>
                    {timelineToolOptions.map((tool) => <option key={`t-tool-${tool}`} value={tool}>{tool}</option>)}
                  </select>
                  <input className="agent-input agent-input-compact" value={timelineQuery} onChange={(e) => setTimelineQuery(e.target.value)} placeholder="Search timeline…" />
                  <button className="agent-mini-btn" type="button" onClick={() => resetTimelineFilters()}>Reset</button>
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
                          <span className="agent-phase-elapsed">{section.durationMs ? `elapsed ${fmtDuration(section.durationMs)}` : "elapsed -"}</span>
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
                <div className="agent-panel-title agent-panel-title-row">
                  <span>Logs</span>
                  <span className="agent-panel-actions">
                    <button className="agent-mini-btn" type="button" onClick={() => void copyLogs()}>Copy</button>
                    <button className="agent-mini-btn" type="button" onClick={() => clearLogs()}>Clear</button>
                    {!logsFollow && logsNewCount ? (
                      <button className="agent-mini-btn" type="button" onClick={() => setLogsFollow(true)}>
                        Catch up ({logsNewCount})
                      </button>
                    ) : null}
                    <button className="agent-mini-btn" type="button" data-selected={logsFollow ? "true" : undefined} onClick={() => setLogsFollow((p) => !p)}>{logsFollow ? "Following" : "Paused"}</button>
                  </span>
                </div>
                <div className="agent-log-controls">
                  <select className="agent-input agent-input-compact" value={logsRepo} onChange={(e) => setLogsRepo(e.target.value)}>
                    <option value="">All repos</option>
                    {logRepoOptions.map((id) => <option key={`logrepo-${id}`} value={id}>{id}</option>)}
                  </select>
                  <select className="agent-input agent-input-compact" value={logsStream} onChange={(e) => setLogsStream(e.target.value as "all" | "stdout" | "stderr")}>
                    <option value="all">All streams</option>
                    <option value="stdout">stdout</option>
                    <option value="stderr">stderr</option>
                  </select>
                  <input className="agent-input agent-input-compact" value={logsQuery} onChange={(e) => setLogsQuery(e.target.value)} placeholder="Search logs…" />
                  <label className="agent-check"><input type="checkbox" checked={logsIncludeEvents} onChange={(e) => setLogsIncludeEvents(e.target.checked)} /> events</label>
                </div>
                <pre ref={logsRef} className="agent-logs">{logViewText || "No logs yet."}</pre>
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
                    <button className="agent-mini-btn" type="button" disabled={busy || !diffViewText} onClick={() => void copyDiff()}>Copy</button>
                    <button className="agent-mini-btn" type="button" disabled={busy || !diffViewText} onClick={() => downloadDiff()}>Download</button>
                  </div>
                  <div className="agent-artifacts-list">
                    {selected.repos.filter((r) => !!r.prUrl).map((r) => <a key={`${r.id}-${r.prUrl || ""}`} className="agent-link" href={r.prUrl || "#"} target="_blank" rel="noreferrer">{r.id}: PR</a>)}
                    {!selected.repos.some((r) => !!r.prUrl) ? <div className="agent-muted">No PR artifact yet.</div> : null}
                  </div>
                  <div className="agent-diff-controls">
                    <select className="agent-input agent-input-compact" value={diffFileId} onChange={(e) => setDiffFileId(e.target.value)} disabled={!diffFiles.length}>
                      <option value="__all__">All files ({diffStats.files})</option>
                      {diffFileOptions.map((f) => {
                        const name = f.bPath || f.aPath || f.id;
                        return (
                          <option key={`diff-file-${f.id}`} value={f.id}>
                            {name} (+{f.additions} -{f.deletions})
                          </option>
                        );
                      })}
                    </select>
                    <input className="agent-input agent-input-compact" value={diffFileQuery} onChange={(e) => setDiffFileQuery(e.target.value)} placeholder="Filter files…" disabled={!diffFiles.length} />
                    <label className="agent-check"><input type="checkbox" checked={diffPretty} onChange={(e) => setDiffPretty(e.target.checked)} disabled={!diffViewText} /> pretty</label>
                    {diffIsLarge && diffPretty ? <span className="agent-muted">Large diff: pretty disabled</span> : null}
                  </div>
                </div>
                <div className="agent-diff-summary">
                  {diffViewText ? (
                    <>
                      <span className="agent-pill">{diffSelected.label}</span>
                      <span className="agent-muted">files {diffStats.files} · +{diffStats.additions} / -{diffStats.deletions} · {diffLineCount ? `${diffLineCount} lines` : "-"}</span>
                    </>
                  ) : (
                    <span className="agent-muted">Select a repo and click Load Diff.</span>
                  )}
                </div>
                {diffShowPretty ? (
                  <pre className="agent-diff agent-diff-pretty">
                    {diffViewText.split("\n").map((line, idx) => (
                      <span key={`diff-line-${idx}`} className="agent-diff-line" data-tone={diffToneForLine(line)}>
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <pre className="agent-diff">{diffViewText || "Select a repo and click Load Diff."}</pre>
                )}
              </div>
            </div>
          </>
        ) : <div className="agent-empty agent-empty-card">Select a task to view flow, timeline and repo lanes.</div>}
      </div>

      {toasts.length ? (
        <div className="agent-toast-stack" aria-live="polite" aria-relevant="additions">
          {toasts.map((toast) => (
            <div key={toast.id} className="agent-toast" data-tone={toast.tone}>
              <div className="agent-toast-top">
                <div className="agent-toast-title">{toast.title}</div>
                <button className="agent-toast-close" type="button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
                  ×
                </button>
              </div>
              <div className="agent-toast-msg">{toast.message}</div>
              {toast.taskId ? (
                <button
                  className="agent-mini-btn"
                  type="button"
                  onClick={() => {
                    setSelectedId(toast.taskId || "");
                    dismissToast(toast.id);
                  }}
                >
                  Open
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

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

      {showShortcuts ? (
        <div className="agent-modal-backdrop agent-shortcuts-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowShortcuts(false)}>
          <div className="agent-modal agent-shortcuts-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <div className="agent-modal-header">
              <div><div className="agent-modal-title">Keyboard shortcuts</div><div className="agent-muted">Press Esc to close</div></div>
              <button className="agent-btn" type="button" onClick={() => setShowShortcuts(false)}>Close</button>
            </div>
            <div className="agent-modal-body">
              <div className="agent-shortcuts-grid">
                <div className="agent-shortcut"><span className="agent-kbd">?</span><span>Show shortcuts</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">/</span><span>Focus task search</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">j</span><span>Next task</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">k</span><span>Previous task</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">n</span><span>New task</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">r</span><span>Reconnect stream</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">f</span><span>Toggle log follow</span></div>
                <div className="agent-shortcut"><span className="agent-kbd">e</span><span>Toggle timeline errors</span></div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


