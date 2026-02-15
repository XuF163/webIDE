import React, { useEffect, useState } from "react";

interface TextEditorProps {
    rootId: string;
    path: string;
    onClose?: () => void;
}

export default function TextEditor({ rootId, path }: TextEditorProps) {
    const [content, setContent] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError("");

        (async () => {
            try {
                const res = await fetch(
                    `/api/fs/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
                    { signal: controller.signal, cache: "no-store" }
                );
                if (!res.ok) throw new Error(`Failed to load file: ${res.statusText}`);
                const text = await res.text();
                setContent(text);
            } catch (e: any) {
                if (controller.signal.aborted) return;
                setError(e.message || "Failed to load file.");
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [rootId, path]);

    async function save() {
        setSaving(true);
        setStatus("Saving...");
        try {
            const res = await fetch(
                `/api/fs/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: content
                }
            );
            if (!res.ok) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const data = await res.json().catch(() => null) as any;
                throw new Error(data?.message || `Save failed: ${res.status}`);
            }
            setStatus("Saved!");
            setTimeout(() => setStatus(""), 2000);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            setError(e.message || "Failed to save.");
            setStatus("Error");
        } finally {
            setSaving(false);
        }
    }

    function onKeyDown(e: React.KeyboardEvent) {
        if (e.ctrlKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
        }
    }

    if (loading) return <div className="editor-loading">Loading...</div>;

    return (
        <div className="text-editor" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="editor-toolbar" style={{ padding: "4px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "8px", background: "var(--bg-secondary)" }}>
                <button className="editor-btn primary" onClick={() => void save()} disabled={saving} style={{ padding: "4px 8px" }}>
                    {saving ? "Saving..." : "Save"}
                </button>
                <span className="file-path" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.7 }}>{path}</span>
                <span className="editor-status" style={{ fontSize: "12px", opacity: 0.8 }}>{error || status}</span>
            </div>
            <textarea
                className="editor-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                style={{ flex: 1, resize: "none", border: "none", padding: "8px", outline: "none", background: "var(--bg)", color: "var(--fg)", fontFamily: "monospace" }}
            />
        </div>
    );
}
