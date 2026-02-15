/* eslint-disable no-console */
"use strict";

const vscode = require("vscode");
const cp = require("child_process");

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { ...options, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function workspaceDir() {
  const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (f && f.uri && f.uri.fsPath) return f.uri.fsPath;
  return "/workspace";
}

function sanitizeTmuxName(input) {
  const raw = String(input || "").trim();
  const cleaned = raw
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "job";
}

function defaultWindowName(cmd) {
  const first = String(cmd || "").trim().split(/\s+/)[0] || "job";
  const base = sanitizeTmuxName(first);
  const suffix = Date.now().toString(36);
  return `${base}-${suffix}`.slice(0, 40);
}

async function ensureMainSession(cwd) {
  await execFileAsync("tmux", ["new-session", "-Ad", "-s", "main", "-c", cwd]);
}

async function createWindow(cwd, name, userCmd) {
  const cmd = String(userCmd || "").trim();
  if (!cmd) throw new Error("empty_command");

  // Keep the tmux window alive after the command finishes (drop into a shell).
  const wrapped = `${cmd}; code=$?; echo; echo \"[hfide] exit=$code\"; exec bash`;
  await execFileAsync("tmux", ["new-window", "-t", "main", "-n", name, "-c", cwd, "bash", "-lc", wrapped]);
}

async function listWindows() {
  const { stdout } = await execFileAsync("tmux", ["list-windows", "-t", "main", "-F", "#I\t#W\t#{window_active}\t#{pane_current_command}"]);
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines
    .map((l) => {
      const [index, name, active, cmd] = l.split("\t");
      if (!index || !name) return null;
      return { index, name, active: active === "1", cmd: cmd || "" };
    })
    .filter(Boolean);
}

function openIntegratedTerminalAndRun(title, cwd, text) {
  const terminal = vscode.window.createTerminal({ name: title, cwd });
  terminal.show(true);
  terminal.sendText(text, true);
}

function formatErr(err) {
  if (!err) return "Unknown error.";
  const msg = err && typeof err.message === "string" ? err.message : String(err);
  const stderr = err && typeof err.stderr === "string" ? err.stderr.trim() : "";
  if (stderr) return `${msg}\n${stderr}`;
  return msg;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel("HFIDE Agent");

  context.subscriptions.push(
    vscode.commands.registerCommand("hfideAgent.runInTmux", async () => {
      const cwd = workspaceDir();

      const cmd = await vscode.window.showInputBox({
        title: "Run a command in tmux main (continues after disconnect)",
        prompt: "Example: codex  /  claudecode  /  npm run build  /  python script.py",
        placeHolder: "Enter a shell command to run in tmux",
        ignoreFocusOut: true
      });
      if (!cmd || !cmd.trim()) return;

      const suggested = defaultWindowName(cmd);
      const name = await vscode.window.showInputBox({
        title: "tmux window name",
        prompt: "Optional. Keep it short (letters/numbers/-/_).",
        value: suggested,
        ignoreFocusOut: true
      });
      if (name === undefined) return;

      const winName = sanitizeTmuxName(name || suggested).slice(0, 40);

      try {
        await ensureMainSession(cwd);
        await createWindow(cwd, winName, cmd);
        output.appendLine(`[run] tmux main:${winName}`);
        output.appendLine(`      ${cmd}`);
        vscode.window.showInformationMessage(`Started in tmux main: ${winName}`);
      } catch (e) {
        output.appendLine(`[error] ${formatErr(e)}`);
        vscode.window.showErrorMessage(`Failed to start tmux job: ${formatErr(e)}`);
      }
    }),

    vscode.commands.registerCommand("hfideAgent.attachTmuxMain", async () => {
      const cwd = workspaceDir();
      try {
        await ensureMainSession(cwd);
      } catch (e) {
        vscode.window.showErrorMessage(`tmux not ready: ${formatErr(e)}`);
        return;
      }
      openIntegratedTerminalAndRun("tmux main", cwd, "tmux attach -t main");
    }),

    vscode.commands.registerCommand("hfideAgent.attachTmuxWindow", async () => {
      const cwd = workspaceDir();
      try {
        await ensureMainSession(cwd);
        const wins = await listWindows();
        if (!wins.length) {
          vscode.window.showInformationMessage("No tmux windows found in session 'main'.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          wins.map((w) => ({
            label: `${w.active ? "●" : " "} ${w.index}: ${w.name}`,
            description: w.cmd ? `cmd: ${w.cmd}` : "",
            windowIndex: w.index
          })),
          { title: "Attach to a tmux window (session: main)", ignoreFocusOut: true }
        );
        if (!pick) return;
        openIntegratedTerminalAndRun(`tmux main:${pick.windowIndex}`, cwd, `tmux attach -t main:${pick.windowIndex}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed: ${formatErr(e)}`);
      }
    }),

    vscode.commands.registerCommand("hfideAgent.killTmuxWindow", async () => {
      const cwd = workspaceDir();
      try {
        await ensureMainSession(cwd);
        const wins = await listWindows();
        const killable = wins.filter((w) => w.index !== "0"); // keep window 0 as a default shell
        if (!killable.length) {
          vscode.window.showInformationMessage("No killable tmux windows found (keeps window 0).");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          killable.map((w) => ({
            label: `${w.index}: ${w.name}`,
            description: w.cmd ? `cmd: ${w.cmd}` : "",
            windowIndex: w.index
          })),
          { title: "Kill a tmux window (session: main)", ignoreFocusOut: true }
        );
        if (!pick) return;
        const ok = await vscode.window.showWarningMessage(`Kill tmux window main:${pick.windowIndex}?`, { modal: true }, "Kill");
        if (ok !== "Kill") return;
        await execFileAsync("tmux", ["kill-window", "-t", `main:${pick.windowIndex}`]);
        vscode.window.showInformationMessage(`Killed tmux window main:${pick.windowIndex}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Failed: ${formatErr(e)}`);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

