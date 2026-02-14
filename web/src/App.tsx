import React, { useEffect, useMemo, useRef, useState } from "react";
import { sha256Base64 } from "./lib/sha256";

type Mode = "vscode" | "terminal" | "split" | "desktop";
type WindowKind = "vscode" | "terminal";

type Rect = { x: number; y: number; w: number; h: number };

type DesktopWindowState = Rect & {
  z: number;
  maximized: boolean;
  minimized: boolean;
  restore: Rect | null;
};

type DesktopWindow = {
  id: string;
  kind: WindowKind;
  title: string;
  state: DesktopWindowState;
};

type RuntimeConfig = {
  version?: number;
  lock?: {
    pinSha256Base64?: string | null;
    lockOnStart?: boolean;
  };
};

const STORAGE_MODE = "hfide.mode";
const STORAGE_SPLIT = "hfide.split";
const STORAGE_LOCKED = "hfide.locked";
const STORAGE_PIN_HASH = "hfide.pinHash";
const STORAGE_DESKTOP_V1 = "hfide.desktop.v1";
const STORAGE_DESKTOP_V2 = "hfide.desktop.v2";
const STORAGE_SESSION_UNLOCKED = "hfide.unlocked.v1";

const DESKTOP_MIN_W_PX = 360;
const DESKTOP_MIN_H_PX = 240;

const DEFAULT_WINDOWS: DesktopWindow[] = [
  {
    id: "vscode",
    kind: "vscode",
    title: "VS Code",
    state: { x: 0.04, y: 0.05, w: 0.62, h: 0.9, z: 2, maximized: false, minimized: false, restore: null }
  },
  {
    id: "terminal",
    kind: "terminal",
    title: "Terminal",
    state: { x: 0.52, y: 0.16, w: 0.44, h: 0.62, z: 3, maximized: false, minimized: false, restore: null }
  }
];

function clamp(min: number, max: number, value: number) {
  return Math.max(min, Math.min(max, value));
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadMode(): Mode {
  const raw = localStorage.getItem(STORAGE_MODE);
  if (raw === "vscode" || raw === "terminal" || raw === "split" || raw === "desktop") return raw;
  return "vscode";
}

function loadSplitRatio(): number {
  const raw = localStorage.getItem(STORAGE_SPLIT);
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(parsed)) return clamp(0.15, 0.85, parsed);
  return 0.6;
}

function normalizeWindowState(state: Partial<DesktopWindowState>, fallback: DesktopWindowState): DesktopWindowState {
  return {
    x: Number.isFinite(state.x) ? (state.x as number) : fallback.x,
    y: Number.isFinite(state.y) ? (state.y as number) : fallback.y,
    w: Number.isFinite(state.w) ? (state.w as number) : fallback.w,
    h: Number.isFinite(state.h) ? (state.h as number) : fallback.h,
    z: Number.isFinite(state.z) ? (state.z as number) : fallback.z,
    maximized: typeof state.maximized === "boolean" ? state.maximized : fallback.maximized,
    minimized: typeof state.minimized === "boolean" ? state.minimized : false,
    restore: state.restore && typeof state.restore === "object" ? (state.restore as Rect) : null
  };
}

function loadDesktopWindows(): DesktopWindow[] {
  const v2 = localStorage.getItem(STORAGE_DESKTOP_V2);
  if (v2) {
    const parsed = safeJsonParse<{ windows?: Array<Partial<DesktopWindow>> }>(v2);
    if (parsed?.windows && Array.isArray(parsed.windows) && parsed.windows.length) {
      const normalized = parsed.windows
        .map((w) => {
          const kind: WindowKind | null = w?.kind === "vscode" || w?.kind === "terminal" ? w.kind : null;
          if (!kind) return null;
          const id = typeof w?.id === "string" && w.id ? w.id : null;
          if (!id) return null;
          const title = typeof w?.title === "string" && w.title ? w.title : kind === "vscode" ? "VS Code" : "Terminal";
          const fallback = kind === "vscode" ? DEFAULT_WINDOWS[0].state : DEFAULT_WINDOWS[1].state;
          const state = normalizeWindowState((w as DesktopWindow).state || {}, fallback);
          return { id, kind, title, state } satisfies DesktopWindow;
        })
        .filter(Boolean) as DesktopWindow[];

      if (normalized.length) return normalized;
    }
  }

  const v1 = localStorage.getItem(STORAGE_DESKTOP_V1);
  if (v1) {
    const parsed = safeJsonParse<Record<string, Partial<DesktopWindowState>>>(v1);
    if (parsed) {
      return DEFAULT_WINDOWS.map((w) => {
        const maybe = parsed[w.id];
        if (!maybe) return w;
        return { ...w, state: normalizeWindowState(maybe, w.state) };
      });
    }
  }

  return DEFAULT_WINDOWS;
}

function getWindowSrc(win: DesktopWindow) {
  if (win.kind === "vscode") return "/vscode/";
  return win.id === "terminal" ? "/terminal/" : "/terminal-new/";
}

function computeMaxZ(windows: DesktopWindow[]): number {
  return windows.reduce((m, w) => Math.max(m, w.state.z || 0), 10);
}

function clampWindowToWorkspace(win: DesktopWindow, workspaceRect: DOMRect): DesktopWindow {
  if (workspaceRect.width <= 0 || workspaceRect.height <= 0) return win;

  const minW = Math.min(1, DESKTOP_MIN_W_PX / workspaceRect.width);
  const minH = Math.min(1, DESKTOP_MIN_H_PX / workspaceRect.height);

  const w = clamp(minW, 1, win.state.w);
  const h = clamp(minH, 1, win.state.h);
  const x = clamp(0, 1 - w, win.state.x);
  const y = clamp(0, 1 - h, win.state.y);

  return { ...win, state: { ...win.state, x, y, w, h } };
}

function withUpdatedWindow(windows: DesktopWindow[], id: string, fn: (w: DesktopWindow) => DesktopWindow): DesktopWindow[] {
  return windows.map((w) => (w.id === id ? fn(w) : w));
}

function getRuntimeConfig(): RuntimeConfig {
  const raw = (window as unknown as { __HFIDE_RUNTIME_CONFIG__?: RuntimeConfig }).__HFIDE_RUNTIME_CONFIG__;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function getEnvPinHash(runtime: RuntimeConfig): string | null {
  const value = runtime.lock?.pinSha256Base64;
  if (typeof value !== "string") return null;
  if (!value.trim()) return null;
  return value;
}

export default function App() {
  const [runtime] = useState(() => getRuntimeConfig());
  const envPinHash = getEnvPinHash(runtime);
  const pinManagedByEnv = Boolean(envPinHash);
  const lockOnStart = pinManagedByEnv && runtime.lock?.lockOnStart === true;

  const [mode, setMode] = useState<Mode>(() => loadMode());
  const [splitRatio, setSplitRatio] = useState(() => loadSplitRatio());
  const [dockRestoreMode, setDockRestoreMode] = useState<Mode | null>(null);

  const [pinHash, setPinHash] = useState<string | null>(() => (pinManagedByEnv ? envPinHash : localStorage.getItem(STORAGE_PIN_HASH)));

  const [locked, setLocked] = useState(() => {
    if (lockOnStart && envPinHash) return sessionStorage.getItem(STORAGE_SESSION_UNLOCKED) !== envPinHash;
    return localStorage.getItem(STORAGE_LOCKED) === "1";
  });

  const [desktopWindows, setDesktopWindows] = useState<DesktopWindow[]>(() => loadDesktopWindows());
  const desktopWindowsRef = useRef(desktopWindows);
  const zCounterRef = useRef<number>(computeMaxZ(desktopWindows));

  const [lockView, setLockView] = useState<"unlock" | "setpin">(() => (pinHash ? "unlock" : "setpin"));
  const [lockError, setLockError] = useState<string>("");

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [draggingDivider, setDraggingDivider] = useState(false);

  desktopWindowsRef.current = desktopWindows;

  useEffect(() => {
    localStorage.setItem(STORAGE_MODE, mode);
  }, [mode]);

  useEffect(() => {
    const clamped = clamp(0.15, 0.85, splitRatio);
    const pct = `${Math.round(clamped * 1000) / 10}%`;
    document.documentElement.style.setProperty("--split", pct);
    localStorage.setItem(STORAGE_SPLIT, String(clamped));
  }, [splitRatio]);

  useEffect(() => {
    if (pinManagedByEnv) return;
    if (locked) localStorage.setItem(STORAGE_LOCKED, "1");
    else localStorage.removeItem(STORAGE_LOCKED);
  }, [locked, pinManagedByEnv]);

  useEffect(() => {
    if (pinManagedByEnv) return;
    if (pinHash) localStorage.setItem(STORAGE_PIN_HASH, pinHash);
    else localStorage.removeItem(STORAGE_PIN_HASH);
  }, [pinHash, pinManagedByEnv]);

  useEffect(() => {
    if (!locked) return;
    setLockError("");
    if (pinManagedByEnv) setLockView("unlock");
    else setLockView(pinHash ? "unlock" : "setpin");
  }, [locked, pinHash, pinManagedByEnv]);

  useEffect(() => {
    if (!pinManagedByEnv || !lockOnStart) return;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch("/auth/check", { signal: controller.signal, cache: "no-store" });
        if (res.ok) {
          unlockNow();
          return;
        }
        sessionStorage.removeItem(STORAGE_SESSION_UNLOCKED);
        setLocked(true);
      } catch {
        // ignore
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinManagedByEnv, lockOnStart]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "1") setMode("vscode");
      if (e.key === "2") setMode("terminal");
      if (e.key === "3") setMode("split");
      if (e.key === "4") setMode("desktop");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (mode !== "desktop") return;
    const clampAll = () => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDesktopWindows((wins) => wins.map((w) => clampWindowToWorkspace(w, rect)));
    };
    clampAll();
    window.addEventListener("resize", clampAll);
    return () => window.removeEventListener("resize", clampAll);
  }, [mode]);

  const saveScheduledRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveScheduledRef.current != null) return;
    saveScheduledRef.current = window.requestAnimationFrame(() => {
      saveScheduledRef.current = null;
      try {
        localStorage.setItem(STORAGE_DESKTOP_V2, JSON.stringify({ windows: desktopWindowsRef.current }));
      } catch {
        // ignore
      }
    });
  }, [desktopWindows]);

  const vscodeDock = useMemo(() => desktopWindows.find((w) => w.id === "vscode") || DEFAULT_WINDOWS[0], [desktopWindows]);
  const terminalDock = useMemo(() => desktopWindows.find((w) => w.id === "terminal") || DEFAULT_WINDOWS[1], [desktopWindows]);

  function lockNow() {
    setLocked(true);
    if (lockOnStart) sessionStorage.removeItem(STORAGE_SESSION_UNLOCKED);
    if (pinManagedByEnv && lockOnStart) {
      fetch("/auth/logout", { method: "POST", cache: "no-store" }).catch(() => undefined);
    }
  }

  function unlockNow() {
    setLocked(false);
    setLockError("");
    if (lockOnStart && envPinHash) sessionStorage.setItem(STORAGE_SESSION_UNLOCKED, envPinHash);
  }

  function resetLocalPinAndUnlock() {
    if (pinManagedByEnv) return;
    const ok = window.confirm("Reset PIN and unlock? This only affects this browser.");
    if (!ok) return;
    setPinHash(null);
    unlockNow();
  }

  function focusWindow(id: string) {
    zCounterRef.current += 1;
    const z = zCounterRef.current;
    setDesktopWindows((wins) => withUpdatedWindow(wins, id, (w) => ({ ...w, state: { ...w.state, z } })));
  }

  function minimizeWindow(id: string) {
    if (mode !== "desktop") return;
    setDesktopWindows((wins) => withUpdatedWindow(wins, id, (w) => ({ ...w, state: { ...w.state, minimized: true } })));
  }

  function restoreWindow(id: string) {
    setDesktopWindows((wins) => withUpdatedWindow(wins, id, (w) => ({ ...w, state: { ...w.state, minimized: false } })));
    setMode("desktop");
    focusWindow(id);
  }

  function toggleDockMax(kind: WindowKind) {
    if (mode === "desktop") return;

    if (mode === "split") {
      setDockRestoreMode("split");
      setMode(kind);
      return;
    }

    if (mode === kind && dockRestoreMode) {
      setMode(dockRestoreMode);
      setDockRestoreMode(null);
    }
  }

  function getMaxLabel(win: DesktopWindow) {
    if (mode === "desktop") return win.state.maximized ? "Restore" : "Max";
    if (mode === win.kind && dockRestoreMode) return "Restore";
    return "Max";
  }

  function onMaxPressed(win: DesktopWindow) {
    if (mode === "desktop") toggleMaximize(win.id);
    else toggleDockMax(win.kind);
  }

  function toggleMaximize(id: string) {
    if (mode !== "desktop") return;
    if (locked) return;
    setDesktopWindows((wins) =>
      withUpdatedWindow(wins, id, (w) => {
        if (!w.state.maximized) {
          return {
            ...w,
            state: { ...w.state, restore: { x: w.state.x, y: w.state.y, w: w.state.w, h: w.state.h }, x: 0, y: 0, w: 1, h: 1, maximized: true }
          };
        }

        if (!w.state.restore) return { ...w, state: { ...w.state, maximized: false, restore: null } };
        const r = w.state.restore;
        return { ...w, state: { ...w.state, x: r.x, y: r.y, w: r.w, h: r.h, maximized: false, restore: null } };
      })
    );
    focusWindow(id);
  }

  function startDragWindow(e: React.PointerEvent, id: string) {
    if (mode !== "desktop") return;
    if (locked) return;
    const handle = e.currentTarget as HTMLElement;
    const win = desktopWindowsRef.current.find((w) => w.id === id);
    if (!win) return;
    if (win.state.maximized) return;

    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return;

    focusWindow(id);
    const pointerId = e.pointerId;
    const start = { x: win.state.x, y: win.state.y, px: e.clientX, py: e.clientY, ww: rect.width, hh: rect.height };

    handle.setPointerCapture(pointerId);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = (ev.clientX - start.px) / start.ww;
      const dy = (ev.clientY - start.py) / start.hh;
      const nextX = start.x + dx;
      const nextY = start.y + dy;
      setDesktopWindows((wins) => {
        const wsRect = workspaceRef.current?.getBoundingClientRect();
        if (!wsRect) return wins;
        return withUpdatedWindow(wins, id, (w) => clampWindowToWorkspace({ ...w, state: { ...w.state, x: nextX, y: nextY } }, wsRect));
      });
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function startResizeWindow(e: React.PointerEvent, id: string) {
    if (mode !== "desktop") return;
    if (locked) return;
    const handle = e.currentTarget as HTMLElement;
    const win = desktopWindowsRef.current.find((w) => w.id === id);
    if (!win) return;
    if (win.state.maximized) return;

    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return;

    focusWindow(id);
    const pointerId = e.pointerId;
    const start = { w: win.state.w, h: win.state.h, px: e.clientX, py: e.clientY, ww: rect.width, hh: rect.height };

    handle.setPointerCapture(pointerId);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dw = (ev.clientX - start.px) / start.ww;
      const dh = (ev.clientY - start.py) / start.hh;
      const nextW = start.w + dw;
      const nextH = start.h + dh;
      setDesktopWindows((wins) => {
        const wsRect = workspaceRef.current?.getBoundingClientRect();
        if (!wsRect) return wins;
        return withUpdatedWindow(wins, id, (w) => clampWindowToWorkspace({ ...w, state: { ...w.state, w: nextW, h: nextH } }, wsRect));
      });
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function openNewTerminalWindow() {
    const id = `terminal-${Date.now().toString(36)}`;
    const nextZ = zCounterRef.current + 1;
    zCounterRef.current = nextZ;
    const existingCount = desktopWindowsRef.current.filter((w) => w.kind === "terminal").length;
    const offset = existingCount * 0.03;
    const title = `Terminal ${existingCount + 1}`;

    setDesktopWindows((wins) => [
      ...wins,
      {
        id,
        kind: "terminal",
        title,
        state: { x: clamp(0, 0.8, 0.08 + offset), y: clamp(0, 0.8, 0.1 + offset), w: 0.48, h: 0.62, z: nextZ, maximized: false, minimized: false, restore: null }
      }
    ]);
    setMode("desktop");
  }

  async function submitUnlock(pin: string) {
    setLockError("");
    const trimmed = pin.trim();
    if (!trimmed) return setLockError("Enter PIN.");
    if (!pinHash) {
      if (pinManagedByEnv) return setLockError("PIN is managed by the container.");
      setLockView("setpin");
      return;
    }

    if (pinManagedByEnv && lockOnStart) {
      try {
        const res = await fetch("/auth/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ pin: trimmed })
        });
        if (!res.ok) return setLockError("Incorrect PIN.");
        unlockNow();
      } catch {
        setLockError("Unlock failed.");
      }
      return;
    }

    try {
      const hash = await sha256Base64(trimmed);
      if (hash !== pinHash) return setLockError("Incorrect PIN.");
      unlockNow();
    } catch {
      setLockError("Unlock failed.");
    }
  }

  async function submitSetPin(a: string, b: string) {
    if (pinManagedByEnv) return;

    setLockError("");
    const pinA = a.trim();
    const pinB = b.trim();
    if (pinA.length < 4) return setLockError("PIN must be at least 4 digits.");
    if (pinA !== pinB) return setLockError("PINs do not match.");

    try {
      const hash = await sha256Base64(pinA);
      setPinHash(hash);
      setLockView("unlock");
      setLockError("PIN set. Locked.");
    } catch {
      setLockError("Failed to set PIN.");
    }
  }

  function renderWindowBody(win: DesktopWindow, iframeLoading: "eager" | "lazy") {
    if (locked) return <div className="window-placeholder">Locked</div>;
    return <iframe title={win.title} src={getWindowSrc(win)} loading={iframeLoading}></iframe>;
  }

  function renderDockWindow(win: DesktopWindow, hidden: boolean, iframeLoading: "eager" | "lazy") {
    return (
      <section id={`win-${win.id}`} className="window" data-window={win.kind} hidden={hidden}>
        <div className="window-header" data-drag-handle={win.id}>
          <div className="window-title">{win.title}</div>
          <div className="window-actions">
            <button className="window-btn" type="button" onClick={() => onMaxPressed(win)} title="Maximize / Restore">
              {getMaxLabel(win)}
            </button>
          </div>
        </div>
        <div className="window-body">{renderWindowBody(win, iframeLoading)}</div>
        <div className="resize-handle" data-resize-handle={win.id} title="Resize"></div>
      </section>
    );
  }

  function renderDesktopWindow(win: DesktopWindow) {
    const s = win.state;
    const style: React.CSSProperties = {
      left: `${(s.x * 100).toFixed(3)}%`,
      top: `${(s.y * 100).toFixed(3)}%`,
      width: `${(s.w * 100).toFixed(3)}%`,
      height: `${(s.h * 100).toFixed(3)}%`,
      zIndex: s.z || 1
    };

    return (
      <section key={win.id} className="window" data-window={win.kind} style={style} hidden={win.state.minimized} onPointerDown={() => focusWindow(win.id)}>
        <div
          className="window-header"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement | null)?.closest("button")) return;
            e.stopPropagation();
            startDragWindow(e, win.id);
          }}
        >
          <div className="window-title">{win.title}</div>
          <div className="window-actions">
            <button
              className="window-btn"
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => minimizeWindow(win.id)}
              title="Minimize"
            >
              Min
            </button>
            <button
              className="window-btn"
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onMaxPressed(win)}
              title="Maximize / Restore"
            >
              {getMaxLabel(win)}
            </button>
          </div>
        </div>
        <div className="window-body">{renderWindowBody(win, win.kind === "vscode" ? "eager" : "lazy")}</div>
        <div
          className="resize-handle"
          onPointerDown={(e) => {
            e.stopPropagation();
            startResizeWindow(e, win.id);
          }}
          title="Resize"
        ></div>
      </section>
    );
  }

  return (
    <div id="app" data-mode={mode} data-locked={locked ? "true" : undefined}>
      <header id="taskbar">
        <div className="brand">HF Web IDE</div>
        <nav className="tabs" role="tablist" aria-label="Views">
          <button className="tab" role="tab" aria-selected={mode === "vscode"} onClick={() => setMode("vscode")}>
            VS Code
          </button>
          <button className="tab" role="tab" aria-selected={mode === "terminal"} onClick={() => setMode("terminal")}>
            Terminal
          </button>
          <button className="tab" role="tab" aria-selected={mode === "split"} onClick={() => setMode("split")}>
            Split
          </button>
          <button className="tab" role="tab" aria-selected={mode === "desktop"} onClick={() => setMode("desktop")}>
            Desktop
          </button>
        </nav>
        <div className="minimized-bar" aria-label="Minimized windows">
          {desktopWindows
            .filter((w) => w.state.minimized)
            .map((w) => (
              <button key={w.id} className="min-chip" type="button" onClick={() => restoreWindow(w.id)} title={`Restore ${w.title}`}>
                {w.title}
              </button>
            ))}
        </div>
        <div className="right">
          <button className="action" type="button" onClick={() => openNewTerminalWindow()} title="Open another Terminal window">
            + Terminal
          </button>
          <button className="action" type="button" onClick={() => lockNow()}>
            Lock
          </button>
          <a className="link" href="/healthz" target="_blank" rel="noreferrer">
            health
          </a>
        </div>
      </header>

      <main id="workspace" ref={workspaceRef} aria-label="Desktop">
        {mode === "desktop" ? (
          <>{desktopWindows.map((w) => renderDesktopWindow(w))}</>
        ) : (
          <>
            {renderDockWindow(vscodeDock, mode === "terminal", "eager")}
            <div
              id="divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize split"
              onPointerDown={(e) => {
                if (mode !== "split") return;
                setDraggingDivider(true);
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
              }}
              onPointerUp={() => setDraggingDivider(false)}
              onPointerCancel={() => setDraggingDivider(false)}
              onPointerMove={(e) => {
                if (!draggingDivider) return;
                if (mode !== "split") return;
                const rect = workspaceRef.current?.getBoundingClientRect();
                if (!rect || rect.width <= 0) return;
                const ratio = (e.clientX - rect.left) / rect.width;
                setSplitRatio(ratio);
              }}
            ></div>
            {renderDockWindow(terminalDock, mode === "vscode", "lazy")}
          </>
        )}
      </main>

      {locked ? (
        <div id="lock-overlay">
          <LockDialog
            view={lockView}
            error={lockError}
            pinManagedByEnv={pinManagedByEnv}
            onUnlock={submitUnlock}
            onSetPin={submitSetPin}
            onShowSetPin={() => setLockView("setpin")}
            onReset={resetLocalPinAndUnlock}
          />
        </div>
      ) : null}
    </div>
  );
}

function LockDialog(props: {
  view: "unlock" | "setpin";
  error: string;
  pinManagedByEnv: boolean;
  onUnlock: (pin: string) => void;
  onSetPin: (a: string, b: string) => void;
  onShowSetPin: () => void;
  onReset: () => void;
}) {
  const [unlockPin, setUnlockPin] = useState("");
  const [pinA, setPinA] = useState("");
  const [pinB, setPinB] = useState("");

  const view = props.pinManagedByEnv ? "unlock" : props.view;

  return (
    <div className="lock-card" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <h1 id="lock-title">Locked</h1>
      <p className="lock-subtitle">Your session keeps running in the background.</p>

      <div id="lock-error" className="lock-error" role="status" aria-live="polite">
        {props.error || ""}
      </div>

      {view === "unlock" ? (
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onUnlock(unlockPin);
          }}
        >
          <label className="lock-label">
            <span className="sr-only">PIN</span>
            <input
              className="lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              placeholder="Enter PIN"
              value={unlockPin}
              onChange={(e) => setUnlockPin(e.target.value)}
              autoFocus
            />
          </label>
          <button className="lock-primary" type="submit">
            Unlock
          </button>
        </form>
      ) : (
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSetPin(pinA, pinB);
          }}
        >
          <label className="lock-label">
            <span className="sr-only">New PIN</span>
            <input
              className="lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="New PIN (min 4 digits)"
              value={pinA}
              onChange={(e) => setPinA(e.target.value)}
              autoFocus
            />
          </label>
          <label className="lock-label">
            <span className="sr-only">Confirm PIN</span>
            <input
              className="lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="Confirm PIN"
              value={pinB}
              onChange={(e) => setPinB(e.target.value)}
            />
          </label>
          <button className="lock-primary" type="submit">
            Set PIN
          </button>
        </form>
      )}

      {!props.pinManagedByEnv ? (
        <>
          <div className="lock-row">
            <button className="lock-secondary" type="button" onClick={() => props.onShowSetPin()}>
              Set / Change PIN
            </button>
            <button className="lock-secondary" type="button" onClick={() => props.onReset()}>
              Reset
            </button>
          </div>
          <p className="lock-hint">Reset clears this browser's saved PIN.</p>
        </>
      ) : (
        <p className="lock-hint">PIN is configured by the container.</p>
      )}
    </div>
  );
}
