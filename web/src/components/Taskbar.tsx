import React, { useMemo } from "react";
import { DesktopWindow, Mode } from "../App";

interface TaskbarProps {
    mode: Mode;
    desktopWindows: DesktopWindow[];
    activeWindowId: string | null;
    onTaskbarClick: (id: string) => void;
    activateMode: (mode: Mode) => void;
    openNewTerminalWindow: () => void;
    lockNow: () => void;
    clockTime: Date;
}

export default function Taskbar({
    mode,
    desktopWindows,
    activeWindowId,
    onTaskbarClick,
    activateMode,
    openNewTerminalWindow,
    lockNow,
    clockTime
}: TaskbarProps) {
    const mountedWindowIds = useMemo(() => new Set(desktopWindows.map((w) => w.id)), [desktopWindows]);

    return (
        <header id="taskbar">
            {/* Windows 四格图标 */}
            <div className="brand" title="Windows">
                <svg viewBox="0 0 16 16" fill="currentColor">
                    <rect x="1" y="1" width="6.5" height="6.5" />
                    <rect x="8.5" y="1" width="6.5" height="6.5" />
                    <rect x="1" y="8.5" width="6.5" height="6.5" />
                    <rect x="8.5" y="8.5" width="6.5" height="6.5" />
                </svg>
            </div>
            <nav className="tabs" role="tablist" aria-label="Views">
                <button
                    className="tab"
                    role="tab"
                    aria-selected={mode === "vscode" || activeWindowId === "vscode"}
                    onClick={() => onTaskbarClick("vscode")}
                >
                    VS Code
                </button>
                <button
                    className="tab"
                    role="tab"
                    aria-selected={mode === "terminal" || activeWindowId === "terminal"}
                    onClick={() => onTaskbarClick("terminal")}
                >
                    Terminal
                </button>
                <button
                    className="tab"
                    role="tab"
                    aria-selected={mode === "files" || activeWindowId === "files"}
                    onClick={() => onTaskbarClick("files")}
                >
                    Files
                </button>
            </nav>
            <div className="minimized-bar" aria-label="Minimized windows">
                {desktopWindows
                    .filter((w) => w.state.minimized && !["vscode", "terminal", "files"].includes(w.id))
                    .map((w) => (
                        <button key={w.id} className="min-chip" type="button" onClick={() => onTaskbarClick(w.id)} title={`Restore ${w.title}`}>
                            {w.title}
                        </button>
                    ))}
            </div>
            <div className="right">
                <button className="action" type="button" onClick={() => openNewTerminalWindow()} title="Open another Terminal window">
                    + Terminal
                </button>
                <button className="action" type="button" onClick={() => lockNow()}>
                    &#x1F512;
                </button>
                <div className="tray-clock">{clockTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                <button
                    className="action desktop-btn"
                    type="button"
                    aria-selected={mode === "desktop"}
                    onClick={() => activateMode("desktop")}
                    title="Desktop"
                >
                    Desktop
                </button>
            </div>
        </header>
    );
}
