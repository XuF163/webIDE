#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream");
const { promisify } = require("util");

const pipelineAsync = promisify(pipeline);

const HOST = process.env.FILES_HOST || "127.0.0.1";
const PORT = Number(process.env.FILES_PORT || "8091");
const WORKSPACE_ROOT = process.env.FILES_ROOT || process.env.WORKSPACE_DIR || "/workspace";
const MAX_JSON_BYTES = Number(process.env.FILES_MAX_JSON_BYTES || "1048576"); // 1MiB
const UI_STATE_FILE = process.env.HFIDE_UI_STATE_FILE || path.join(WORKSPACE_ROOT, ".hfide", "ui-state.json");

function nowMs() {
  return Date.now();
}

function isWithinRoot(realPath, rootReal) {
  return realPath === rootReal || realPath.startsWith(rootReal + path.sep);
}

function normalizeRelPath(input) {
  if (typeof input !== "string") return "";
  let p = input.replaceAll("\\", "/").trim();
  while (p.startsWith("/")) p = p.slice(1);
  p = path.posix.normalize(p);
  if (p === "." || p === "./") return "";
  if (!p) return "";
  if (p === ".." || p.startsWith("../") || p.includes("/../")) throw new Error("invalid_path");
  if (p.includes("\0")) throw new Error("invalid_path");
  return p;
}

function resolveFull(rootAbs, rel) {
  const full = path.resolve(rootAbs, rel);
  if (full === rootAbs) return full;
  if (!full.startsWith(rootAbs + path.sep)) throw new Error("path_outside_root");
  return full;
}

function sendJson(res, status, body, headers = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(raw);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_JSON_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function safeBaseName(p) {
  const base = path.basename(p || "");
  if (!base) return "download";
  return base;
}

async function readUiState() {
  try {
    const raw = await fsp.readFile(UI_STATE_FILE, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    if (e && typeof e === "object" && e.code === "ENOENT") return null;
    return null;
  }
}

async function writeUiState(data) {
  await fsp.mkdir(path.dirname(UI_STATE_FILE), { recursive: true });
  const tmp = `${UI_STATE_FILE}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const raw = JSON.stringify(data);
  try {
    await fsp.writeFile(tmp, raw, { encoding: "utf8", flag: "wx" });
    await fsp.rename(tmp, UI_STATE_FILE);
  } catch (e) {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * @typedef {Object} FsRoot
 * @property {string} id
 * @property {string} title
 * @property {string} abs
 * @property {string} real
 * @property {boolean} readOnly
 */

/**
 * @param {FsRoot[]} list
 * @param {Set<string>} seen
 * @param {string} id
 * @param {string} title
 * @param {string | undefined} rootPath
 * @param {boolean} readOnly
 * @param {boolean} createIfMissing
 */
async function addRoot(list, seen, id, title, rootPath, readOnly, createIfMissing) {
  if (!rootPath || typeof rootPath !== "string") return;
  const abs = path.resolve(rootPath);
  try {
    if (createIfMissing) await fsp.mkdir(abs, { recursive: true });
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return;
    const real = await fsp.realpath(abs);
    if (seen.has(real)) return;
    seen.add(real);
    list.push({ id, title, abs, real, readOnly });
  } catch {
    // ignore missing / inaccessible paths
  }
}

async function buildRoots() {
  /** @type {FsRoot[]} */
  const roots = [];
  const seen = new Set();

  await addRoot(roots, seen, "workspace", "Workspace", WORKSPACE_ROOT, false, true);
  await addRoot(roots, seen, "data", "Data", "/data", false, false);
  await addRoot(roots, seen, "home", "Home", process.env.HOME, false, false);
  await addRoot(roots, seen, "app", "App", "/app", true, false);

  if (!roots.length) throw new Error("no_roots");
  const defaultRootId = roots.some((r) => r.id === "workspace") ? "workspace" : roots[0].id;
  return { roots, defaultRootId };
}

async function start() {
  const { roots, defaultRootId } = await buildRoots();
  const rootsById = new Map(roots.map((r) => [r.id, r]));

  /** @returns {FsRoot} */
  function getRootFrom(url, body) {
    const rootIdFromBody = body && typeof body.root === "string" ? body.root : null;
    const rootIdFromQuery = url.searchParams.get("root");
    const rootId = rootIdFromBody || rootIdFromQuery || defaultRootId;
    const root = rootsById.get(rootId);
    if (!root) throw new Error("invalid_root");
    return root;
  }

  async function ensureParentInsideRoot(fullPath, rootReal) {
    const parentReal = await fsp.realpath(path.dirname(fullPath));
    if (!isWithinRoot(parentReal, rootReal)) throw new Error("path_outside_root");
  }

  async function ensureExistingInsideRoot(fullPath, rootReal) {
    const real = await fsp.realpath(fullPath);
    if (!isWithinRoot(real, rootReal)) throw new Error("path_outside_root");
    return real;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handler(req, res) {
    const started = nowMs();
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname || "/";

    const done = (status) => {
      if (res.headersSent) return;
      res.setHeader("X-Response-Time-Ms", String(nowMs() - started));
      res.setHeader("X-Status", String(status));
    };

    try {
      if (pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("ok\n");
        return;
      }

      if (pathname === "/roots" && req.method === "GET") {
        done(200);
        return sendJson(res, 200, {
          ok: true,
          defaultRootId,
          roots: roots.map((r) => ({ id: r.id, title: r.title, path: r.abs, readOnly: r.readOnly }))
        });
      }

      if (pathname === "/state" && req.method === "GET") {
        const data = await readUiState();
        done(200);
        return sendJson(res, 200, { ok: true, data });
      }

      if (pathname === "/state" && (req.method === "PUT" || req.method === "POST")) {
        const body = await readJson(req);
        if (!body || typeof body !== "object") return sendError(res, 400, "invalid_state", "Invalid state.");
        await writeUiState(body);
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/list" && req.method === "GET") {
        const root = getRootFrom(url, null);
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        const full = resolveFull(root.abs, rel);
        await ensureExistingInsideRoot(full, root.real);
        const st = await fsp.stat(full);
        if (!st.isDirectory()) return sendError(res, 400, "not_a_directory", "Not a directory.");

        const dirents = await fsp.readdir(full, { withFileTypes: true });
        const entries = await Promise.all(
          dirents.map(async (d) => {
            const name = d.name;
            const entryFull = path.join(full, name);
            let lst;
            try {
              lst = await fsp.lstat(entryFull);
            } catch {
              return null;
            }
            const kind = d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other";
            return {
              name,
              kind,
              size: kind === "file" ? Number(lst.size) : null,
              mtimeMs: Number(lst.mtimeMs)
            };
          })
        );

        const filtered = entries.filter(Boolean);
        filtered.sort((a, b) => {
          if (a.kind !== b.kind) {
            if (a.kind === "dir") return -1;
            if (b.kind === "dir") return 1;
          }
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });

        done(200);
        return sendJson(res, 200, { ok: true, root: root.id, rootPath: root.abs, readOnly: root.readOnly, path: rel, entries: filtered });
      }

      if (pathname === "/mkdir" && req.method === "POST") {
        const body = await readJson(req);
        const root = getRootFrom(url, body);
        if (root.readOnly) throw new Error("read_only");
        const rel = normalizeRelPath(body.path || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(root.abs, rel);
        await ensureParentInsideRoot(full, root.real);
        await fsp.mkdir(full, { recursive: false });
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/delete" && req.method === "POST") {
        const body = await readJson(req);
        const root = getRootFrom(url, body);
        if (root.readOnly) throw new Error("read_only");
        const rel = normalizeRelPath(body.path || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const recursive = body.recursive === true;
        const full = resolveFull(root.abs, rel);
        await ensureParentInsideRoot(full, root.real);
        const lst = await fsp.lstat(full);
        if (lst.isDirectory() && !recursive) return sendError(res, 400, "needs_recursive", "Directory delete requires recursive=true.");
        await fsp.rm(full, { recursive, force: false });
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/rename" && req.method === "POST") {
        const body = await readJson(req);
        const root = getRootFrom(url, body);
        if (root.readOnly) throw new Error("read_only");
        const fromRel = normalizeRelPath(body.from || "");
        const toRel = normalizeRelPath(body.to || "");
        if (!fromRel || !toRel) return sendError(res, 400, "invalid_path", "from/to required.");
        const fromFull = resolveFull(root.abs, fromRel);
        const toFull = resolveFull(root.abs, toRel);
        await ensureParentInsideRoot(fromFull, root.real);
        await ensureParentInsideRoot(toFull, root.real);
        await fsp.rename(fromFull, toFull);
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/file" && req.method === "GET") {
        const root = getRootFrom(url, null);
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(root.abs, rel);
        await ensureExistingInsideRoot(full, root.real);
        const st = await fsp.stat(full);
        if (!st.isFile()) return sendError(res, 400, "not_a_file", "Not a file.");

        const filename = safeBaseName(rel);
        done(200);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(st.size),
          "Content-Disposition": `attachment; filename=\"${encodeURIComponent(filename)}\"`,
          "Cache-Control": "no-store"
        });
        const stream = fs.createReadStream(full);
        stream.on("error", () => {
          try {
            res.destroy();
          } catch {
            // ignore
          }
        });
        stream.pipe(res);
        return;
      }

      if (pathname === "/file" && req.method === "PUT") {
        const root = getRootFrom(url, null);
        if (root.readOnly) throw new Error("read_only");
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(root.abs, rel);
        await ensureParentInsideRoot(full, root.real);
        await fsp.mkdir(path.dirname(full), { recursive: true });

        const tmp = `${full}.upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        try {
          const out = fs.createWriteStream(tmp, { flags: "wx" });
          await pipelineAsync(req, out);
          await fsp.rename(tmp, full);
        } catch (e) {
          try {
            await fsp.rm(tmp, { force: true });
          } catch {
            // ignore
          }
          throw e;
        }
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      done(404);
      return sendJson(res, 404, { ok: false, code: "not_found", message: "Not found." });
    } catch (e) {
      const msg = e && typeof e.message === "string" ? e.message : "error";
      if (msg === "invalid_root") return sendError(res, 400, "invalid_root", "Invalid root.");
      if (msg === "read_only") return sendError(res, 403, "read_only", "This root is read-only.");
      if (msg === "no_roots") return sendError(res, 500, "no_roots", "No filesystem roots configured.");
      if (msg === "payload_too_large") return sendError(res, 413, "payload_too_large", "Payload too large.");
      if (msg === "path_outside_root") return sendError(res, 403, "path_outside_root", "Path outside root.");
      if (msg === "invalid_path") return sendError(res, 400, "invalid_path", "Invalid path.");
      if (msg && msg.includes("ENOENT")) return sendError(res, 404, "not_found", "Not found.");
      if (msg && msg.includes("EEXIST")) return sendError(res, 409, "already_exists", "Already exists.");
      if (msg && msg.includes("ENOTEMPTY")) return sendError(res, 409, "not_empty", "Directory not empty.");
      return sendError(res, 500, "internal_error", "Internal error.");
    }
  }

  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(
      `files-server listening on http://${HOST}:${PORT} (roots: ${roots
        .map((r) => `${r.id}=${r.abs}${r.readOnly ? "(ro)" : ""}`)
        .join(", ")})`
    );
  });
}

start().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
