#!/usr/bin/env node
"use strict";

const http = require("http");
const crypto = require("crypto");

const HOST = process.env.PIN_AUTH_HOST || "127.0.0.1";
const PORT = Number(process.env.PIN_AUTH_PORT || "8090");
const LOCK_PIN = process.env.LOCK_PIN || process.env.PIN || "";

const COOKIE_NAME = process.env.PIN_AUTH_COOKIE_NAME || "hfide_token";
const TOKEN_TTL_SECONDS = Number(process.env.PIN_AUTH_TTL_SECONDS || "43200"); // 12h
const MAX_TOKENS = Number(process.env.PIN_AUTH_MAX_TOKENS || "2000");
const COOKIE_SECURE = process.env.PIN_AUTH_COOKIE_SECURE === "1";
const COOKIE_PARTITIONED = process.env.PIN_AUTH_COOKIE_PARTITIONED !== "0";

if (!LOCK_PIN) {
  console.error("PIN auth server requires LOCK_PIN (or PIN).");
  process.exit(1);
}

/** @type {Map<string, number>} token -> expiresAtMs */
const tokens = new Map();

function nowMs() {
  return Date.now();
}

function cleanupTokens() {
  const now = nowMs();
  for (const [token, exp] of tokens) {
    if (exp <= now) tokens.delete(token);
  }
  if (tokens.size <= MAX_TOKENS) return;

  // If still too many, drop oldest by expiry.
  const ordered = Array.from(tokens.entries()).sort((a, b) => a[1] - b[1]);
  const toDrop = ordered.slice(0, Math.max(0, ordered.length - MAX_TOKENS));
  for (const [token] of toDrop) tokens.delete(token);
}

setInterval(cleanupTokens, 60_000).unref();

function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16 * 1024) {
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

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(String(a), "utf8");
  const bBuf = Buffer.from(String(b), "utf8");
  const max = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(max - aBuf.length)]);
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(max - bBuf.length)]);
  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

function issueToken() {
  cleanupTokens();
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, nowMs() + TOKEN_TTL_SECONDS * 1000);
  return token;
}

function isTokenValid(token) {
  if (!token) return false;
  cleanupTokens();
  const exp = tokens.get(token);
  if (!exp) return false;
  if (exp <= nowMs()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function isSecureRequest(req) {
  const xfProto = req.headers["x-forwarded-proto"];
  if (typeof xfProto === "string" && xfProto) {
    const first = xfProto.split(",")[0].trim().toLowerCase();
    if (first === "https") return true;
  }
  // direct TLS (unlikely behind nginx, but keep it generic)
  // @ts-ignore
  if (req.socket && req.socket.encrypted) return true;
  return false;
}

function setAuthCookie(req, res, token, maxAgeSeconds) {
  const secure = COOKIE_SECURE || isSecureRequest(req);
  const sameSite = secure ? "None" : "Lax";
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push("Secure");
  if (secure && COOKIE_PARTITIONED) parts.push("Partitioned");
  res.setHeader("Set-Cookie", parts.join("; "));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/auth/healthz") return send(res, 200, { ok: true });

  if (url.pathname === "/auth/check") {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (isTokenValid(token)) return send(res, 200, { ok: true });
    return send(res, 401, { ok: false });
  }

  if (url.pathname === "/auth/unlock" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { ok: false });
    }
    const pin = body && typeof body.pin === "string" ? body.pin : "";
    if (!pin) return send(res, 400, { ok: false });
    if (!timingSafeEqual(pin, LOCK_PIN)) return send(res, 401, { ok: false });

    const token = issueToken();
    setAuthCookie(req, res, token, TOKEN_TTL_SECONDS);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) tokens.delete(token);
    setAuthCookie(req, res, "", 0);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false });
});

server.listen(PORT, HOST, () => {
  console.log(`PIN auth server listening on http://${HOST}:${PORT} (cookie=${COOKIE_NAME})`);
});
