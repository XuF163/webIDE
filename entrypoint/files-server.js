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
const ROOT = process.env.FILES_ROOT || process.env.WORKSPACE_DIR || "/workspace";
const MAX_JSON_BYTES = Number(process.env.FILES_MAX_JSON_BYTES || "1048576"); // 1MiB

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

async function start() {
  const rootAbs = path.resolve(ROOT);
  const rootReal = await fsp.realpath(rootAbs);

  async function ensureParentInsideRoot(fullPath) {
    const parentReal = await fsp.realpath(path.dirname(fullPath));
    if (!isWithinRoot(parentReal, rootReal)) throw new Error("path_outside_root");
  }

  async function ensureExistingInsideRoot(fullPath) {
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
      res.setHeader("X-Response-Time-Ms", String(nowMs() - started));
      res.setHeader("X-Status", String(status));
    };

    try {
      if (pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("ok\n");
        return;
      }

      if (pathname === "/list" && req.method === "GET") {
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        const full = resolveFull(rootAbs, rel);
        await ensureExistingInsideRoot(full);
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
        return sendJson(res, 200, { ok: true, path: rel, entries: filtered });
      }

      if (pathname === "/mkdir" && req.method === "POST") {
        const body = await readJson(req);
        const rel = normalizeRelPath(body.path || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(rootAbs, rel);
        await ensureParentInsideRoot(full);
        await fsp.mkdir(full, { recursive: false });
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/delete" && req.method === "POST") {
        const body = await readJson(req);
        const rel = normalizeRelPath(body.path || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const recursive = body.recursive === true;
        const full = resolveFull(rootAbs, rel);
        await ensureParentInsideRoot(full);
        const lst = await fsp.lstat(full);
        if (lst.isDirectory() && !recursive) return sendError(res, 400, "needs_recursive", "Directory delete requires recursive=true.");
        await fsp.rm(full, { recursive, force: false });
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/rename" && req.method === "POST") {
        const body = await readJson(req);
        const fromRel = normalizeRelPath(body.from || "");
        const toRel = normalizeRelPath(body.to || "");
        if (!fromRel || !toRel) return sendError(res, 400, "invalid_path", "from/to required.");
        const fromFull = resolveFull(rootAbs, fromRel);
        const toFull = resolveFull(rootAbs, toRel);
        await ensureParentInsideRoot(fromFull);
        await ensureParentInsideRoot(toFull);
        await fsp.rename(fromFull, toFull);
        done(200);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/file" && req.method === "GET") {
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(rootAbs, rel);
        await ensureExistingInsideRoot(full);
        const st = await fsp.stat(full);
        if (!st.isFile()) return sendError(res, 400, "not_a_file", "Not a file.");

        const filename = safeBaseName(rel);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(st.size),
          "Content-Disposition": `attachment; filename=\"${encodeURIComponent(filename)}\"`,
          "Cache-Control": "no-store"
        });
        done(200);
        fs.createReadStream(full).pipe(res);
        return;
      }

      if (pathname === "/file" && req.method === "PUT") {
        const rel = normalizeRelPath(url.searchParams.get("path") || "");
        if (!rel) return sendError(res, 400, "invalid_path", "Path required.");
        const full = resolveFull(rootAbs, rel);
        await ensureParentInsideRoot(full);
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
    console.log(`files-server listening on http://${HOST}:${PORT} (root: ${rootAbs})`);
  });
}

start().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

