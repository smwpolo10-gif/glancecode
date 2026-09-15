// Session registry: fed by Claude Code hooks, enriched from transcripts,
// checked against live processes and tmux panes.
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLAUDE_PROJECTS_DIR, STATE_FILE } from "./config.mjs";
import { entryMeta, entryToItems, parseLine, readTailLines, toolLabel, TranscriptTail } from "./transcript.mjs";
import { capture, paneAlive, readDialog, socketFromTmuxEnv } from "./tmux.mjs";

const MAX_ITEMS = 300;
const HISTORY_ITEMS = 150; // how much history to load when the hub starts watching a session

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * @typedef {"starting"|"working"|"idle"|"waiting"|"ended"} State
 */

export class Session {
  constructor({ id, cwd, transcriptPath }) {
    this.id = id;
    this.cwd = cwd;
    this.project = basename(cwd || "") || "claude";
    this.transcriptPath = transcriptPath;
    /** @type {{socket: string, pane: string} | null} */
    this.tmux = null;
    this.pid = null;
    /** @type {State} */
    this.state = "starting";
    this.activity = ""; // "Edit foo.ts"
    /** @type {null | {kind: "permission"|"question", tool?: string, detail?: string, questions?: any[], questionIndex?: number}} */
    this.waiting = null;
    this.model = null;
    this.context = null;
    this.permissionMode = null;
    this.title = null;
    this.summary = null;
    this.origin = "terminal";
    this.tmuxName = null;
    this.lastActivity = Date.now();
    this.backgroundTasks = 0;
    /** @type {import("./transcript.mjs").Item[]} */
    this.items = [];
    this.itemKeys = new Set();
    this.tail = null;
  }

  get controllable() {
    return !!this.tmux && this.state !== "ended";
  }

  summaryJSON() {
    return {
      id: this.id,
      project: this.project,
      cwd: this.cwd,
      state: this.state,
      activity: this.activity,
      waiting: this.waiting,
      model: this.model,
      context: this.context,
      permissionMode: this.permissionMode,
      title: this.title,
      summary: this.summary,
      origin: this.origin,
      controllable: this.controllable,
      tmuxName: this.tmuxName,
      lastActivity: this.lastActivity,
      backgroundTasks: this.backgroundTasks,
      itemCount: this.items.length,
    };
  }

  persistJSON() {
    return {
      id: this.id,
      cwd: this.cwd,
      transcriptPath: this.transcriptPath,
      tmux: this.tmux,
      pid: this.pid,
      origin: this.origin,
      tmuxName: this.tmuxName,
      state: this.state,
      lastActivity: this.lastActivity,
    };
  }
}

export class Registry extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.saveTimer = null;
  }

  // ---------- persistence ----------

  load() {
    if (!existsSync(STATE_FILE)) return;
    let saved;
    try {
      saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      return;
    }
    for (const s of saved.sessions || []) {
      if (!s.id || !s.transcriptPath) continue;
      if (!pidAlive(s.pid)) continue; // only restore sessions whose process still runs
      const session = new Session(s);
      Object.assign(session, { tmux: s.tmux, pid: s.pid, origin: s.origin || "terminal", tmuxName: s.tmuxName || null });
      session.state = "idle"; // waiting details are not persisted; the next hook or sweep corrects it
      session.lastActivity = s.lastActivity || Date.now();
      this.attach(session);
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const sessions = [...this.sessions.values()].filter((s) => s.state !== "ended").map((s) => s.persistJSON());
      try {
        writeFileSync(STATE_FILE, JSON.stringify({ sessions }, null, 2));
      } catch {
        /* non-fatal */
      }
    }, 500);
    this.saveTimer.unref?.();
  }

  // ---------- transcript ----------

  attach(session) {
    this.sessions.set(session.id, session);
    this.loadHistory(session);
    this.scheduleSave();
    this.changed(session);
  }

  loadHistory(session) {
    const path = session.transcriptPath;
    if (!path || !existsSync(path)) {
      session.tail = new TranscriptTail(path, { fromOffset: 0 }).start();
    } else {
      // Screenshots and big tool outputs can make a few megabytes cover only minutes,
      // so widen the window until there is enough to show or the whole file is read.
      let end = 0;
      for (const maxBytes of [2e6, 8e6, 32e6, 128e6]) {
        session.items = [];
        session.itemKeys = new Set();
        const tail = readTailLines(path, maxBytes);
        end = tail.end;
        for (const line of tail.lines) this.applyEntry(session, parseLine(line), false);
        if (session.items.length >= HISTORY_ITEMS || maxBytes >= tail.end) break;
      }
      session.tail = new TranscriptTail(path, { fromOffset: end }).start();
    }
    session.tail.on("entry", (entry) => this.applyEntry(session, entry, true));
  }

  applyEntry(session, entry, live) {
    if (!entry) return;
    // A resumed session appends to a file whose entries carry the same session id,
    // but forks write other ids; ignore entries that belong to another session.
    if (entry.sessionId && entry.sessionId !== session.id) return;
    const meta = entryMeta(entry);
    if (meta) {
      if (meta.title) session.title = meta.title;
      if (meta.model) session.model = meta.model;
      if (meta.context) session.context = meta.context;
      if (meta.summary) session.summary = meta.summary;
      if (meta.permissionMode) session.permissionMode = meta.permissionMode;
    }
    const fresh = [];
    for (const item of entryToItems(entry)) {
      if (session.itemKeys.has(item.key)) continue;
      session.itemKeys.add(item.key);
      session.items.push(item);
      fresh.push(item);
    }
    if (session.items.length > MAX_ITEMS) {
      const drop = session.items.splice(0, session.items.length - MAX_ITEMS);
      for (const d of drop) session.itemKeys.delete(d.key);
    }
    if (live && fresh.length) {
      session.lastActivity = Date.now();
      // Interrupts and declined permissions end the turn without a Stop hook.
      if (fresh.some((i) => i.kind === "notice" && i.text === "Interrupted")) {
        session.state = "idle";
        session.waiting = null;
        session.activity = "";
        session.stoppedAt = Date.now();
        this.changed(session);
      }
      // Output written after the last Stop means the model woke on its own (a background
      // task finished). Output from before the Stop is just the tail catching up.
      const wokeUp = fresh.some((i) => (i.kind === "assistant" || i.kind === "tool") && Date.parse(i.ts || "") > (session.stoppedAt || 0));
      if (session.state === "idle" && wokeUp) {
        session.state = "working";
        this.changed(session);
      }
      this.emit("items", session, fresh);
    }
    if (live && meta) this.changed(session);
  }

  // ---------- hooks ----------

  /**
   * @param {object} payload hook stdin JSON
   * @param {{tmux?: string, pane?: string, ppid?: string}} env
   */
  handleHook(payload, env = {}) {
    const id = payload?.session_id;
    const event = payload?.hook_event_name;
    if (!id || !event) return;
    if (payload.agent_id) return; // subagent-level hooks: the parent session's state is what matters

    let session = this.sessions.get(id);
    if (!session) {
      if (event === "SessionEnd") return;
      session = new Session({ id, cwd: payload.cwd, transcriptPath: payload.transcript_path });
      const pending = this.pendingLaunch(env.pane);
      if (pending) {
        session.origin = pending.origin;
        session.tmuxName = pending.name;
      }
      this.attach(session);
    }
    if (env.pane && env.tmux) {
      const socket = socketFromTmuxEnv(env.tmux);
      if (socket) session.tmux = { socket, pane: env.pane };
    }
    const ppid = Number(env.ppid);
    if (ppid > 1) session.pid = ppid;
    if (payload.cwd && payload.cwd !== session.cwd) {
      session.cwd = payload.cwd;
      session.project = basename(payload.cwd);
    }
    if (payload.permission_mode) session.permissionMode = payload.permission_mode;
    if (payload.model) session.model = payload.model;
    session.lastActivity = Date.now();

    switch (event) {
      case "SessionStart":
        session.state = "idle";
        session.waiting = null;
        break;
      case "UserPromptSubmit":
        session.state = "working";
        session.activity = "";
        session.waiting = null;
        break;
      case "PreToolUse":
        session.state = "working";
        session.activity = `${payload.tool_name} ${toolLabel(payload.tool_name, payload.tool_input)}`.trim();
        if (payload.tool_name === "AskUserQuestion") {
          session.waiting = { kind: "question", questions: payload.tool_input?.questions || [], questionIndex: 0 };
          session.state = "waiting";
        } else {
          session.lastTool = { tool: payload.tool_name, detail: toolLabel(payload.tool_name, payload.tool_input), input: payload.tool_input };
        }
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (session.waiting?.kind === "question" && payload.tool_name === "AskUserQuestion") session.waiting = null;
        if (session.waiting?.kind === "permission") session.waiting = null;
        session.state = "working";
        break;
      case "PermissionDenied":
        if (session.waiting?.kind === "permission") session.waiting = null;
        break;
      case "Notification":
        if (payload.notification_type === "permission_prompt" && session.waiting?.kind !== "question") {
          session.state = "waiting";
          session.waiting = { kind: "permission", tool: session.lastTool?.tool, detail: session.lastTool?.detail || payload.message };
          this.emit("attention", session, "permission");
        } else if (payload.notification_type === "elicitation_dialog" || payload.notification_type === "agent_needs_input") {
          session.state = "waiting";
          session.waiting = { kind: "question", questions: [], questionIndex: 0, detail: payload.message };
          this.emit("attention", session, "question");
        }
        break;
      case "Stop":
        session.stoppedAt = Date.now();
        session.state = "idle";
        session.waiting = null;
        session.activity = "";
        session.backgroundTasks = Array.isArray(payload.background_tasks) ? payload.background_tasks.length : 0;
        this.emit("finished", session, payload.last_assistant_message || "");
        break;
      case "StopFailure":
        session.stoppedAt = Date.now();
        session.state = "idle";
        session.waiting = null;
        session.activity = "";
        this.emit("finished", session, "Turn ended with an API error");
        break;
      case "SessionEnd":
        session.state = "ended";
        session.waiting = null;
        break;
    }
    if (session.waiting?.kind === "question" && event === "PreToolUse") this.emit("attention", session, "question");
    session.transcriptPath = payload.transcript_path || session.transcriptPath;
    this.scheduleSave();
    this.changed(session);
  }

  // ---------- launches from the glasses ----------

  pendingLaunches = new Map(); // pane -> {name, origin}

  expectLaunch(pane, info) {
    this.pendingLaunches.set(pane, info);
    setTimeout(() => this.pendingLaunches.delete(pane), 120_000).unref?.();
  }

  pendingLaunch(pane) {
    if (!pane) return null;
    const p = this.pendingLaunches.get(pane);
    if (p) this.pendingLaunches.delete(pane);
    return p;
  }

  // ---------- liveness ----------

  async sweep() {
    for (const s of this.sessions.values()) {
      if (s.state === "ended") continue;
      let alive = s.pid ? pidAlive(s.pid) : true;
      if (alive && s.tmux) {
        const paneOk = await paneAlive(s.tmux);
        if (!paneOk) s.tmux = null;
      }
      // A waiting state with no dialog on screen is stale (answered at the desk,
      // declined, or interrupted without a hook). Clear it after two checks.
      if (alive && s.tmux && s.waiting) {
        try {
          const kind = readDialog(await capture(s.tmux, 40)).kind;
          const onScreen = kind === "permission" || kind === "question" || kind === "unknown";
          s.staleWaitingChecks = onScreen ? 0 : (s.staleWaitingChecks || 0) + 1;
          if (s.staleWaitingChecks >= 2) {
            s.waiting = null;
            s.staleWaitingChecks = 0;
            if (s.state === "waiting") s.state = kind === "input" ? "idle" : "working";
            this.changed(s);
          }
        } catch {
          /* pane busy or gone */
        }
      }
      if (!alive) {
        s.state = "ended";
        s.waiting = null;
        this.changed(s);
      }
    }
    // Forget ended sessions after 10 minutes.
    for (const [id, s] of this.sessions) {
      if (s.state === "ended" && Date.now() - s.lastActivity > 10 * 60_000) {
        s.tail?.close();
        this.sessions.delete(id);
        this.emit("removed", s);
      }
    }
    this.scheduleSave();
  }

  changed(session) {
    this.emit("session", session);
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }
}

/**
 * Recent sessions on disk that are not live, for "resume" on the glasses.
 * @returns {{id: string, cwd: string, project: string, title: string, mtime: number}[]}
 */
export function recentTranscripts({ liveIds = new Set(), days = 14, limit = 30 } = {}) {
  const out = [];
  const cutoff = Date.now() - days * 86_400_000;
  let dirs = [];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(CLAUDE_PROJECTS_DIR, d);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff || st.size < 200) continue;
      const id = f.slice(0, -6);
      if (liveIds.has(id)) continue;
      out.push({ id, path, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(({ id, path, mtime }) => {
    let cwd = "";
    let title = "";
    let firstPrompt = "";
    try {
      const { lines } = readTailLines(path, 400_000);
      for (let i = lines.length - 1; i >= 0 && !(cwd && title); i--) {
        const e = parseLine(lines[i]);
        if (!e) continue;
        if (!cwd && e.cwd) cwd = e.cwd;
        if (!title && e.type === "ai-title" && e.aiTitle) title = e.aiTitle;
        if (!title && e.type === "custom-title" && e.customTitle) title = e.customTitle;
      }
      if (!title) {
        for (const line of lines) {
          const e = parseLine(line);
          const t = e?.type === "user" && typeof e.message?.content === "string" ? e.message.content : "";
          if (t && !t.startsWith("<")) {
            firstPrompt = t;
            break;
          }
        }
      }
    } catch {
      /* unreadable */
    }
    return { id, cwd, project: basename(cwd || "") || "?", title: title || firstPrompt.slice(0, 60), mtime };
  });
}

/** Distinct project folders from recent transcripts, most recent first. */
export function recentProjects(limit = 15) {
  const seen = new Map();
  for (const t of recentTranscripts({ days: 60, limit: 200 })) {
    if (t.cwd && !seen.has(t.cwd) && existsSync(t.cwd)) seen.set(t.cwd, t.mtime);
  }
  return [...seen.entries()].slice(0, limit).map(([cwd, mtime]) => ({ cwd, project: basename(cwd), mtime }));
}
