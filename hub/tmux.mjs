// tmux control: find panes, type into Claude Code, read the screen, launch sessions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TMUX_CONF, TMUX_SOCKET_NAME } from "./config.mjs";
import { BRAND } from "./brand.mjs";
import { readGeminiDialog } from "./gemini.mjs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pane ids like %0 restart on every tmux server, so a pane is only identified by its
 * server's socket plus its id. Sockets are compared by real path (/tmp is a link on macOS).
 */
export function paneKey(target) {
  if (!target?.pane || !target?.socket) return null;
  let socket = target.socket;
  try {
    socket = realpathSync(socket);
  } catch {
    /* socket gone; compare as given */
  }
  return `${socket}|${target.pane}`;
}

/** `$TMUX` is "socketPath,serverPid,sessionIndex". */
export function socketFromTmuxEnv(tmuxEnv) {
  if (!tmuxEnv || typeof tmuxEnv !== "string") return null;
  const path = tmuxEnv.split(",")[0];
  return path || null;
}

// Applied when our dedicated tmux server starts. Tuned for Claude Code.
export const TMUX_CONF_TEXT = `# glancecode tmux server (tmux -L ${TMUX_SOCKET_NAME})
set -g mouse on
set -g history-limit 50000
set -s escape-time 10
set -g focus-events on
set -g extended-keys on
set -g allow-passthrough on
set -g status off
set -g default-terminal "tmux-256color"
set -as terminal-features ",*:RGB"
# Pass Claude Code's session title (it sets the pane title) up to the terminal tab.
set -g set-titles on
set -g set-titles-string "#{pane_title}"
`;

const CONF_MARKER = "tmux server (tmux -L";

/**
 * Write our tmux.conf. A file we generated earlier is replaced when this version's
 * settings differ; a file the user wrote themselves (no marker line) is left alone.
 */
export function ensureTmuxConf() {
  if (existsSync(TMUX_CONF)) {
    const current = readFileSync(TMUX_CONF, "utf8");
    const ours = current.split("\n", 1)[0].includes(CONF_MARKER);
    if (!ours || current === TMUX_CONF_TEXT) return TMUX_CONF;
  }
  mkdirSync(dirname(TMUX_CONF), { recursive: true });
  writeFileSync(TMUX_CONF, TMUX_CONF_TEXT);
  return TMUX_CONF;
}

/** Load the current config into our tmux server if it is already running. */
export async function reloadTmuxConf() {
  try {
    await tmux(null, ["source-file", ensureTmuxConf()]);
    return true;
  } catch {
    return false; // no server running yet; it reads the file when it starts
  }
}

/** Arguments that select our tmux server, or another server by socket path. */
export function serverArgs(socket) {
  return socket ? ["-S", socket] : ["-L", TMUX_SOCKET_NAME, "-f", ensureTmuxConf()];
}

export async function tmux(socket, args, { timeout = 5000 } = {}) {
  const base = serverArgs(socket);
  const { stdout } = await run("tmux", [...base, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** True when the pane still exists. tmux exits 0 for some missing targets, so compare output. */
export async function paneAlive(target) {
  try {
    const out = await tmux(target.socket, ["display-message", "-p", "-t", target.pane, "#{pane_id}"]);
    return out.trim() === target.pane;
  } catch {
    return false;
  }
}

/** End the process hosted by one pane. A generated one-pane tmux session then exits too. */
export async function terminateSession(target) {
  if (!target?.pane) throw new Error("tmux pane required");
  await tmux(target.socket, ["kill-pane", "-t", target.pane]);
}

export async function capture(target, lines = 60) {
  const out = await tmux(target.socket, ["capture-pane", "-p", "-J", "-t", target.pane, "-S", `-${lines}`]);
  return out.replace(/\s+$/gm, "");
}

/**
 * What is the agent showing at the bottom of the pane?
 * @param {"claude"|"gemini"} [agent]
 * @returns {{kind: "permission"|"question"|"trust"|"input"|"unknown", options: string[]}}
 */
export function readDialog(screen, agent = "claude") {
  if (agent === "gemini") return readGeminiDialog(screen);
  const tail = screen.split("\n").filter((l) => l.trim()).slice(-30);
  const joined = tail.join("\n");
  const options = [];
  for (const l of tail) {
    const m = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/.exec(l);
    if (m) options[Number(m[1]) - 1] = m[2];
  }
  const clean = options.filter(Boolean);
  if (/Yes, I trust this folder/.test(joined)) return { kind: "trust", options: clean };
  if (/Do you want to (proceed|make this edit|create|allow)/i.test(joined) && clean.length) return { kind: "permission", options: clean };
  if (/Enter to select/.test(joined) && clean.length) return { kind: "question", options: clean };
  if (/^\s*❯\s*/m.test(tail.slice(-4).join("\n"))) return { kind: "input", options: [] };
  return { kind: "unknown", options: clean };
}

/** Read Claude Code's current effort from its status line, e.g. "xhigh · /effort". */
export function readEffort(screen) {
  const text = String(screen || "");
  const match = /\b([a-z][a-z-]*)\s*·\s*\/effort\b/i.exec(text) || /\bwith\s+([a-z][a-z-]*)\s+effort\b/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** Read Claude Code's displayed model label without assuming today's model names. */
export function readClaudeModel(screen) {
  for (const raw of String(screen || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const match = /(.+?)\s+\([^)]*\bcontext\)\s+with\s+[a-z][a-z-]*\s+effort\b/i.exec(line);
    if (!match) continue;
    const label = match[1].trim().replace(/^[^A-Za-z0-9]+/, "").replace(/^model:\s*/i, "").trim();
    if (label && label.length <= 80 && /[A-Za-z]/.test(label)) return label;
  }
  return null;
}

/**
 * Scrolling with the mouse in an attached tmux client puts the pane in copy mode,
 * where typed keys become copy-mode commands and never reach Claude Code.
 */
export async function leaveCopyMode(target) {
  const inMode = (await tmux(target.socket, ["display-message", "-p", "-t", target.pane, "#{pane_in_mode}"])).trim();
  if (inMode === "1") await tmux(target.socket, ["send-keys", "-X", "-t", target.pane, "cancel"]);
  return inMode === "1";
}

/** Type a prompt into Claude Code's input box and submit it. */
export async function sendPrompt(target, text) {
  const flat = String(text).replace(/\r?\n+/g, " ").trim();
  if (!flat) return;
  await leaveCopyMode(target);
  await tmux(target.socket, ["send-keys", "-t", target.pane, "-l", flat]);
  await sleep(120); // let the TUI absorb a paste-sized burst before submitting
  await tmux(target.socket, ["send-keys", "-t", target.pane, "Enter"]);
}

const KEY_WHITELIST = new Set(["Escape", "Enter", "Up", "Down", "Tab", "BTab", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export async function sendKey(target, key) {
  if (!KEY_WHITELIST.has(key)) throw new Error(`key not allowed: ${key}`);
  await leaveCopyMode(target);
  await tmux(target.socket, ["send-keys", "-t", target.pane, key]);
}

/**
 * Press an option number only if the expected dialog is on screen, so a digit
 * never lands in the prompt box by accident.
 */
export async function chooseOption(target, expectedKind, index, agent = "claude") {
  const dialog = readDialog(await capture(target), agent);
  if (dialog.kind !== expectedKind) {
    throw Object.assign(new Error(`no ${expectedKind} dialog on screen (saw ${dialog.kind})`), { status: 409 });
  }
  if (index < 0 || index >= dialog.options.length || index > 8) {
    throw Object.assign(new Error(`option ${index + 1} not available`), { status: 400 });
  }
  await sendKey(target, String(index + 1));
  return dialog.options[index];
}

/**
 * Switch the session's model with /model, confirm the cache-reset dialog if it
 * appears, and put the user's saved default back: /model also rewrites the
 * default in ~/.claude/settings.json, and a glasses switch should only change
 * this one session.
 */
export async function switchModel(target, model, settingsPath) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const readModel = () => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf8")).model;
    } catch {
      return undefined;
    }
  };
  const before = readModel();
  await sendPrompt(target, `/model ${model}`);
  const until = Date.now() + 4000;
  let confirmed = false;
  while (Date.now() < until) {
    await sleep(300);
    const screen = await capture(target, 30);
    const m = /(\d+)\.\s+Yes, switch to/.exec(screen);
    if (m && !confirmed) {
      await sendKey(target, m[1]);
      confirmed = true;
      continue;
    }
    if (/Set model to/.test(screen.split("\n").slice(-12).join("\n"))) break;
  }
  await sleep(300);
  const after = readModel();
  if (after !== before) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (before === undefined) delete settings.model;
    else settings.model = before;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return { restoredDefault: after !== before ? before ?? null : null };
}

/** Change this session's effort while restoring the user's default afterward. */
export async function switchEffort(target, effort, settingsPath) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const readDefault = () => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf8")).effortLevel;
    } catch {
      return undefined;
    }
  };
  const before = readDefault();
  await sendPrompt(target, `/effort ${effort}`);
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    await sleep(250);
    if (/Set effort level to/i.test((await capture(target, 20)).split("\n").slice(-12).join("\n"))) break;
  }
  const after = readDefault();
  if (after !== before) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (before === undefined) delete settings.effortLevel;
    else settings.effortLevel = before;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return { restoredDefault: after !== before ? before ?? null : null };
}

/** Answer a question with free text via its "Type something" option. */
export async function answerWithText(target, text, agent = "claude") {
  const dialog = readDialog(await capture(target), agent);
  if (dialog.kind !== "question") throw Object.assign(new Error("no question on screen"), { status: 409 });
  const idx = dialog.options.findIndex((o) => /^Type something/i.test(o));
  if (idx < 0) throw Object.assign(new Error("question has no free-text option"), { status: 400 });
  await sendKey(target, String(idx + 1));
  await sleep(250);
  await sendPrompt(target, text);
}

export function sessionNameFor(cwd, taken) {
  const base = (cwd.split("/").filter(Boolean).pop() || "claude").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** The command a visible desktop terminal uses to join the already-running session. */
export function terminalAttachCommand(name) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name))) throw new Error("unsafe tmux session name");
  return `${BRAND.name} attach ${name}`;
}

/**
 * Open a visible macOS terminal attached to the same tmux session. Orca gets first
 * choice for its registered worktrees; Terminal.app is the general fallback.
 * Launch remains useful when neither UI can open, so callers treat errors as best-effort.
 * @returns {Promise<"orca"|"terminal">}
 */
export async function openAttachedTerminal({ cwd, name }) {
  if (process.platform !== "darwin") throw new Error("visible terminal opening is only available on macOS");
  const command = terminalAttachCommand(name);
  let orcaError = null;
  for (const bin of ["/opt/homebrew/bin/orca", "/usr/local/bin/orca"]) {
    if (!existsSync(bin)) continue;
    try {
      await run(bin, ["terminal", "create", "--worktree", `path:${cwd}`, "--title", name, "--command", command, "--focus", "--json"], { timeout: 10_000 });
      return "orca";
    } catch (err) {
      orcaError = err;
      break;
    }
  }

  // Pass the command as AppleScript argv rather than interpolating it into the
  // script. `name` was restricted above to tmux's generated safe alphabet.
  const script = [
    "on run argv",
    '  tell application "Terminal"',
    "    do script ((item 1 of argv) & \"; exit\")",
    "    activate",
    "  end tell",
    "end run",
  ].join("\n");
  try {
    await run("osascript", ["-e", script, command], { timeout: 10_000 });
    return "terminal";
  } catch (err) {
    const why = [orcaError, err].filter(Boolean).map((e) => e.message).join("; ");
    throw new Error(`could not open Orca or Terminal.app${why ? `: ${why}` : ""}`);
  }
}

export async function listOurSessions() {
  try {
    const out = await tmux(null, ["list-sessions", "-F", "#{session_name}"]);
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set(); // no server yet
  }
}

/**
 * Start Claude Code in a detached tmux session on our dedicated tmux server.
 * @returns {{name: string, target: {socket: string, pane: string}}}
 */
/**
 * Run a command through the user's login shell, so sessions started by a
 * background service still get the PATH and variables from their shell config.
 */
export function loginShellCommand(bin, args = []) {
  const shell = process.env.SHELL || "/bin/zsh";
  return [shell, "-lic", 'exec "$@"', shell, bin, ...args];
}

export async function launchClaude({ cwd, args = [], claudeBin = "claude", env = {} }) {
  const name = sessionNameFor(cwd, await listOurSessions());
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await tmux(null, [
    "new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50", ...envArgs,
    "--", ...loginShellCommand(claudeBin, args),
  ]);
  const info = await tmux(null, ["display-message", "-p", "-t", name, "#{socket_path} #{pane_id}"]);
  const [socket, pane] = info.trim().split(" ");
  return { name, target: { socket, pane } };
}

/** Accept the folder-trust dialog if it appears within `waitMs`. */
export async function acceptTrustIfShown(target, waitMs = 8000, agent = "claude") {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    let dialog;
    try {
      dialog = readDialog(await capture(target), agent);
    } catch {
      return false;
    }
    if (dialog.kind === "trust" && agent === "gemini") {
      // Gemini's trust dialog is numbered; option 1 trusts this folder only.
      await sendKey(target, "1");
      return true;
    }
    if (dialog.kind === "trust") {
      // The trust dialog is an unnumbered two-item menu with "No, exit" focused.
      await sendKey(target, "Down");
      await sleep(250);
      await sendKey(target, "Enter");
      return true;
    }
    if (dialog.kind === "input") return false;
    await sleep(400);
  }
  return false;
}

/** Wait until the agent shows its input prompt. */
export async function waitForInput(target, waitMs = 20000, agent = "claude") {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      if (readDialog(await capture(target), agent).kind === "input") return true;
    } catch {
      /* pane not ready */
    }
    await sleep(400);
  }
  return false;
}

/** Whitespace-insensitive snippet used to confirm a prompt reached Claude Code. */
export function promptSnippet(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 40);
}

export function screenHasSnippet(screen, snippet) {
  if (!snippet) return true;
  const flat = screen.replace(/\s+/g, " ");
  // Wrapped lines add spaces at arbitrary points, so also compare with spaces removed.
  return flat.includes(snippet) || flat.replace(/ /g, "").includes(snippet.replace(/ /g, ""));
}
