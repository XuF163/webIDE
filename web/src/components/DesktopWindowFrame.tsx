import React from "react";
import { DesktopWindow, WindowKind } from "../App";

interface DesktopWindowFrameProps {
    win: DesktopWindow;
    isActive: boolean;
    isMinimizing: boolean;
    onFocus: () => void;
    onMinimize: () => void;
    onMaximize: () => void;
    onClose: () => void;
    onDragStart: (e: React.PointerEvent) => void;
    onResizeStart: (e: React.PointerEvent) => void;
    children: React.ReactNode;
}

export default function DesktopWindowFrame({
    win,
    isActive,
    isMinimizing,
    onFocus,
    onMinimize,
    onMaximize,
    onClose,
    onDragStart,
    onResizeStart,
    children
}: DesktopWindowFrameProps) {
    const s = win.state;
    const style: React.CSSProperties = {
        left: `${(s.x * 100).toFixed(3)}%`,
        top: `${(s.y * 100).toFixed(3)}%`,
        width: `${(s.w * 100).toFixed(3)}%`,
        height: `${(s.h * 100).toFixed(3)}%`,
        zIndex: s.z || 1,
        visibility: win.state.minimized ? "hidden" : "visible",
        opacity: win.state.minimized ? 0 : 1,
        pointerEvents: win.state.minimized ? "none" : "auto",
        display: "flex"
    };

    const getMaxLabel = () => (win.state.maximized ? "\u2752" : "\u25a1");

    return (
        <section
            id={`win-${win.id}`}
            className="window"
            data-window={win.kind}
            style={style}
            onPointerDown={onFocus}
        >
            <div
                className="window-header"
                onPointerDown={(e) => {
                    if ((e.target as HTMLElement | null)?.closest("button")) return;
                    e.stopPropagation();
                    onDragStart(e);
                }}
                data-active={isActive}
            >
                <div className="window-title">{win.title}</div>
                <div className="window-actions">
                    <button
                        className="window-btn"
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={onMinimize}
                        title="Minimize"
                    >
                        &#x2500;
                    </button>
                    <button
                        className="window-btn"
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={onMaximize}
                        title="Maximize / Restore"
                    >
                        {getMaxLabel()}
                    </button>
                    <button
                        className="close-btn"
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={onClose}
                        title="Close"
                    >
                        &#x2715;
                    </button>
                </div>
            </div>
            <div className="window-body">{children}</div>
            <div
                className="resize-handle"
                onPointerDown={(e) => {
                    e.stopPropagation();
                    onResizeStart(e);
                }}
                title="Resize"
            ></div>
        </section>
    );
}
