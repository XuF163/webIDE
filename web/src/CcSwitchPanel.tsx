import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

type View = "providers" | "mcp" | "skills";
type AppType = "claude" | "codex" | "gemini";
type AuthMode = "oauth" | "api_key";

type ProviderProfile = {
  id: string;
  app: AppType;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  authMode: AuthMode;
};

type ActiveByApp = { claude?: string; codex?: string; gemini?: string };
type ExportPayload = { version: 1; providers: ProviderProfile[]; activeByApp: ActiveByApp };

type McpServer = {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
};

type FsEntryKind = "dir" | "file" | "symlink" | "other";
type FsEntry = { name: string; kind: FsEntryKind; size: number | null; mtimeMs: number };
type SkillItem = { id: string; name: string; path: string; docPath: string; kind: "dir" | "file" };

type FsOk<T> = { ok: true } & T;
type FsErr = { ok: false; code?: string; message?: string };
type FsResponse<T> = FsOk<T> | FsErr;

type McpExportPayload = { version: 1; mcpServers: Record<string, unknown> };
type SkillsExportPayload = { version: 1; skills: Array<{ name: string; content: string }> };

type CcSwitchStateFile = { version: 1; providers: ProviderProfile[]; activeByApp: ActiveByApp };

const LEGACY_STORAGE_PROVIDERS = "hfide.ccswitch.providers.v1";
const LEGACY_STORAGE_ACTIVE = "hfide.ccswitch.active.v1";
const CC_SWITCH_STATE_PATH = ".hfide/ccswitch/state.json";
const CLAUDE_MCP_PATH = ".claude.json";
const CLAUDE_SKILLS_PATH = ".claude/skills";

const DEFAULTS: ProviderProfile[] = [
  { id: "claude-official", app: "claude", name: "Claude Official", baseUrl: "", apiKey: "", model: "", authMode: "oauth" },
  { id: "codex-official", app: "codex", name: "OpenAI Official", baseUrl: "", apiKey: "", model: "", authMode: "api_key" },
  { id: "gemini-official", app: "gemini", name: "Google Official", baseUrl: "", apiKey: "", model: "", authMode: "oauth" }
];
const APPS: AppType[] = ["claude", "codex", "gemini"];
const APP_LABEL: Record<AppType, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const APP_MARK: Record<AppType, string> = { claude: "\u273A", codex: "\u25CC", gemini: "\u2726" };

const PRESETS: Array<{ id: string; label: string; app: AppType; baseUrl: string; model: string; authMode: AuthMode }> = [
  { id: "claude-official", label: "Claude Official", app: "claude", baseUrl: "", model: "", authMode: "oauth" },
  { id: "codex-official", label: "OpenAI Official", app: "codex", baseUrl: "", model: "gpt-5.1-codex", authMode: "api_key" },
  { id: "gemini-official", label: "Gemini Official", app: "gemini", baseUrl: "", model: "gemini-2.0-flash", authMode: "oauth" },
  { id: "deepseek", label: "DeepSeek", app: "codex", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", authMode: "api_key" },
  { id: "qwen", label: "Qwen", app: "codex", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", authMode: "api_key" },
  { id: "glm", label: "GLM", app: "codex", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5", authMode: "api_key" },
  { id: "kimi", label: "Kimi", app: "codex", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", authMode: "api_key" }
];

function defaultDraft(app: AppType): ProviderProfile {
  return {
    id: "",
    app,
    name: `${APP_LABEL[app]} Custom`,
    baseUrl: "",
    apiKey: "",
    model: app === "codex" ? "gpt-5.1-codex" : "",
    authMode: app === "gemini" ? "oauth" : "api_key"
  };
}

function hostLabel(baseUrl: string) {
  const value = baseUrl.trim();
  if (!value) return "Official endpoint";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function decodeProviders(raw: unknown): ProviderProfile[] {
  if (!Array.isArray(raw)) return DEFAULTS;
  const out: ProviderProfile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const app = obj.app === "claude" || obj.app === "codex" || obj.app === "gemini" ? obj.app : null;
    const authMode = obj.authMode === "oauth" ? "oauth" : "api_key";
    if (!app) continue;

    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id) continue;

    out.push({
      id,
      app,
      name: typeof obj.name === "string" ? obj.name : "",
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : "",
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : "",
      model: typeof obj.model === "string" ? obj.model : "",
      authMode
    });
  }
  return out.length ? out : DEFAULTS;
}

function decodeActiveByApp(raw: unknown): ActiveByApp {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: ActiveByApp = {};
  for (const app of APPS) {
    const val = obj[app];
    if (typeof val === "string" && val.trim()) out[app] = val.trim();
  }
  return out;
}

function readLegacyStateFromLocalStorage(): { providers: ProviderProfile[]; activeByApp: ActiveByApp } | null {
  if (typeof localStorage === "undefined") return null;
  const rawProviders = localStorage.getItem(LEGACY_STORAGE_PROVIDERS);
  const rawActive = localStorage.getItem(LEGACY_STORAGE_ACTIVE);
  if (!rawProviders && !rawActive) return null;

  const providers = rawProviders ? decodeProviders(parseJson<unknown>(rawProviders)) : DEFAULTS;
  const activeByApp = rawActive ? decodeActiveByApp(parseJson<unknown>(rawActive)) : {};
  return { providers, activeByApp };
}

function clearLegacyLocalStorage() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_STORAGE_PROVIDERS);
  localStorage.removeItem(LEGACY_STORAGE_ACTIVE);
}

function makeId(prefix: string, name: string) {
  const base = `${prefix}-${name}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return base || `${prefix}-${Date.now().toString(36)}`;
}

function nonEmptyLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function envToLines(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, val]) => key && typeof val === "string")
    .map(([key, val]) => `${key}=${val as string}`)
    .join("\n");
}

function linesToEnv(text: string) {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function skillTemplate(name: string) {
  return `# ${name}\n\n## Purpose\n- Describe what this skill does.\n\n## Usage\n- Add actionable steps.\n`;
}

function downloadTextFile(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function loadProviders() {
  return DEFAULTS;
}

function loadActive() {
  return {};
}

async function readFsJson(root: string, path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const raw = await res.text().catch(() => "");
  const parsed = raw ? parseJson<Record<string, unknown>>(raw) : null;
  return parsed && typeof parsed === "object" ? parsed : null;
}

async function readFsText(root: string, path: string) {
  const res = await fetch(`/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return await res.text().catch(() => "");
}

async function writeFsText(root: string, path: string, content: string) {
  const res = await fetch(`/api/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { method: "PUT", cache: "no-store", body: content });
  if (!res.ok) throw new Error(`Write failed: ${path}`);
}

async function fsJson<T>(url: string, init?: RequestInit): Promise<FsResponse<T>> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => null)) as FsResponse<T> | null;
  if (!data || typeof data !== "object") return { ok: false, code: "bad_json", message: "Bad JSON response." };
  return data;
}

function codexToml(provider: ProviderProfile) {
  if (!provider.baseUrl.trim()) return provider.model.trim() ? `model = "${provider.model.trim()}"\n` : "";
  const key = provider.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "custom";
  const model = provider.model.trim() || "gpt-5.1-codex";
  return `model_provider = "${key}"\nmodel = "${model}"\n\n[model_providers.${key}]\nname = "${key}"\nbase_url = "${provider.baseUrl.trim()}"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
}

export default function CcSwitchPanel() {
  const [view, setView] = useState<View>("providers");
  const [providers, setProviders] = useState<ProviderProfile[]>(() => loadProviders());
  const [activeByApp, setActiveByApp] = useState<ActiveByApp>(() => loadActive());
  const [stateLoaded, setStateLoaded] = useState(false);
  const [activeApp, setActiveApp] = useState<AppType>("claude");
  const [selectedId, setSelectedId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<ProviderProfile>(() => defaultDraft("claude"));
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpSelectedId, setMcpSelectedId] = useState("");
  const [mcpBaseConfig, setMcpBaseConfig] = useState<Record<string, unknown>>({});
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillSelectedId, setSkillSelectedId] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [skillDirty, setSkillDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const autoLoadedMcpRef = useRef(false);
  const autoLoadedSkillsRef = useRef(false);
  const mcpImportRef = useRef<HTMLInputElement | null>(null);
  const skillsImportRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await readFsText("home", CC_SWITCH_STATE_PATH);
        const parsed = raw ? parseJson<CcSwitchStateFile>(raw) : null;
        if (parsed && parsed.version === 1) {
          if (!cancelled) {
            setProviders(decodeProviders(parsed.providers));
            setActiveByApp(decodeActiveByApp(parsed.activeByApp));
          }
          return;
        }

        const legacy = readLegacyStateFromLocalStorage();
        if (legacy) {
          if (!cancelled) {
            setProviders(legacy.providers);
            setActiveByApp(legacy.activeByApp);
          }
          const payload: CcSwitchStateFile = { version: 1, providers: legacy.providers, activeByApp: legacy.activeByApp };
          await writeFsText("home", CC_SWITCH_STATE_PATH, JSON.stringify(payload, null, 2));
          clearLegacyLocalStorage();
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setStateLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!stateLoaded) return;
    const timer = window.setTimeout(() => {
      const payload: CcSwitchStateFile = { version: 1, providers, activeByApp };
      void writeFsText("home", CC_SWITCH_STATE_PATH, JSON.stringify(payload, null, 2)).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [providers, activeByApp, stateLoaded]);

  useEffect(() => {
    if (view !== "mcp") return;
    if (autoLoadedMcpRef.current) return;
    autoLoadedMcpRef.current = true;
    void loadMcp();
  }, [view]);

  useEffect(() => {
    if (view !== "skills") return;
    if (autoLoadedSkillsRef.current) return;
    autoLoadedSkillsRef.current = true;
    void refreshSkills();
  }, [view]);

  useEffect(() => {
    if (selectedId && providers.some((p) => p.id === selectedId)) return;
    setSelectedId(providers[0]?.id || "");
  }, [providers, selectedId]);

  useEffect(() => {
    if (mcpSelectedId && mcpServers.some((m) => m.id === mcpSelectedId)) return;
    setMcpSelectedId(mcpServers[0]?.id || "");
  }, [mcpServers, mcpSelectedId]);

  useEffect(() => {
    if (skillSelectedId && skills.some((s) => s.id === skillSelectedId)) return;
    setSkillSelectedId(skills[0]?.id || "");
  }, [skills, skillSelectedId]);

  const selected = useMemo(() => providers.find((p) => p.id === selectedId) || null, [providers, selectedId]);
  const selectedMcp = useMemo(() => mcpServers.find((m) => m.id === mcpSelectedId) || null, [mcpServers, mcpSelectedId]);
  const selectedSkill = useMemo(() => skills.find((s) => s.id === skillSelectedId) || null, [skills, skillSelectedId]);
  const grouped = useMemo(
    () => ({
      claude: providers.filter((p) => p.app === "claude"),
      codex: providers.filter((p) => p.app === "codex"),
      gemini: providers.filter((p) => p.app === "gemini")
    }),
    [providers]
  );
  const providersInActiveApp = grouped[activeApp];
  const selectedInActiveApp = useMemo(() => {
    if (selected && selected.app === activeApp) return selected;
    const activeId = activeByApp[activeApp];
    if (activeId) {
      const active = providersInActiveApp.find((p) => p.id === activeId);
      if (active) return active;
    }
    return providersInActiveApp[0] || null;
  }, [selected, activeApp, activeByApp, providersInActiveApp]);
  const presetsForDraftApp = useMemo(() => PRESETS.filter((preset) => preset.app === createDraft.app), [createDraft.app]);

  useEffect(() => {
    if (providers.some((p) => p.app === activeApp)) return;
    const fallback = APPS.find((app) => providers.some((p) => p.app === app));
    if (fallback) setActiveApp(fallback);
  }, [providers, activeApp]);

  useEffect(() => {
    if (view !== "providers") return;
    if (!selectedInActiveApp) return;
    if (selectedInActiveApp.id === selectedId) return;
    setSelectedId(selectedInActiveApp.id);
  }, [view, selectedInActiveApp, selectedId]);

  function patchSelected(patch: Partial<ProviderProfile>) {
    if (!selectedInActiveApp) return;
    setProviders((prev) => prev.map((p) => (p.id === selectedInActiveApp.id ? { ...p, ...patch } : p)));
  }

  async function applyProvider(provider: ProviderProfile) {
    if (provider.app === "claude") {
      const env: Record<string, string> = {};
      if (provider.baseUrl.trim()) env.ANTHROPIC_BASE_URL = provider.baseUrl.trim();
      if (provider.authMode === "api_key" && provider.apiKey.trim()) env.ANTHROPIC_AUTH_TOKEN = provider.apiKey.trim();
      if (provider.model.trim()) env.ANTHROPIC_MODEL = provider.model.trim();
      await writeFsText("home", ".claude/settings.json", JSON.stringify({ env }, null, 2));
      return;
    }

    if (provider.app === "codex") {
      const auth: Record<string, string> = provider.apiKey.trim() ? { OPENAI_API_KEY: provider.apiKey.trim() } : {};
      await writeFsText("home", ".codex/auth.json", JSON.stringify(auth, null, 2));
      await writeFsText("home", ".codex/config.toml", codexToml(provider));
      return;
    }

    const env: Record<string, string> = {};
    if (provider.authMode === "api_key" && provider.apiKey.trim()) env.GEMINI_API_KEY = provider.apiKey.trim();
    if (provider.baseUrl.trim()) env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl.trim();
    if (provider.model.trim()) env.GEMINI_MODEL = provider.model.trim();
    await writeFsText("home", ".gemini/.env", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    const settings = (await readFsJson("home", ".gemini/settings.json")) || {};
    const sec = (settings.security as Record<string, unknown> | undefined) || {};
    const auth = (sec.auth as Record<string, unknown> | undefined) || {};
    auth.selectedType = provider.authMode === "oauth" ? "oauth-personal" : "gemini-api-key";
    sec.auth = auth;
    settings.security = sec;
    await writeFsText("home", ".gemini/settings.json", JSON.stringify(settings, null, 2));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setCreateDraft(defaultDraft(activeApp));
    setCreateOpen(true);
  }

  function applyPresetToDraft(presetId: string) {
    const preset = PRESETS.find((item) => item.id === presetId && item.app === createDraft.app);
    if (!preset) return;
    setCreateDraft((prev) => ({
      ...prev,
      name: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
      authMode: preset.authMode
    }));
  }

  function createProvider() {
    const name = createDraft.name.trim() || `${APP_LABEL[createDraft.app]} Custom`;
    const next: ProviderProfile = {
      ...createDraft,
      id: makeId(createDraft.app, name),
      name
    };
    setProviders((prev) => [next, ...prev]);
    setActiveApp(next.app);
    setSelectedId(next.id);
    setCreateOpen(false);
    setStatus(`Created ${next.name}.`);
  }

  function handleTopCreate() {
    if (view === "providers") {
      openCreate();
      return;
    }
    if (view === "mcp") {
      setMcpServers((prev) => [{ id: makeId("mcp", "server"), name: `server-${prev.length + 1}`, command: "", args: "", env: "", enabled: true }, ...prev]);
      return;
    }
    void createSkill();
  }

  function decodeMcp(raw: unknown): McpServer[] {
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw as Record<string, unknown>)
      .map(([name, value]) => {
        if (!value || typeof value !== "object") return null;
        const obj = value as Record<string, unknown>;
        return {
          id: makeId("mcp", name),
          name,
          command: typeof obj.command === "string" ? obj.command : "",
          args: Array.isArray(obj.args) ? obj.args.filter((x) => typeof x === "string").join("\n") : "",
          env: envToLines(obj.env),
          enabled: obj.disabled !== true
        } satisfies McpServer;
      })
      .filter(Boolean) as McpServer[];
  }

  function encodeMcp(items: McpServer[]) {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const item of items) {
      const name = item.name.trim();
      const command = item.command.trim();
      if (!name) throw new Error("MCP server name cannot be empty.");
      if (!command) throw new Error(`MCP server \"${name}\" requires command.`);
      if (seen.has(name)) throw new Error(`Duplicate MCP server: ${name}`);
      seen.add(name);
      const node: Record<string, unknown> = { command };
      const args = nonEmptyLines(item.args);
      const env = linesToEnv(item.env);
      if (args.length) node.args = args;
      if (Object.keys(env).length) node.env = env;
      if (!item.enabled) node.disabled = true;
      out[name] = node;
    }
    return out;
  }

  async function loadMcp() {
    await run(async () => {
      const base = (await readFsJson("home", CLAUDE_MCP_PATH)) || {};
      setMcpBaseConfig(base);
      setMcpServers(decodeMcp(base.mcpServers));
      setStatus("Loaded MCP from ~/.claude.json.");
    });
  }

  function patchMcp(patch: Partial<McpServer>) {
    if (!selectedMcp) return;
    setMcpServers((prev) => prev.map((m) => (m.id === selectedMcp.id ? { ...m, ...patch } : m)));
  }

  async function saveMcp() {
    await run(async () => {
      const next = { ...mcpBaseConfig };
      const obj = encodeMcp(mcpServers);
      if (Object.keys(obj).length) next.mcpServers = obj;
      else delete next.mcpServers;
      await writeFsText("home", CLAUDE_MCP_PATH, JSON.stringify(next, null, 2));
      setMcpBaseConfig(next);
      setStatus("Saved MCP to ~/.claude.json.");
    });
  }

  function exportMcp() {
    run(async () => {
      const payload: McpExportPayload = { version: 1, mcpServers: encodeMcp(mcpServers) };
      downloadTextFile(`mcp-servers-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
      setStatus(`Exported ${mcpServers.length} MCP server(s).`);
    }).catch(() => undefined);
  }

  async function importMcp(file: File) {
    await run(async () => {
      const raw = await file.text();
      const parsed = parseJson<Record<string, unknown>>(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid MCP JSON.");

      let source: unknown = parsed;
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        source = parsed.mcpServers;
      }

      const decoded = decodeMcp(source);
      setMcpServers(decoded);
      setStatus(`Imported ${decoded.length} MCP server(s).`);
    });
  }

  async function refreshSkills() {
    await run(async () => {
      const res = await fsJson<{ entries: FsEntry[] }>(`/api/fs/list?root=${encodeURIComponent("home")}&path=${encodeURIComponent(CLAUDE_SKILLS_PATH)}`);
      if (!res.ok) {
        if (res.code === "not_found") {
          setSkills([]);
          setStatus("No ~/.claude/skills directory yet.");
          return;
        }
        throw new Error(res.message || "Failed to list skills.");
      }

      const mapped = (res.entries || [])
        .flatMap((entry) => {
          if (entry.kind === "dir") {
            const path = `${CLAUDE_SKILLS_PATH}/${entry.name}`;
            return [{ id: path, name: entry.name, path, docPath: `${path}/SKILL.md`, kind: "dir" as const }];
          }
          if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
            const path = `${CLAUDE_SKILLS_PATH}/${entry.name}`;
            return [{ id: path, name: entry.name, path, docPath: path, kind: "file" as const }];
          }
          return [] as SkillItem[];
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      setSkills(mapped);
      setStatus(`Loaded ${mapped.length} skill item(s).`);
    });
  }

  async function exportSkills() {
    await run(async () => {
      const rows: Array<{ name: string; content: string }> = [];
      for (const item of skills) {
        const content = (await readFsText("home", item.docPath)) || "";
        rows.push({ name: item.name, content });
      }
      const payload: SkillsExportPayload = { version: 1, skills: rows };
      downloadTextFile(`skills-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
      setStatus(`Exported ${rows.length} skill item(s).`);
    });
  }

  async function importSkills(file: File) {
    await run(async () => {
      const raw = await file.text();
      const lower = file.name.toLowerCase();

      if (lower.endsWith(".json")) {
        const parsed = parseJson<SkillsExportPayload>(raw);
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) throw new Error("Invalid skills JSON.");
        let imported = 0;
        for (const item of parsed.skills) {
          if (!item || typeof item.name !== "string") continue;
          const name = item.name.trim() || `skill-${imported + 1}`;
          const slug = name
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9._-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+/, "")
            .replace(/-+$/, "") || `skill-${Date.now().toString(36)}`;
          await writeFsText("home", `${CLAUDE_SKILLS_PATH}/${slug}/SKILL.md`, typeof item.content === "string" ? item.content : skillTemplate(name));
          imported += 1;
        }
        await refreshSkills();
        setStatus(`Imported ${imported} skill item(s) from JSON.`);
        return;
      }

      const suggested = file.name.replace(/\.[^.]+$/, "");
      const input = window.prompt("Skill name", suggested || "imported-skill");
      const name = input?.trim();
      if (!name) throw new Error("Skill name is required.");
      const slug = name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "") || `skill-${Date.now().toString(36)}`;
      await writeFsText("home", `${CLAUDE_SKILLS_PATH}/${slug}/SKILL.md`, raw || skillTemplate(name));
      await refreshSkills();
      setStatus(`Imported skill ${slug}.`);
    });
  }

  async function createSkill() {
    const name = window.prompt("Skill name", "my-skill")?.trim();
    if (!name) return;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "") || "skill";
    await run(async () => {
      await writeFsText("home", `${CLAUDE_SKILLS_PATH}/${slug}/SKILL.md`, skillTemplate(name));
      await refreshSkills();
      setSkillSelectedId(`${CLAUDE_SKILLS_PATH}/${slug}`);
      setStatus(`Created ${slug}.`);
    });
  }

  async function saveSkill() {
    if (!selectedSkill) return;
    await run(async () => {
      await writeFsText("home", selectedSkill.docPath, skillContent);
      setSkillDirty(false);
      setStatus(`Saved ${selectedSkill.docPath}.`);
    });
  }

  async function deleteSkill() {
    if (!selectedSkill) return;
    const ok = window.confirm(`Delete ${selectedSkill.name}?`);
    if (!ok) return;
    await run(async () => {
      const payload = selectedSkill.kind === "dir" ? { root: "home", path: selectedSkill.path, recursive: true } : { root: "home", path: selectedSkill.path };
      const res = await fsJson(`/api/fs/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(res.message || "Delete failed.");
      await refreshSkills();
    });
  }

  useEffect(() => {
    if (view === "mcp" && !mcpServers.length) void loadMcp();
    if (view === "skills" && !skills.length) void refreshSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (!selectedSkill) {
      setSkillContent("");
      setSkillDirty(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const raw = await readFsText("home", selectedSkill.docPath);
      if (cancelled) return;
      setSkillContent(raw ?? (selectedSkill.kind === "dir" ? skillTemplate(selectedSkill.name) : ""));
      setSkillDirty(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSkill]);

  return (
    <div className="ccswitch" data-view={view}>
      <aside className="ccswitch-sidebar">
        <div className="ccswitch-header-row">
          <div className="ccswitch-brand-wrap">
            <div className="ccswitch-header">CC Switch</div>
            <button className="ccswitch-gear" type="button" title="Settings">{"\u2699"}</button>
          </div>

          <div className="ccswitch-controls">
            <button className="ccswitch-stream" type="button" title="Live sync">
              <span className="ccswitch-stream-icon">{"\u25CE"}</span>
              <span className="ccswitch-stream-switch"><span className="ccswitch-stream-thumb" /></span>
            </button>

            <div className="ccswitch-apps" role="tablist" aria-label="CC Switch Apps">
              {APPS.map((app) => (
                <button key={app} className="ccswitch-app-btn" data-active={activeApp === app ? "true" : "false"} type="button" onClick={() => setActiveApp(app)}>
                  <span className="ccswitch-app-mark">{APP_MARK[app]}</span>
                  <span>{APP_LABEL[app]}</span>
                </button>
              ))}
            </div>

            <div className="ccswitch-nav" role="tablist" aria-label="CC Switch Views">
              <button className="ccswitch-icon-tab" data-active={view === "providers" ? "true" : "false"} type="button" title="Providers" onClick={() => setView("providers")}>{"\u2692"}</button>
              <button className="ccswitch-icon-tab" data-active={view === "mcp" ? "true" : "false"} type="button" title="MCP" onClick={() => setView("mcp")}>{"\u25A3"}</button>
              <button className="ccswitch-icon-tab" data-active={view === "skills" ? "true" : "false"} type="button" title="Skills" onClick={() => setView("skills")}>{"\u224B"}</button>
            </div>

            <button className="ccswitch-plus" type="button" onClick={() => handleTopCreate()}>+</button>
          </div>
        </div>

        {view === "providers" ? (
          <section className="ccswitch-section">
            <div className="ccswitch-section-title">{APP_LABEL[activeApp]} Providers</div>
            <div className="ccswitch-list">
              {providersInActiveApp.map((provider) => (
                <button key={provider.id} className="ccswitch-item ccswitch-provider-item" data-selected={provider.id === selectedInActiveApp?.id ? "true" : "false"} type="button" onClick={() => setSelectedId(provider.id)}>
                  <span className="ccswitch-provider-grip" aria-hidden="true">{"\u22EE\u22EE"}</span>
                  <span className="ccswitch-provider-icon">{APP_MARK[provider.app]}</span>
                  <span className="ccswitch-provider-meta">
                    <span className="ccswitch-provider-name-row">
                      <span className="ccswitch-item-name">{provider.name}</span>
                      {activeByApp[provider.app] === provider.id ? <span className="agent-pill">Currently Using</span> : null}
                    </span>
                    <span className="ccswitch-provider-url">{provider.baseUrl.trim() || "Official endpoint"}</span>
                  </span>
                  <span className="ccswitch-provider-host">{hostLabel(provider.baseUrl)}</span>
                </button>
              ))}
              {!providersInActiveApp.length ? <div className="agent-muted">No providers yet.</div> : null}
            </div>
          </section>
        ) : null}

        {view === "mcp" ? (
          <section className="ccswitch-section">
            <div className="ccswitch-section-title">Claude MCP Servers</div>
            <div className="ccswitch-list">
              {mcpServers.map((m) => (
                <button key={m.id} className="ccswitch-item" data-selected={m.id === mcpSelectedId ? "true" : "false"} type="button" onClick={() => setMcpSelectedId(m.id)}>
                  <span className="ccswitch-item-name">{m.name}</span>
                  <span className="agent-pill">{m.enabled ? "Enabled" : "Disabled"}</span>
                </button>
              ))}
              {!mcpServers.length ? <div className="agent-muted">No MCP servers</div> : null}
            </div>
          </section>
        ) : null}

        {view === "skills" ? (
          <section className="ccswitch-section">
            <div className="ccswitch-section-title">Claude Skills</div>
            <div className="ccswitch-list">
              {skills.map((s) => (
                <button key={s.id} className="ccswitch-item" data-selected={s.id === skillSelectedId ? "true" : "false"} type="button" onClick={() => setSkillSelectedId(s.id)}>
                  <span className="ccswitch-item-name">{s.name}</span>
                  <span className="agent-pill">{s.kind === "dir" ? "Folder" : "File"}</span>
                </button>
              ))}
              {!skills.length ? <div className="agent-muted">No skills</div> : null}
            </div>
          </section>
        ) : null}
      </aside>

      <main className="ccswitch-main">
        <div className="ccswitch-toolbar">
          {view === "providers" ? (
            <>
              <button className="agent-btn" type="button" disabled={!selectedInActiveApp} onClick={() => void run(async () => { if (!selectedInActiveApp) return; await applyProvider(selectedInActiveApp); setActiveByApp((prev) => ({ ...prev, [selectedInActiveApp.app]: selectedInActiveApp.id })); setStatus(`Activated ${selectedInActiveApp.name}`); })}>Activate</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => void run(async () => { for (const app of ["claude", "codex", "gemini"] as const) { const id = activeByApp[app]; const p = providers.find((x) => x.id === id && x.app === app); if (p) await applyProvider(p); } setStatus("Applied active providers."); })}>Apply Active All</button>
              <button className="agent-btn" type="button" disabled={!selectedInActiveApp} onClick={() => selectedInActiveApp && setProviders((prev) => prev.filter((p) => p.id !== selectedInActiveApp.id))}>Delete</button>
              <button className="agent-btn" type="button" onClick={() => { const payload: ExportPayload = { version: 1, providers, activeByApp }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `cc-switch-profiles-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u); }}>Export</button>
            </>
          ) : null}

          {view === "mcp" ? (
            <>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => void loadMcp()}>Reload</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => setMcpServers((prev) => [{ id: makeId("mcp", "server"), name: `server-${prev.length + 1}`, command: "", args: "", env: "", enabled: true }, ...prev])}>+ Server</button>
              <button className="agent-btn" type="button" disabled={busy || !selectedMcp} onClick={() => selectedMcp && setMcpServers((prev) => prev.filter((m) => m.id !== selectedMcp.id))}>Delete</button>
              <button className="agent-btn primary" type="button" disabled={busy} onClick={() => void saveMcp()}>Save MCP</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => exportMcp()}>Export</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => mcpImportRef.current?.click()}>Import</button>
              <input
                ref={mcpImportRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void importMcp(file);
                  e.currentTarget.value = "";
                }}
              />
            </>
          ) : null}

          {view === "skills" ? (
            <>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => void refreshSkills()}>Reload</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => void createSkill()}>+ Skill</button>
              <button className="agent-btn" type="button" disabled={busy || !selectedSkill} onClick={() => void deleteSkill()}>Delete</button>
              <button className="agent-btn primary" type="button" disabled={busy || !selectedSkill || !skillDirty} onClick={() => void saveSkill()}>Save Skill</button>
              <button className="agent-btn" type="button" disabled={busy || !skills.length} onClick={() => void exportSkills()}>Export</button>
              <button className="agent-btn" type="button" disabled={busy} onClick={() => skillsImportRef.current?.click()}>Import</button>
              <input
                ref={skillsImportRef}
                type="file"
                accept="application/json,.json,text/markdown,.md,.markdown,text/plain"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void importSkills(file);
                  e.currentTarget.value = "";
                }}
              />
            </>
          ) : null}
        </div>

        {error ? <div className="agent-error">{error}</div> : null}
        {status ? <div className="ccswitch-status">{status}</div> : null}

        {view === "providers" && selectedInActiveApp ? (
          <div className="ccswitch-form">
            <label className="agent-label">Name</label>
            <input className="agent-input" value={selectedInActiveApp.name} onChange={(e) => patchSelected({ name: e.target.value })} />
            <label className="agent-label">App</label>
            <select className="agent-input" value={selectedInActiveApp.app} onChange={(e) => patchSelected({ app: e.target.value as AppType })}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
            </select>
            <label className="agent-label">Auth Mode</label>
            <select className="agent-input" value={selectedInActiveApp.authMode} onChange={(e) => patchSelected({ authMode: e.target.value as AuthMode })}>
              <option value="oauth">OAuth / Official</option>
              <option value="api_key">API Key</option>
            </select>
            <label className="agent-label">Base URL</label>
            <input className="agent-input" value={selectedInActiveApp.baseUrl} onChange={(e) => patchSelected({ baseUrl: e.target.value })} />
            <label className="agent-label">API Key</label>
            <input className="agent-input" type="password" value={selectedInActiveApp.apiKey} onChange={(e) => patchSelected({ apiKey: e.target.value })} />
            <label className="agent-label">Model</label>
            <input className="agent-input" value={selectedInActiveApp.model} onChange={(e) => patchSelected({ model: e.target.value })} />
          </div>
        ) : null}

        {view === "providers" && !selectedInActiveApp ? <div className="agent-empty">Create or select a provider profile.</div> : null}

        {view === "mcp" && selectedMcp ? (
          <div className="ccswitch-form">
            <label className="agent-label">Server Name</label>
            <input className="agent-input" value={selectedMcp.name} onChange={(e) => patchMcp({ name: e.target.value })} />
            <label className="agent-label">Command</label>
            <input className="agent-input" value={selectedMcp.command} onChange={(e) => patchMcp({ command: e.target.value })} />
            <label className="agent-label">Args (one per line)</label>
            <textarea className="agent-textarea ccswitch-editor" value={selectedMcp.args} onChange={(e) => patchMcp({ args: e.target.value })} />
            <label className="agent-label">Env (KEY=VALUE per line)</label>
            <textarea className="agent-textarea ccswitch-editor" value={selectedMcp.env} onChange={(e) => patchMcp({ env: e.target.value })} />
            <label className="agent-label">Enabled</label>
            <select className="agent-input" value={selectedMcp.enabled ? "true" : "false"} onChange={(e) => patchMcp({ enabled: e.target.value === "true" })}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </div>
        ) : null}

        {view === "mcp" && !selectedMcp ? <div className="agent-empty">Add or select an MCP server.</div> : null}

        {view === "skills" && selectedSkill ? (
          <div className="ccswitch-form">
            <div className="agent-label">Skill File</div>
            <div className="agent-muted">{selectedSkill.docPath}</div>
            <label className="agent-label">Content</label>
            <textarea className="agent-textarea ccswitch-editor" value={skillContent} onChange={(e) => { setSkillContent(e.target.value); setSkillDirty(true); }} />
          </div>
        ) : null}

        {view === "skills" && !selectedSkill ? <div className="agent-empty">Create or select a skill.</div> : null}
      </main>

      {createOpen ? (
        <div className="ccswitch-modal-backdrop" role="presentation" onClick={() => setCreateOpen(false)}>
          <div className="ccswitch-modal" role="dialog" aria-modal="true" aria-label="Create provider" onClick={(e) => e.stopPropagation()}>
            <div className="ccswitch-modal-title">Add {APP_LABEL[createDraft.app]} Provider</div>
            <div className="ccswitch-modal-sub">Use preset first, then fill key/model.</div>

            <div className="ccswitch-preset-row">
              <button className="ccswitch-preset" type="button" data-active={!createDraft.baseUrl ? "true" : "false"} onClick={() => setCreateDraft(defaultDraft(createDraft.app))}>Custom</button>
              {presetsForDraftApp.map((preset) => (
                <button key={preset.id} className="ccswitch-preset" type="button" data-active={createDraft.name === preset.label ? "true" : "false"} onClick={() => applyPresetToDraft(preset.id)}>
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="ccswitch-form ccswitch-modal-form">
              <div className="agent-row">
                <div>
                  <label className="agent-label">App</label>
                  <select className="agent-input" value={createDraft.app} onChange={(e) => setCreateDraft((prev) => ({ ...prev, app: e.target.value as AppType, authMode: e.target.value === "gemini" ? "oauth" : prev.authMode }))}>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </div>
                <div>
                  <label className="agent-label">Auth Mode</label>
                  <select className="agent-input" value={createDraft.authMode} onChange={(e) => setCreateDraft((prev) => ({ ...prev, authMode: e.target.value as AuthMode }))}>
                    <option value="oauth">OAuth / Official</option>
                    <option value="api_key">API Key</option>
                  </select>
                </div>
              </div>
              <label className="agent-label">Name</label>
              <input className="agent-input" value={createDraft.name} onChange={(e) => setCreateDraft((prev) => ({ ...prev, name: e.target.value }))} />
              <label className="agent-label">Base URL</label>
              <input className="agent-input" value={createDraft.baseUrl} onChange={(e) => setCreateDraft((prev) => ({ ...prev, baseUrl: e.target.value }))} />
              <label className="agent-label">API Key</label>
              <input className="agent-input" type="password" value={createDraft.apiKey} onChange={(e) => setCreateDraft((prev) => ({ ...prev, apiKey: e.target.value }))} />
              <label className="agent-label">Model</label>
              <input className="agent-input" value={createDraft.model} onChange={(e) => setCreateDraft((prev) => ({ ...prev, model: e.target.value }))} />
            </div>

            <div className="ccswitch-modal-actions">
              <button className="agent-btn" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="agent-btn primary" type="button" onClick={() => createProvider()}>Add</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
