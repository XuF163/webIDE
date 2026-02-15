import React, { useEffect, useMemo, useRef, useState } from "react";

type FsEntryKind = "dir" | "file" | "symlink" | "other";

type FsEntry = {
  name: string;
  kind: FsEntryKind;
  size: number | null;
  mtimeMs: number;
};

type FsRoot = {
  id: string;
  title: string;
  path: string;
  readOnly?: boolean;
};

type FsOk<T> = { ok: true } & T;
type FsErr = { ok: false; code?: string; message?: string };
type FsResponse<T> = FsOk<T> | FsErr;

const STORAGE_FILES_ROOT = "hfide.files.root";
const STORAGE_FILES_PATH_LEGACY = "hfide.files.path";
const STORAGE_FILES_PATH_V2_PREFIX = "hfide.files.path.v2.";

function joinRelPath(dir: string, name: string) {
  const clean = name.replace(/\\/g, "/").replace(/\//g, "").trim();
  if (!clean) return dir;
  if (!dir) return clean;
  return `${dir}/${clean}`;
}

function parentRelPath(p: string) {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIdx]}`;
}

function formatTime(ms: number) {
  try {
    return new Date(ms).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function kindLabel(kind: FsEntryKind) {
  if (kind === "dir") return "File folder";
  if (kind === "file") return "File";
  if (kind === "symlink") return "Shortcut";
  return "Item";
}

function iconForKind(kind: FsEntryKind) {
  if (kind === "dir")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 4l2 2h8a2 2 0 012 2v1H2V6a2 2 0 012-2h6z" fill="#caa34a" />
        <path d="M2 9h22v11a2 2 0 01-2 2H4a2 2 0 01-2-2V9z" fill="#e6c25e" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 2h9l5 5v15a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" fill="#4aa3df" />
      <path d="M15 2v6h6" fill="rgba(255,255,255,0.35)" />
      <path d="M8 13h8M8 16h8" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function toolbarIcon(kind: "up" | "refresh" | "newFolder" | "upload" | "download" | "rename" | "delete") {
  const common = { viewBox: "0 0 24 24", "aria-hidden": true as const };
  if (kind === "up") {
    return (
      <svg {...common}>
        <path d="M12 5l-6 6h4v8h4v-8h4l-6-6z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "refresh") {
    return (
      <svg {...common}>
        <path
          d="M6.5 7.5A7 7 0 0119 9h2l-3.5 3.5L14 9h2a5 5 0 10-1.5 3.5l1.4 1.4A7 7 0 116.5 7.5z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (kind === "newFolder") {
    return (
      <svg {...common}>
        <path d="M10 5l2 2h8a2 2 0 012 2v1H2V7a2 2 0 012-2h6z" fill="currentColor" opacity="0.75" />
        <path d="M2 10h22v9a2 2 0 01-2 2H4a2 2 0 01-2-2v-9z" fill="currentColor" opacity="0.9" />
        <path d="M12 12v6M9 15h6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "upload") {
    return (
      <svg {...common}>
        <path d="M12 3l4 4h-3v7h-2V7H8l4-4z" fill="currentColor" />
        <path d="M5 14v5h14v-5h2v7H3v-7h2z" fill="currentColor" opacity="0.75" />
      </svg>
    );
  }
  if (kind === "download") {
    return (
      <svg {...common}>
        <path d="M11 3h2v9h3l-4 4-4-4h3V3z" fill="currentColor" />
        <path d="M5 14v5h14v-5h2v7H3v-7h2z" fill="currentColor" opacity="0.75" />
      </svg>
    );
  }
  if (kind === "rename") {
    return (
      <svg {...common}>
        <path
          d="M4 17.25V20h2.75L17.8 8.95l-2.75-2.75L4 17.25z"
          fill="currentColor"
          opacity="0.9"
        />
        <path d="M18.5 7.25a1 1 0 000-1.4l-1.35-1.35a1 1 0 00-1.4 0l-1.05 1.05 2.75 2.75 1.05-1.05z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 7h10l-1 14H8L7 7z" fill="currentColor" opacity="0.9" />
      <path d="M9 4h6l1 2H8l1-2z" fill="currentColor" />
      <path d="M10 9v9M14 9v9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
    </svg>
  );
}

async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<FsResponse<T>> {
  const res = await fetch(input, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => null)) as FsResponse<T> | null;
  if (data && typeof data === "object" && "ok" in data) return data;
  if (!res.ok) return { ok: false, code: String(res.status), message: res.statusText };
  return { ok: false, code: "bad_response", message: "Bad response." };
}

export default function FileExplorer({ onOpen }: { onOpen?: (file: FsEntry, path: string) => void }) {
  const initialRoot = localStorage.getItem(STORAGE_FILES_ROOT) || "workspace";
  const [rootId, setRootId] = useState(initialRoot);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [defaultRootId, setDefaultRootId] = useState<string | null>(null);

  const [pathRel, setPathRel] = useState(() => localStorage.getItem(STORAGE_FILES_PATH_V2_PREFIX + initialRoot) || localStorage.getItem(STORAGE_FILES_PATH_LEGACY) || "");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [rootDirs, setRootDirs] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragCounterRef = useRef(0);

  const currentRoot = useMemo(() => roots.find((r) => r.id === rootId) || null, [roots, rootId]);
  const readOnly = currentRoot?.readOnly === true;

  const breadcrumbs = useMemo(() => {
    const parts = pathRel.split("/").filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [{ label: currentRoot?.title || "Workspace", path: "" }];
    let acc = "";
    for (const part of parts) {
      acc = joinRelPath(acc, part);
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [pathRel, currentRoot?.title]);

  useEffect(() => {
    localStorage.setItem(STORAGE_FILES_ROOT, rootId);
  }, [rootId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_FILES_PATH_V2_PREFIX + rootId, pathRel);
  }, [pathRel, rootId]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const res = await apiJson<{ roots: FsRoot[]; defaultRootId?: string }>(`/api/fs/roots`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) return;
      setRoots(res.roots || []);
      setDefaultRootId(typeof res.defaultRootId === "string" && res.defaultRootId ? res.defaultRootId : null);
    })().catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!roots.length) return;
    if (roots.some((r) => r.id === rootId)) return;
    const next = (defaultRootId && roots.some((r) => r.id === defaultRootId) ? defaultRootId : null) || roots[0].id;
    setRootId(next);
    setPathRel(localStorage.getItem(STORAGE_FILES_PATH_V2_PREFIX + next) || "");
    setSelected(null);
    setSearch("");
    setError("");
  }, [roots, rootId, defaultRootId]);

  function switchRoot(nextId: string) {
    if (nextId === rootId) return;
    setRootId(nextId);
    setPathRel(localStorage.getItem(STORAGE_FILES_PATH_V2_PREFIX + nextId) || "");
    setSelected(null);
    setSearch("");
    setError("");
  }

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setError("");

    (async () => {
      const url = `/api/fs/list?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(pathRel)}`;
      const res = await apiJson<{ path: string; entries: FsEntry[] }>(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setEntries([]);
        setSelected(null);
        setError(res.message || "Failed to load.");
        return;
      }
      setEntries(res.entries || []);
      setSelected(null);
    })()
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e && typeof e.message === "string" ? e.message : "Failed to load.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [rootId, pathRel, refreshTick]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const res = await apiJson<{ entries: FsEntry[] }>(`/api/fs/list?root=${encodeURIComponent(rootId)}&path=`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) return;
      setRootDirs((res.entries || []).filter((e) => e.kind === "dir"));
    })().catch(() => undefined);
    return () => controller.abort();
  }, [rootId]);

  const selectedEntry = useMemo(() => (selected ? entries.find((e) => e.name === selected) || null : null), [entries, selected]);
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  function isTypingTarget(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function onExplorerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (isTypingTarget(e.target)) return;

    const list = filteredEntries;
    const idx = selected ? list.findIndex((x) => x.name === selected) : -1;
    const cur = idx >= 0 ? list[idx] : null;

    if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      refresh();
      return;
    }

    if (e.key === "Backspace" && pathRel) {
      e.preventDefault();
      setPathRel(parentRelPath(pathRel));
      return;
    }

    if (!list.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = idx >= 0 ? Math.min(list.length - 1, idx + 1) : 0;
      setSelected(list[next].name);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = idx >= 0 ? Math.max(0, idx - 1) : 0;
      setSelected(list[next].name);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      setSelected(list[0].name);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      setSelected(list[list.length - 1].name);
      return;
    }

    if (e.key === "Enter" && cur) {
      e.preventDefault();
      if (cur.kind === "dir") setPathRel(joinRelPath(pathRel, cur.name));
      if (cur.kind === "file") downloadPath(joinRelPath(pathRel, cur.name), cur.name);
      return;
    }

    if (e.key === "F2") {
      e.preventDefault();
      if (readOnly) return;
      void renameSelected();
      return;
    }

    if (e.key === "Delete") {
      e.preventDefault();
      if (readOnly) return;
      void deleteSelected();
      return;
    }
  }

  async function mkdirHere() {
    if (readOnly) return;
    const name = window.prompt("Folder name");
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const target = joinRelPath(pathRel, name);
      const res = await apiJson(`/api/fs/mkdir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: rootId, path: target }) });
      if (!res.ok) return setError(res.message || "Failed to create folder.");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function renameSelected() {
    if (readOnly) return;
    if (!selectedEntry) return;
    const nextName = window.prompt("Rename to", selectedEntry.name);
    if (!nextName || nextName === selectedEntry.name) return;
    setBusy(true);
    setError("");
    try {
      const from = joinRelPath(pathRel, selectedEntry.name);
      const to = joinRelPath(pathRel, nextName);
      const res = await apiJson(`/api/fs/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: rootId, from, to }) });
      if (!res.ok) return setError(res.message || "Failed to rename.");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (readOnly) return;
    if (!selectedEntry) return;
    const label = selectedEntry.kind === "dir" ? "folder" : "file";
    const ok = window.confirm(`Delete this ${label}?\n\n${selectedEntry.name}`);
    if (!ok) return;
    const recursive = selectedEntry.kind === "dir";
    setBusy(true);
    setError("");
    try {
      const target = joinRelPath(pathRel, selectedEntry.name);
      const res = await apiJson(`/api/fs/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: rootId, path: target, recursive }) });
      if (!res.ok) return setError(res.message || "Failed to delete.");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  function downloadPath(target: string, filename: string) {
    const a = document.createElement("a");
    a.href = `/api/fs/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(target)}`;
    a.download = filename;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadSelected() {
    if (!selectedEntry || selectedEntry.kind !== "file") return;
    const target = joinRelPath(pathRel, selectedEntry.name);
    downloadPath(target, selectedEntry.name);
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (readOnly) return setError("This location is read-only.");
    setBusy(true);
    setError("");
    try {
      for (const file of list) {
        const target = joinRelPath(pathRel, file.name);
        const res = await fetch(`/api/fs/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(target)}`, { method: "PUT", cache: "no-store", body: file });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as FsErr | null;
          throw new Error(data?.message || `Upload failed (${res.status})`);
        }
      }
      refresh();
    } catch (e: unknown) {
      if (e instanceof Error) setError(e.message || "Upload failed.");
      else setError("Upload failed.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const disabled = busy || loading;
  const writeDisabled = disabled || readOnly;

  return (
    <div
      className={`explorer ${dragActive ? "drag-active" : ""}`}
      tabIndex={0}
      onKeyDown={onExplorerKeyDown}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounterRef.current += 1;
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setDragActive(false);
        void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="explorer-toolbar" role="toolbar" aria-label="File Explorer toolbar">
        <button
          className="explorer-btn icon"
          type="button"
          disabled={disabled || !pathRel}
          onClick={() => setPathRel(parentRelPath(pathRel))}
          title="Up"
          aria-label="Up"
        >
          <span className="btn-icon">{toolbarIcon("up")}</span>
        </button>
        <button className="explorer-btn icon" type="button" disabled={disabled} onClick={refresh} title="Refresh" aria-label="Refresh">
          <span className="btn-icon">{toolbarIcon("refresh")}</span>
        </button>
        <div className="explorer-sep" aria-hidden="true" />
        <button className="explorer-btn" type="button" disabled={writeDisabled} onClick={() => void mkdirHere()} title={readOnly ? "Read-only" : "New folder"}>
          <span className="btn-icon">{toolbarIcon("newFolder")}</span>
          <span className="btn-label">New folder</span>
        </button>
        <button
          className="explorer-btn"
          type="button"
          disabled={writeDisabled}
          onClick={() => {
            fileInputRef.current?.click();
          }}
          title={readOnly ? "Read-only" : "Upload"}
        >
          <span className="btn-icon">{toolbarIcon("upload")}</span>
          <span className="btn-label">Upload</span>
        </button>
        <button className="explorer-btn" type="button" disabled={disabled || !selectedEntry || selectedEntry.kind !== "file"} onClick={downloadSelected} title="Download">
          <span className="btn-icon">{toolbarIcon("download")}</span>
          <span className="btn-label">Download</span>
        </button>
        <button className="explorer-btn" type="button" disabled={writeDisabled || !selectedEntry} onClick={() => void renameSelected()} title={readOnly ? "Read-only" : "Rename"}>
          <span className="btn-icon">{toolbarIcon("rename")}</span>
          <span className="btn-label">Rename</span>
        </button>
        <button className="explorer-btn danger" type="button" disabled={writeDisabled || !selectedEntry} onClick={() => void deleteSelected()} title={readOnly ? "Read-only" : "Delete"}>
          <span className="btn-icon">{toolbarIcon("delete")}</span>
          <span className="btn-label">Delete</span>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (!e.target.files) return;
            void uploadFiles(e.target.files);
          }}
        />

        <div className="explorer-spacer" />

        <div className="explorer-address" role="navigation" aria-label="Current path">
          {breadcrumbs.map((c, idx) => (
            <React.Fragment key={c.path}>
              <button className="crumb" type="button" disabled={disabled || c.path === pathRel} onClick={() => setPathRel(c.path)} title={c.path || "/"}>
                {c.label}
              </button>
              {idx < breadcrumbs.length - 1 ? <span className="crumb-sep">{">"}</span> : null}
            </React.Fragment>
          ))}
        </div>

        <input
          className="explorer-search"
          type="search"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search"
          disabled={disabled}
        />
      </div>

      <div className="explorer-body">
        <aside className="explorer-sidebar" aria-label="Navigation pane">
          <div className="nav-section">
            <div className="nav-title">This PC</div>
            {roots.map((r) => (
              <button key={r.id} className={`nav-item ${r.id === rootId ? "active" : ""}`} type="button" disabled={disabled} onClick={() => switchRoot(r.id)}>
                {r.title}
                {r.readOnly ? " (Read-only)" : ""}
              </button>
            ))}
          </div>

          <div className="nav-section">
            <div className="nav-title">Quick access</div>
            <button className={`nav-item ${!pathRel ? "active" : ""}`} type="button" disabled={disabled} onClick={() => setPathRel("")}>
              {currentRoot?.title || "Root"}
            </button>
            {rootDirs.map((d) => {
              const rel = d.name;
              const active = pathRel === rel || pathRel.startsWith(rel + "/");
              return (
                <button key={d.name} className={`nav-item ${active ? "active" : ""}`} type="button" disabled={disabled} onClick={() => setPathRel(rel)}>
                  {d.name}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="explorer-main" aria-label="Items">
          {error ? <div className="explorer-error">{error}</div> : null}
          <div className="explorer-table" role="table" aria-busy={loading || busy}>
            <div className="row header" role="row">
              <div className="cell name" role="columnheader">
                Name
              </div>
              <div className="cell modified" role="columnheader">
                Date modified
              </div>
              <div className="cell type" role="columnheader">
                Type
              </div>
              <div className="cell size" role="columnheader">
                Size
              </div>
            </div>

            {filteredEntries.map((e) => {
              const isSelected = selected === e.name;
              return (
                <div
                  key={e.name}
                  className={`row item ${isSelected ? "selected" : ""}`}
                  role="row"
                  tabIndex={0}
                  onClick={() => setSelected(e.name)}
                  onDoubleClick={() => {
                    if (e.kind === "dir") setPathRel(joinRelPath(pathRel, e.name));
                    if (e.kind === "file") downloadPath(joinRelPath(pathRel, e.name), e.name);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") {
                      if (e.kind === "dir") setPathRel(joinRelPath(pathRel, e.name));
                      if (e.kind === "file") downloadPath(joinRelPath(pathRel, e.name), e.name);
                    }
                  }}
                >
                  <div className="cell name" role="cell">
                    <span className="item-icon">{iconForKind(e.kind)}</span>
                    <span className="text">{e.name}</span>
                  </div>
                  <div className="cell modified" role="cell">
                    {formatTime(e.mtimeMs)}
                  </div>
                  <div className="cell type" role="cell">
                    {kindLabel(e.kind)}
                  </div>
                  <div className="cell size" role="cell">
                    {formatBytes(e.size)}
                  </div>
                </div>
              );
            })}

            {!loading && !busy && !error && filteredEntries.length === 0 ? <div className="explorer-empty">This folder is empty.</div> : null}
          </div>
          <div className="explorer-status" role="status" aria-live="polite">
            {busy ? "Working…" : loading ? "Loading…" : search.trim() ? `${filteredEntries.length} items (filtered from ${entries.length})` : `${entries.length} items`}
            {currentRoot ? ` • Root: ${currentRoot.title} (${currentRoot.path})${readOnly ? " • Read-only" : ""}` : ""}
            {selectedEntry ? ` • Selected: ${selectedEntry.name}` : ""}
          </div>
        </section>
      </div>
    </div>
  );
}
