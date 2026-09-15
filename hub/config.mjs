// Hub configuration and on-disk locations.
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { BRAND, env } from "./brand.mjs";

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const XDG_DATA = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

export const CONFIG_DIR = env("CONFIG_DIR") || join(XDG_CONFIG, BRAND.name);
export const DATA_DIR = env("DATA_DIR") || join(XDG_DATA, BRAND.name);
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const STATE_FILE = join(CONFIG_DIR, "sessions.json");
export const TMUX_CONF = join(CONFIG_DIR, "tmux.conf");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

migrateLegacyDirs();

const DEFAULTS = {
  port: 7717, // API + glasses app, 127.0.0.1 (reached from the phone through `tailscale serve`)
  hookPort: 7718, // hook intake, 127.0.0.1 only, never exposed
  whisperPort: 7719, // local whisper-server, 127.0.0.1 only
  httpsPort: 7443, // tailscale serve HTTPS port on the machine's *.ts.net name
  // Also listen on the raw Tailscale IP over plain HTTP. Only for development
  // sideloads; store builds must use HTTPS through tailscale serve.
  bindTailscaleIP: false,
  tmuxSocket: BRAND.tmuxSocket,
  whisperModel: join(DATA_DIR, "models", "ggml-large-v3-turbo-q5_0.bin"),
  // Words whisper should expect: project names get appended at runtime.
  sttVocabulary: "Claude, Claude Code, Opus, Sonnet, Haiku, tmux, commit, deploy, npm, git",
  // Optional phone push through ntfy (https://ntfy.sh). Off unless a topic is set.
  ntfyTopic: "",
  ntfyServer: "https://ntfy.sh",
  // Extra arguments for sessions the glasses start (for example ["--model", "sonnet"]).
  claudeArgs: [],
};

/** Read the raw config file without generating tokens (used at import time). */
function readConfigFile() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export const TMUX_SOCKET_NAME = env("TMUX_SOCKET") || readConfigFile().tmuxSocket || DEFAULTS.tmuxSocket;

export function loadConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let cfg = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch (err) {
      throw new Error(`could not parse ${CONFIG_FILE}: ${err.message}`);
    }
  }
  let changed = false;
  if (!cfg.token) {
    cfg.token = randomBytes(24).toString("base64url");
    changed = true;
  }
  const merged = { ...DEFAULTS, ...cfg };
  if (changed) saveConfig(cfg);
  return merged;
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600);
}

/** Update individual keys in the config file, keeping everything else. */
export function updateConfig(patch) {
  const cfg = readConfigFile();
  Object.assign(cfg, patch);
  saveConfig(cfg);
  return cfg;
}

/**
 * First run under a new name: copy config and data from a folder an earlier
 * version used, and keep that version's tmux server so running sessions stay
 * reachable.
 */
function migrateLegacyDirs() {
  if (env("CONFIG_DIR") || existsSync(CONFIG_DIR)) return;
  for (const old of BRAND.legacy.configDirs) {
    const oldConfig = join(XDG_CONFIG, old);
    if (!existsSync(join(oldConfig, "config.json"))) continue;
    cpSync(oldConfig, CONFIG_DIR, { recursive: true });
    const oldData = join(XDG_DATA, old);
    // Move rather than copy: the data folder holds a ~550 MB speech model.
    if (!env("DATA_DIR") && existsSync(oldData) && !existsSync(DATA_DIR)) renameSync(oldData, DATA_DIR);
    try {
      const cfg = JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8"));
      cfg.tmuxSocket ||= old;
      // Earlier versions always listened on the Tailscale IP; installed apps may rely on it.
      cfg.bindTailscaleIP ??= true;
      if (cfg.whisperModel?.includes(`/${old}/`)) cfg.whisperModel = cfg.whisperModel.replace(`/${old}/`, `/${BRAND.name}/`);
      writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    } catch {
      /* leave the copied config as is */
    }
    return;
  }
}

/** The machine's Tailscale IPv4 address, if Tailscale is up. */
export function tailscaleAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && a.address.startsWith("100.")) {
        const second = Number(a.address.split(".")[1]);
        if (second >= 64 && second <= 127) return a.address; // CGNAT range Tailscale uses
      }
    }
  }
  return null;
}
