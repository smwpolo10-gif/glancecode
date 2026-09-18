// Codex CLI support. Codex runs an app-server that every Codex client talks to over
// JSON-RPC: the terminal UI, the desktop app, and here the hub. The hub joins as one
// more client, so a session started in the terminal is followed, prompted and
// approved from the glasses while the terminal shows the same thing live.
//
// Only sessions on the shared server are visible. `glancecode codex` starts the
// terminal UI attached to it; plain `codex` and the IDE extension run private servers.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { Session } from "./sessions.mjs";
import * as tmuxCtl from "./tmux.mjs";
import { WsClient } from "./wsclient.mjs";

export const CODEX_SERVER_NAME = "_glancecode-codex"; // tmux session holding the app-server
const HISTORY_TURNS = 25;
const REQUEST_TIMEOUT_MS = 30_000;
// Let go of idle sessions this long untouched (overridable for tests).
const RELEASE_IDLE_MS = Number(process.env.GLANCECODE_CODEX_RELEASE_MS) || 20 * 60_000;
const UNLOAD_WAIT_MS = 90_000; // Codex unloads an unwatched thread about a minute after idle
const MAX_TEXT = 4000;
const NO_UPDATE_CHECK = "check_for_update_on_startup=false";
const TERMINAL_WAIT_COMMAND = 'printf "\\n  Terminal HUD · Codex\\n\\n  Session ready. Send the first message from your glasses.\\n  This window will switch to Codex automatically.\\n\\n"; while :; do sleep 3600; done';

const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const clipText = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

/** Current context tokens from either an app-server usage object or a rollout record. */
export function codexContextTokens(value) {
  const usage = value?.last || value?.lastTokenUsage || value?.last_token_usage || value?.turn_token_usage || value?.usage;
  const tokens = usage?.totalTokens ?? usage?.total_tokens;
  return Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
}

/** Restore the last usage count after a hub restart without loading a large rollout. */
function contextFromRollout(path) {
  if (!path || !existsSync(path)) return null;
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const tokens = record.type === "token_usage_record"
        ? codexContextTokens(record.payload)
        : record.type === "event_msg" && record.payload?.type === "token_count"
          ? codexContextTokens(record.payload.info)
          : null;
      if (tokens !== null) return tokens;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

// ---------- mapping Codex items to display items ----------

/** Short label for a running tool, e.g. "Read server.ts". */
export function activityFor(item) {
  const [first] = codexItems(item, { includeErrors: false });
  return first?.kind === "tool" ? `${first.tool} ${first.text}`.trim() : "";
}

function commandLabel(item) {
  const actions = item.commandActions || [];
  if (actions.length === 1) {
    const a = actions[0];
    if (a.type === "read") return { tool: "Read", text: a.name || basename(a.path || "") };
    if (a.type === "listFiles") return { tool: "List", text: a.path ? basename(a.path) : "files" };
    if (a.type === "search") return { tool: "Search", text: clip(a.query || a.command, 40) };
  }
  // Commands arrive wrapped in the login shell: /bin/zsh -lc "printf '%s\\n' hi"
  const m = /^\S*\/?(?:ba|z)?sh -l?c (["']?)([\s\S]*?)\1$/.exec(item.command || "");
  const inner = !m ? item.command : m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, "$1") : m[2];
  return { tool: "Shell", text: clip(inner) };
}

function fileChangeLabel(changes = []) {
  const kinds = new Set(changes.map((c) => c.kind?.type));
  const tool = kinds.size === 1 && kinds.has("add") ? "Write" : kinds.size === 1 && kinds.has("delete") ? "Delete" : "Edit";
  const names = changes.map((c) => basename(c.path || "")).filter(Boolean);
  return { tool, text: names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ") };
}

function firstLine(text) {
  return (
    String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || ""
  );
}

/**
 * One Codex thread item as zero or more glasses items. Keys are the item ids, which
 * stay stable between history loads and live notifications.
 * @returns {import("./transcript.mjs").Item[]}
 */
export function codexItems(item, { ts, includeErrors = true } = {}) {
  if (!item?.id) return [];
  const key = item.id;
  switch (item.type) {
    case "userMessage": {
      const text = (item.content || [])
        .map((c) => (c.type === "text" ? c.text : c.type === "image" || c.type === "localImage" ? "[image]" : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      return text ? [{ key, kind: "user", text: clipText(text), ts }] : [];
    }
    case "agentMessage":
      return item.text?.trim() ? [{ key, kind: "assistant", text: clipText(item.text.trim()), ts }] : [];
    case "plan":
      return item.text?.trim() ? [{ key, kind: "assistant", text: clipText(item.text.trim()), ts }] : [];
    case "commandExecution": {
      const out = [{ key, kind: "tool", ...commandLabel(item), ts }];
      if (includeErrors && item.status === "declined") out.push({ key: `${key}:err`, kind: "error", text: "Command declined", ts });
      else if (includeErrors && (item.status === "failed" || (item.exitCode != null && item.exitCode !== 0))) {
        const why = firstLine(item.aggregatedOutput);
        out.push({ key: `${key}:err`, kind: "error", text: clipText(`exit ${item.exitCode ?? "?"}${why ? `: ${why}` : ""}`), ts });
      }
      return out;
    }
    case "fileChange": {
      const out = [{ key, kind: "tool", ...fileChangeLabel(item.changes), ts }];
      if (includeErrors && (item.status === "failed" || item.status === "declined")) out.push({ key: `${key}:err`, kind: "error", text: item.status === "declined" ? "Edit declined" : "Edit failed", ts });
      return out;
    }
    case "mcpToolCall":
      return [{ key, kind: "tool", tool: item.server || "MCP", text: clip(item.tool, 40), ts }];
    case "dynamicToolCall":
      return [{ key, kind: "tool", tool: item.namespace || "Tool", text: clip(item.tool, 40), ts }];
    case "collabAgentToolCall":
      return [{ key, kind: "tool", tool: "Agent", text: clip(item.prompt || item.tool, 50), ts }];
    case "webSearch":
      return [{ key, kind: "tool", tool: "WebSearch", text: clip(item.query || item.action?.query || item.action?.url, 50), ts }];
    case "imageView":
      return [{ key, kind: "tool", tool: "View", text: basename(item.path || ""), ts }];
    case "imageGeneration":
      return [{ key, kind: "tool", tool: "Image", text: clip(item.revisedPrompt || "", 50), ts }];
    case "contextCompaction":
      return [{ key, kind: "notice", text: "Conversation compacted", ts }];
    case "enteredReviewMode":
      return [{ key, kind: "notice", text: "Review started", ts }];
    case "exitedReviewMode":
      return [{ key, kind: "notice", text: "Review finished", ts }];
    default:
      return []; // reasoning, tool outputs, hook prompts, sub-agent bookkeeping
  }
}

/** Items for a whole turn, plus how it ended when that wasn't normally. */
export function turnItems(turn) {
  const ts = turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : undefined;
  const out = (turn.items || []).flatMap((it) => codexItems(it, { ts }));
  if (turn.status === "interrupted") out.push({ key: `${turn.id}:interrupted`, kind: "notice", text: "Interrupted", ts });
  if (turn.status === "failed" && turn.error?.message) out.push({ key: `${turn.id}:error`, kind: "error", text: clipText(turn.error.message), ts });
  return out;
}

// ---------- approvals and questions ----------

const APPROVE = ["Yes", "Yes, for this session", "No"];

/** Glasses-side view of a pending server request, or null if the glasses can't answer it. */
export function waitingFromRequest(method, params, cachedItem) {
  if (method === "item/commandExecution/requestApproval") {
    const detail = params.command ? commandLabel({ command: params.command, commandActions: params.commandActions }).text : clip(params.reason || "run a command");
    return { kind: "permission", tool: "Shell", detail, options: APPROVE, reason: params.reason || null };
  }
  if (method === "item/fileChange/requestApproval") {
    const label = cachedItem?.type === "fileChange" ? fileChangeLabel(cachedItem.changes) : { tool: "Edit", text: clip(params.reason || params.grantRoot || "change files") };
    return { kind: "permission", tool: label.tool, detail: label.text, options: APPROVE, reason: params.reason || null };
  }
  if (method === "item/permissions/requestApproval") {
    return { kind: "permission", tool: "Permissions", detail: clip(params.reason || "more access"), options: ["Allow", "Allow for this session", "Deny"], reason: params.reason || null };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = (params.questions || []).map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
      multiSelect: false,
      freeText: q.isOther || !q.options?.length,
      secret: q.isSecret,
    }));
    return { kind: "question", questions, questionIndex: 0, detail: clip(questions[0]?.question || "Codex has a question") };
  }
  return null;
}

/** The JSON-RPC result for a chosen approval option. */
export function approvalResult(method, params, index) {
  if (method === "item/permissions/requestApproval") {
    const granted = Object.fromEntries(Object.entries(params.permissions || {}).filter(([, v]) => v != null));
    if (index === 2) return { permissions: {}, scope: "turn" };
    return { permissions: granted, scope: index === 1 ? "session" : "turn" };
  }
  return { decision: ["accept", "acceptForSession", "decline"][index] };
}

/** Helper threads (title generation, guardians, sub-agents) never show as sessions. */
export function isHelperThread(thread) {
  if (!thread) return true;
  if (thread.ephemeral) return true;
  if (thread.source && typeof thread.source === "object" && "subAgent" in thread.source) return true;
  return !!thread.parentThreadId;
}

// ---------- running the app-server ----------

function socketAlive(path, ms = 800) {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const s = createConnection({ path });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), ms).unref?.();
  });
}

/**
 * The codex executable on the user's login-shell PATH, or null. The PATH is read from
 * the shell and searched here, because a service has a bare PATH and `command -v`
 * would report an alias like codex='glancecode codex' instead of the real program.
 */
export function findCodex(bin = "codex", { exclude = [] } = {}) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const dirs = [...new Set([...loginShellPath().split(":"), ...(process.env.PATH || "").split(":")].filter(Boolean))];
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const real = realpathSync(candidate);
    if (exclude.some((e) => real === e || real.startsWith(e + "/"))) continue;
    return candidate;
  }
  return null;
}

let cachedShellPath = null;

/** PATH as the user's login shell sets it. Starting that shell takes a second or two, so ask once. */
function loginShellPath() {
  if (cachedShellPath !== null) return cachedShellPath;
  const shell = process.env.SHELL || "/bin/zsh";
  const r = spawnSync(shell, ["-lic", 'printf "\\n__PATH__%s\\n" "$PATH"'], { encoding: "utf8", timeout: 8000 });
  cachedShellPath = /__PATH__(.*)/.exec(r.stdout || "")?.[1] || "";
  return cachedShellPath;
}

export function codexVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 8000 });
  return /(\d+\.\d+\.\d+)/.exec(r.stdout || "")?.[1] || null;
}

/**
 * Start `codex app-server` on our tmux server unless it already answers. It lives in
 * tmux rather than under the hub, so terminal sessions attached to it survive a hub
 * restart.
 */
export async function ensureCodexServer({ bin, socket }) {
  if (await socketAlive(socket)) return { started: false };
  const waitForSocket = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await socketAlive(socket)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  // The hub and `glancecode codex` can both get here; a server another caller is
  // still starting gets a moment before it counts as stuck.
  if ((await tmuxCtl.listOurSessions()).has(CODEX_SERVER_NAME)) {
    if (await waitForSocket(5000)) return { started: false };
    await tmuxCtl.tmux(null, ["kill-session", "-t", CODEX_SERVER_NAME]).catch(() => {});
  }
  rmSync(socket, { force: true }); // stale file from a server that exited
  try {
    await tmuxCtl.tmux(null, ["new-session", "-d", "-s", CODEX_SERVER_NAME, "-x", "160", "-y", "40", "--", ...tmuxCtl.loginShellCommand(bin, ["app-server", "--listen", `unix://${socket}`])]);
  } catch {
    /* started by someone else in the meantime */
  }
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await socketAlive(socket)) return { started: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  let screen = "";
  try {
    screen = await tmuxCtl.capture({ socket: null, pane: CODEX_SERVER_NAME }, 20);
  } catch {
    /* session already gone */
  }
  throw new Error(`Codex app-server did not start${screen ? `: ${firstLine(screen.split("\n").filter(Boolean).pop())}` : ""}`);
}

/**
 * Arguments that attach the Codex terminal UI to our server. `resume` and `fork` take
 * their own flag. A remote session otherwise works in the server's folder, so the
 * caller's folder goes along unless the arguments already name one.
 */
export function remoteArgs(socket, args = [], cwd = null) {
  const remote = ["--remote", `unix://${socket}`];
  if (cwd && !args.some((a) => a === "-C" || a === "--cd" || a.startsWith("--cd="))) remote.push("-C", cwd);
  if (args[0] === "resume" || args[0] === "fork") return [args[0], ...remote, ...args.slice(1)];
  return [...remote, ...args];
}

// ---------- the bridge ----------

export class CodexBridge extends EventEmitter {
  /**
   * @param {{registry: import("./sessions.mjs").Registry, bin: string, socket: string, log: Function, clientVersion: string, tmux?: typeof tmuxCtl}} opts
   */
  constructor({ registry, bin, socket, log = () => {}, clientVersion = "0", tmux = tmuxCtl }) {
    super();
    this.registry = registry;
    this.bin = bin;
    this.socket = socket;
    this.log = log;
    this.clientVersion = clientVersion;
    this.tmuxCtl = tmux;
    this.ws = null;
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map(); // our request id -> {resolve, reject, timer}
    this.joining = new Map(); // threadId -> {attempts, lastAt}
    this.itemCache = new Map(); // itemId -> started item, for approval details
    this.knownThreads = new Set(); // ids seen in recent(), to route a resume
    // End and /clear remove a live row before Codex finishes unloading its thread.
    // Keep auto-discovery from immediately subscribing to it again; History resume
    // explicitly removes the id from this set.
    this.suppressedThreads = new Set();
    this.stopped = false;
    this.retryMs = 1000;
    this.models = [];
  }

  // ----- connection -----

  async start() {
    this.stopped = false;
    try {
      const { started } = await ensureCodexServer({ bin: this.bin, socket: this.socket });
      if (started) this.log(`codex: app-server started on ${this.socket}`);
    } catch (err) {
      this.log(`codex: ${err.message}`);
      return this.retryLater();
    }
    this.connect();
    this.pollTimer ||= setInterval(() => this.poll().catch(() => {}), 5000);
    this.pollTimer.unref?.();
  }

  connect() {
    const ws = new WsClient(`unix://${this.socket}`);
    this.ws = ws;
    ws.on("open", () => this.onOpen().catch((err) => this.log(`codex: ${err.message}`)));
    ws.on("message", (text) => this.onMessage(text));
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      this.ws = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Codex connection closed"));
      }
      this.pending.clear();
      this.joining.clear();
      for (const s of this.sessions()) {
        s.codexJoined = false;
        this.registry.changed(s);
      }
      if (wasReady) this.log("codex: disconnected from app-server");
      this.retryLater();
    });
  }

  retryLater() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    this.ws?.close();
  }

  async onOpen() {
    const init = await this.call("initialize", {
      clientInfo: { name: "glancecode", title: "Terminal HUD", version: this.clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    this.ready = true;
    this.retryMs = 1000;
    this.log(`codex: connected (${/codex-tui\/(\S+)/.exec(init?.userAgent || "")?.[1] || "app-server"})`);
    await this.loadModels().catch(() => {});
    await this.poll();
  }

  async loadModels() {
    const r = await this.call("model/list", {});
    this.models = (r.data || []).filter((m) => !m.hidden).map((m) => ({
        id: m.id,
        name: m.displayName || m.id,
        isDefault: m.isDefault,
        efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter(Boolean),
        defaultEffort: m.defaultReasoningEffort || null,
      }));
    return this.models;
  }

  call(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws?.open) return reject(new Error("Codex isn't connected"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex didn't answer ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method, params) {
    if (this.ws?.open) this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id, result) {
    if (!this.ws?.open) throw new Error("Codex isn't connected");
    this.ws.send(JSON.stringify({ id, result }));
  }

  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    try {
      if (msg.id !== undefined && msg.method) this.onServerRequest(msg.id, msg.method, msg.params || {});
      else if (msg.method) this.onNotification(msg.method, msg.params || {});
    } catch (err) {
      this.log(`codex: ${msg.method}: ${err.message}`);
    }
  }

  // ----- sessions -----

  sessions() {
    return [...this.registry.sessions.values()].filter((s) => s.agent === "codex");
  }

  session(threadId) {
    const s = this.registry.sessions.get(threadId);
    return s?.agent === "codex" ? s : null;
  }

  /** Find loaded threads we haven't joined, and retry the ones that weren't ready. */
  async poll() {
    if (!this.ready) return;
    const { data = [] } = await this.call("thread/loaded/list", {});
    const loaded = new Set(data);
    for (const id of data) {
      if (this.suppressedThreads.has(id)) continue;
      const s = this.session(id);
      if (!s?.codexJoined && !s?.releasedAt) await this.join(id);
    }
    await this.release(loaded);
  }

  /**
   * Our own subscription keeps a thread loaded, so a session whose terminal has closed
   * would never end. Idle sessions are let go now and then: one still loaded after
   * Codex's unload delay has a terminal attached and is joined again, and one that
   * unloaded has ended.
   */
  async release(loaded) {
    const now = Date.now();
    for (const s of this.sessions()) {
      if (s.state === "ended") continue;
      if (s.releasedAt) {
        if (!loaded.has(s.id)) {
          s.releasedAt = 0;
          s.codexJoined = false;
          s.state = "ended";
          s.waiting = null;
          this.registry.changed(s);
        } else if (now - s.releasedAt > UNLOAD_WAIT_MS) {
          s.releasedAt = 0;
          s.idleSince = now;
          await this.join(s.id, { force: true });
        }
        continue;
      }
      if (s.state !== "idle" || !s.codexJoined) {
        s.idleSince = 0;
        continue;
      }
      s.idleSince ||= now;
      if (now - s.idleSince < RELEASE_IDLE_MS) continue;
      const r = await this.call("thread/unsubscribe", { threadId: s.id }).catch(() => null);
      if (r) s.releasedAt = now;
    }
  }

  /**
   * Subscribe to a thread. A brand-new thread has nothing on disk until its first
   * turn, and joining it fails until then, so failures retry quietly.
   */
  async join(threadId, { force = false } = {}) {
    if (this.suppressedThreads.has(threadId)) return null;
    const j = this.joining.get(threadId) || { attempts: 0, lastAt: 0 };
    if (!force && (j.busy || Date.now() - j.lastAt < 4000 || j.attempts > 40)) return null;
    j.busy = true;
    j.attempts++;
    j.lastAt = Date.now();
    this.joining.set(threadId, j);
    try {
      const r = await this.call("thread/resume", { threadId, excludeTurns: true });
      if (isHelperThread(r.thread)) {
        await this.call("thread/unsubscribe", { threadId }).catch(() => {});
        j.attempts = 999; // never retry a helper
        return null;
      }
      if (!this.registry.allows(r.thread.cwd)) {
        await this.call("thread/unsubscribe", { threadId }).catch(() => {});
        j.attempts = 999; // never expose a thread outside the configured roots
        return null;
      }
      const s = this.adopt(r.thread, r.model, r.reasoningEffort);
      this.joining.delete(threadId);
      await this.loadHistory(s).catch((err) => this.log(`codex: history for ${s.project}: ${err.message}`));
      return s;
    } catch (err) {
      if (!/no rollout found/i.test(err.message)) this.log(`codex: join ${threadId.slice(0, 8)}: ${err.message}`);
      return null;
    } finally {
      j.busy = false;
    }
  }

  /** Create or refresh the registry session for a thread. */
  adopt(thread, model, effort) {
    if (!this.registry.allows(thread.cwd)) return null;
    let s = this.session(thread.id);
    const fresh = !s;
    if (!s) {
      s = new Session({ id: thread.id, cwd: thread.cwd });
      s.agent = "codex";
    }
    s.cwd = thread.cwd || s.cwd;
    s.project = basename(s.cwd || "") || "codex";
    s.title = thread.name || clip(thread.preview, 60) || s.title;
    s.model = model || thread.model || s.model;
    s.effort = effort || thread.reasoningEffort || s.effort;
    s.context ??= contextFromRollout(thread.path);
    s.codexJoined = true;
    s.lastActivity = Math.max(s.lastActivity || 0, (thread.updatedAt || 0) * 1000);
    this.applyStatus(s, thread.status);
    if (fresh) this.registry.attach(s);
    else this.registry.changed(s);
    return s;
  }

  async loadHistory(s) {
    const r = await this.call("thread/turns/list", { threadId: s.id, limit: HISTORY_TURNS, sortDirection: "desc", itemsView: "full" });
    const turns = (r.data || []).slice().reverse();
    const inProgress = turns.find((t) => t.status === "inProgress");
    if (inProgress) s.codexTurnId = inProgress.id;
    this.registry.addItems(
      s,
      turns.flatMap((t) => turnItems(t)),
      false,
    );
    this.registry.changed(s);
  }

  applyStatus(s, status) {
    if (!status) return;
    if (status.type === "idle") {
      s.state = "idle";
      s.waiting = null;
      s.activity = "";
    } else if (status.type === "active") {
      const flags = status.activeFlags || [];
      if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) {
        s.state = "waiting";
        // The request itself carries the details; this covers the moment before it arrives.
        s.waiting ||= flags.includes("waitingOnUserInput") ? { kind: "question", questions: [], questionIndex: 0, detail: "Codex has a question" } : { kind: "permission", tool: "Codex", detail: "waiting for approval" };
      } else {
        s.state = "working";
        if (!s.codexRequest) s.waiting = null;
      }
    } else if (status.type === "notLoaded") {
      s.state = "ended";
      s.waiting = null;
      s.codexJoined = false;
    } else if (status.type === "systemError") {
      s.state = "idle";
      s.waiting = null;
    }
  }

  onNotification(method, p) {
    const s = p.threadId ? this.session(p.threadId) : null;
    switch (method) {
      case "thread/started":
        if (!isHelperThread(p.thread) && this.registry.allows(p.thread.cwd) && !this.session(p.thread.id)) void this.join(p.thread.id, { force: true });
        return;
      case "thread/status/changed":
        if (!s) {
          if (p.status?.type === "active") void this.join(p.threadId);
          return;
        }
        this.applyStatus(s, p.status);
        s.lastActivity = Date.now();
        this.registry.changed(s);
        return;
      case "thread/closed":
        if (s) {
          s.state = "ended";
          s.waiting = null;
          s.codexJoined = false;
          this.registry.changed(s);
        }
        return;
      case "thread/name/updated":
        if (s && p.threadName) {
          s.title = p.threadName;
          this.registry.changed(s);
        }
        return;
      case "thread/settings/updated":
        if (s && p.threadSettings) {
          if (p.threadSettings.model) {
            s.model = p.threadSettings.model;
            delete s.codexModel;
          }
          if (Object.hasOwn(p.threadSettings, "effort")) {
            s.effort = p.threadSettings.effort || null;
            delete s.codexEffort;
          }
          this.registry.changed(s);
        }
        return;
      case "thread/tokenUsage/updated":
        if (s) {
          const used = codexContextTokens(p.tokenUsage);
          if (used !== null) s.context = used;
          this.registry.changed(s);
        }
        return;
      case "turn/started":
        if (!s) return;
        s.codexTurnId = p.turn?.id || s.codexTurnId;
        s.state = s.waiting ? "waiting" : "working";
        s.activity = "";
        s.lastActivity = Date.now();
        this.registry.changed(s);
        return;
      case "turn/completed": {
        if (!s) return;
        const turn = p.turn || {};
        s.codexTurnId = null;
        s.codexRequest = null;
        s.state = "idle";
        s.waiting = null;
        s.activity = "";
        s.stoppedAt = Date.now();
        // Items arrived one by one already; this only adds how the turn ended.
        this.registry.addItems(s, turnItems({ ...turn, items: [] }), true);
        const last = [...(turn.items || [])].reverse().find((i) => i.type === "agentMessage")?.text || "";
        if (turn.status !== "interrupted") this.registry.emit("finished", s, turn.status === "failed" ? turn.error?.message || "Turn failed" : last);
        for (const it of turn.items || []) this.itemCache.delete(it.id);
        this.registry.changed(s);
        if (s.openTerminalAfterTurn) {
          s.openTerminalAfterTurn = false;
          void this.openTerminal(s).catch((err) => this.log(`codex: terminal for ${s.project}: ${err.message}`));
        }
        return;
      }
      case "item/started":
        if (!s) return;
        this.itemCache.set(p.item.id, p.item);
        {
          const activity = activityFor(p.item);
          if (activity) {
            s.activity = activity;
            s.lastActivity = Date.now();
            this.registry.changed(s);
          }
        }
        return;
      case "item/completed":
        if (!s) return;
        this.registry.addItems(s, codexItems(p.item, { ts: new Date(p.completedAtMs || Date.now()).toISOString() }), true);
        return;
      case "serverRequest/resolved":
        if (s?.codexRequest && String(s.codexRequest.id) === String(p.requestId)) {
          s.codexRequest = null;
          s.waiting = null;
          if (s.state === "waiting") s.state = "working";
          this.registry.changed(s);
        }
        return;
      default:
    }
  }

  onServerRequest(id, method, params) {
    const s = params.threadId ? this.session(params.threadId) : null;
    const waiting = s ? waitingFromRequest(method, params, this.itemCache.get(params.itemId)) : null;
    // Anything the glasses can't answer stays with the terminal, which gets the same request.
    if (!s || !waiting) return;
    s.codexRequest = { id, method, params, answers: {} };
    s.waiting = waiting;
    s.state = "waiting";
    s.lastActivity = Date.now();
    this.registry.changed(s);
    this.registry.emit("attention", s, waiting.kind);
  }

  // ----- actions from the glasses -----

  async requireLive(s) {
    if (s.state === "ended") throw Object.assign(new Error("session has ended"), { status: 409 });
    if (!this.ready) throw Object.assign(new Error("Codex isn't connected right now"), { status: 503 });
    if (s.releasedAt || !s.codexJoined) {
      // Released while idle (or the connection dropped): take the session back first.
      s.releasedAt = 0;
      if (!(await this.join(s.id, { force: true }))) throw Object.assign(new Error("couldn't reach that Codex session"), { status: 503 });
    }
    s.idleSince = 0;
  }

  input(text) {
    return [{ type: "text", text, text_elements: [] }];
  }

  async prompt(s, text) {
    await this.requireLive(s);
    if (s.waiting?.kind === "permission") throw Object.assign(new Error("Codex is waiting for approval. Choose an option first."), { status: 409 });
    if (s.waiting?.kind === "question") return this.answer(s, text);
    if (s.state === "working" && s.codexTurnId) {
      // Adds to the running turn, the same as typing while Codex works.
      await this.call("turn/steer", { threadId: s.id, input: this.input(text), expectedTurnId: s.codexTurnId });
      return;
    }
    const params = { threadId: s.id, input: this.input(text) };
    const r = await this.call("turn/start", params);
    s.codexTurnId = r?.turn?.id || s.codexTurnId;
    s.state = "working";
    this.registry.changed(s);
    if (s.codexTerminalPending) {
      await this.activateTerminal(s).catch((err) => this.log(`codex: terminal for ${s.project}: ${err.message}`));
    }
  }

  async interrupt(s) {
    await this.requireLive(s);
    if (!s.codexTurnId) return;
    await this.call("turn/interrupt", { threadId: s.id, turnId: s.codexTurnId });
  }

  /** Close the live glasses session while leaving the thread available in History. */
  async end(s) {
    await this.requireLive(s);
    this.suppressedThreads.add(s.id);
    this.joining.delete(s.id);
    s.openTerminalAfterTurn = false;
    s.codexTerminalPending = false;
    if (s.codexTurnId) await this.interrupt(s);
    if (s.tmuxName) {
      await this.tmuxCtl.tmux(null, ["kill-session", "-t", s.tmuxName]).catch((err) => this.log(`codex: close terminal: ${err.message}`));
    }
    s.tmuxName = null;
    s.codexTerminalApp = null;
    await this.call("thread/unsubscribe", { threadId: s.id }).catch(() => {});
    s.codexJoined = false;
    s.state = "ended";
    s.waiting = null;
    s.activity = "";
    s.lastActivity = Date.now();
    this.registry.remove(s.id);
  }

  /** Replace this live row with a genuinely new thread, leaving the old one in History. */
  async clear(s) {
    await this.requireLive(s);
    if (!this.registry.allows(s.cwd)) throw Object.assign(new Error("that folder is outside this hub's allowed roots"), { status: 403 });

    const params = { cwd: s.cwd };
    if (s.model) params.model = s.model;
    const r = await this.call("thread/start", params);
    const replacement = this.adopt(r.thread, r.model, r.reasoningEffort);
    if (!replacement) {
      await this.call("thread/unsubscribe", { threadId: r.thread?.id }).catch(() => {});
      throw Object.assign(new Error("that folder is outside this hub's allowed roots"), { status: 403 });
    }

    try {
      if (s.effort) {
        await this.call("thread/settings/update", { threadId: replacement.id, effort: s.effort });
        replacement.effort = s.effort;
      }
    } catch (err) {
      this.suppressedThreads.add(replacement.id);
      await this.call("thread/unsubscribe", { threadId: replacement.id }).catch(() => {});
      this.registry.remove(replacement.id);
      throw err;
    }

    const reopenTerminal = !!s.tmuxName;
    replacement.model = s.model || replacement.model;
    replacement.context = null;
    replacement.origin = s.origin;
    await this.end(s);
    if (reopenTerminal) {
      await this.openPendingTerminal(replacement).catch((err) => this.log(`codex: terminal for ${replacement.project}: ${err.message}`));
    }
    this.registry.changed(replacement);
    return replacement;
  }

  dialog(s) {
    const w = s.waiting;
    if (!w) return { kind: "input", options: [] };
    if (w.kind === "question") return { kind: "question", options: (w.questions?.[w.questionIndex || 0]?.options || []).map((o) => o.label) };
    return { kind: "permission", options: w.options || APPROVE };
  }

  async choose(s, kind, index) {
    await this.requireLive(s);
    const req = s.codexRequest;
    if (!req) throw Object.assign(new Error("nothing is waiting for an answer"), { status: 409 });
    if (kind === "question") {
      const q = s.waiting?.questions?.[s.waiting.questionIndex || 0];
      const label = q?.options?.[index]?.label;
      if (!label) throw Object.assign(new Error(`option ${index + 1} not available`), { status: 400 });
      return this.recordAnswer(s, label);
    }
    const options = s.waiting?.options || APPROVE;
    if (index < 0 || index >= options.length) throw Object.assign(new Error(`option ${index + 1} not available`), { status: 400 });
    this.respond(req.id, approvalResult(req.method, req.params, index));
    this.settle(s);
    return options[index];
  }

  async answer(s, text) {
    await this.requireLive(s);
    if (s.waiting?.kind !== "question" || !s.codexRequest) throw Object.assign(new Error("no question is waiting"), { status: 409 });
    return this.recordAnswer(s, String(text || "").trim());
  }

  /** Questions arrive together; answer them one at a time, then send all the answers. */
  recordAnswer(s, value) {
    const req = s.codexRequest;
    const w = s.waiting;
    const q = w.questions[w.questionIndex || 0];
    if (q) req.answers[q.id] = { answers: [value] };
    w.questionIndex = (w.questionIndex || 0) + 1;
    if (w.questionIndex >= w.questions.length) {
      this.respond(req.id, { answers: req.answers });
      this.settle(s);
    } else {
      w.detail = clip(w.questions[w.questionIndex].question);
      this.registry.changed(s);
    }
    return value;
  }

  settle(s) {
    s.codexRequest = null;
    s.waiting = null;
    s.state = "working";
    this.registry.changed(s);
  }

  async compact(s) {
    await this.requireLive(s);
    await this.call("thread/compact/start", { threadId: s.id });
  }

  /** Applies from the next prompt sent from the glasses; the server keeps it for later turns. */
  async setModel(s, model) {
    await this.requireLive(s);
    if (this.models.length && !this.models.some((m) => m.id === model)) throw Object.assign(new Error(`unknown Codex model ${model}`), { status: 400 });
    await this.call("thread/settings/update", { threadId: s.id, model });
    delete s.codexModel;
    s.model = model;
    this.registry.changed(s);
  }

  /** Applies from the next prompt and persists with the Codex thread. */
  async setEffort(s, effort) {
    await this.requireLive(s);
    const model = this.models.find((m) => m.id === s.model);
    if (model?.efforts?.length && !model.efforts.includes(effort)) {
      throw Object.assign(new Error(`${model.name} efforts: ${model.efforts.join(", ")}`), { status: 400 });
    }
    await this.call("thread/settings/update", { threadId: s.id, effort });
    delete s.codexEffort;
    s.effort = effort;
    this.registry.changed(s);
  }

  // ----- starting and resuming -----

  /** Recent Codex sessions for the resume picker, newest first. */
  async recent({ limit = 15, liveIds = new Set() } = {}) {
    if (!this.ready) return [];
    const r = await this.call("thread/list", { limit: limit * 2, archived: false });
    const out = [];
    for (const t of r.data || []) {
      if (isHelperThread(t) || liveIds.has(t.id) || !t.cwd || !existsSync(t.cwd) || !this.registry.allows(t.cwd)) continue;
      this.knownThreads.add(t.id);
      out.push({ id: t.id, cwd: t.cwd, project: basename(t.cwd), title: t.name || clip(t.preview, 60), mtime: (t.updatedAt || 0) * 1000, agent: "codex" });
      if (out.length >= limit) break;
    }
    return out;
  }

  isCodexThread(id) {
    return this.knownThreads.has(id) || !!this.session(id);
  }

  /** A new session from the glasses. Its Mac terminal waits visibly until the first message. */
  async startSession({ cwd, prompt, openTerminal = false }) {
    if (!this.ready) throw Object.assign(new Error("Codex isn't connected right now"), { status: 503 });
    const r = await this.call("thread/start", { cwd });
    const s = this.adopt(r.thread, r.model, r.reasoningEffort);
    if (!s) throw Object.assign(new Error("that folder is outside this hub's allowed roots"), { status: 403 });
    s.origin = "glasses";
    s.openTerminalAfterTurn = false;
    const model = this.models.find((m) => m.id === s.model);
    if (model?.efforts?.includes("high") && s.effort !== "high") {
      await this.call("thread/settings/update", { threadId: s.id, effort: "high" });
      s.effort = "high";
      this.registry.changed(s);
    }
    if (openTerminal) {
      await this.openPendingTerminal(s).catch((err) => this.log(`codex: terminal for ${s.project}: ${err.message}`));
    }
    if (prompt) await this.prompt(s, prompt);
    return s;
  }

  async resumeSession({ id, openTerminal = false }) {
    if (!this.ready) throw Object.assign(new Error("Codex isn't connected right now"), { status: 503 });
    this.suppressedThreads.delete(id);
    this.joining.delete(id);
    const s = await this.join(id, { force: true });
    if (!s) throw Object.assign(new Error("couldn't open that Codex session"), { status: 502 });
    s.origin = "glasses";
    if (openTerminal) await this.openTerminal(s).catch((err) => this.log(`codex: terminal for ${s.project}: ${err.message}`));
    return s;
  }

  /** Open a visible waiting terminal for a brand-new thread that Codex cannot resume yet. */
  async openPendingTerminal(s) {
    const name = this.tmuxCtl.sessionNameFor(s.cwd, await this.tmuxCtl.listOurSessions());
    await this.tmuxCtl.tmux(null, [
      "new-session", "-d", "-s", name, "-c", s.cwd, "-x", "200", "-y", "50",
      "--", "/bin/sh", "-c", TERMINAL_WAIT_COMMAND,
    ]);
    s.tmuxName = name;
    s.codexTerminalPending = true;
    this.registry.changed(s);
    try {
      const terminalApp = await this.tmuxCtl.openAttachedTerminal({ cwd: s.cwd, name });
      s.codexTerminalApp = terminalApp;
      this.registry.changed(s);
      this.log(`codex: waiting terminal for ${s.project} in ${terminalApp === "orca" ? "Orca" : "Mac Terminal"} (${name})`);
      return terminalApp;
    } catch (err) {
      await this.tmuxCtl.tmux(null, ["kill-session", "-t", name]).catch(() => {});
      s.tmuxName = null;
      s.codexTerminalPending = false;
      s.codexTerminalApp = null;
      this.registry.changed(s);
      throw err;
    }
  }

  /** Replace the waiting pane with the TUI once the first turn makes the thread resumable. */
  async activateTerminal(s) {
    if (!s.codexTerminalPending || !s.tmuxName || s.state === "ended" || this.suppressedThreads.has(s.id)) return null;
    const args = remoteArgs(this.socket, ["resume", "-c", NO_UPDATE_CHECK, s.id], s.cwd);
    await this.tmuxCtl.tmux(null, [
      "respawn-pane", "-k", "-t", s.tmuxName, "-c", s.cwd,
      "--", ...this.tmuxCtl.loginShellCommand(this.bin, args),
    ]);
    s.codexTerminalPending = false;
    this.registry.changed(s);
    this.log(`codex: attached terminal for ${s.project} (${s.tmuxName})`);
    return s.codexTerminalApp || true;
  }

  /** Run the Codex terminal UI for an existing session in tmux. */
  async openTerminal(s) {
    const name = this.tmuxCtl.sessionNameFor(s.cwd, await this.tmuxCtl.listOurSessions());
    const args = remoteArgs(this.socket, ["resume", "-c", NO_UPDATE_CHECK, s.id], s.cwd);
    await this.tmuxCtl.tmux(null, ["new-session", "-d", "-s", name, "-c", s.cwd, "-x", "200", "-y", "50", "--", ...this.tmuxCtl.loginShellCommand(this.bin, args)]);
    s.tmuxName = name;
    s.codexTerminalPending = false;
    this.registry.changed(s);
    const terminalApp = await this.tmuxCtl.openAttachedTerminal({ cwd: s.cwd, name });
    s.codexTerminalApp = terminalApp;
    this.registry.changed(s);
    this.log(`codex: terminal for ${s.project} in ${terminalApp === "orca" ? "Orca" : "Mac Terminal"} (${name})`);
    return terminalApp;
  }
}
