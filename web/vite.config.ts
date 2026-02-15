import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const DEV_PROXY_TARGET = process.env.VITE_DEV_PROXY_TARGET || "http://localhost:7860";
const ROOT_DIR = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: ROOT_DIR,
  plugins: [react()],
  server: {
    proxy: {
      "/vscode": { target: DEV_PROXY_TARGET, changeOrigin: true, ws: true },
      "/terminal": { target: DEV_PROXY_TARGET, changeOrigin: true, ws: true },
      "/terminal-new": { target: DEV_PROXY_TARGET, changeOrigin: true, ws: true },
      "/api/fs": { target: DEV_PROXY_TARGET, changeOrigin: true },
      "/auth": { target: DEV_PROXY_TARGET, changeOrigin: true },
      "/healthz": { target: DEV_PROXY_TARGET, changeOrigin: true }
    }
  }
});
