// Read Claude Code session transcripts (~/.claude/projects/<dir>/<id>.jsonl)
// and turn their entries into small display items for the glasses.
import { EventEmitter } from "node:events";
import { closeSync, openSync, readSync, statSync, watch } from "node:fs";
import { basename } from "node:path";

/**
 * @typedef {{
 *   key: string,          // stable id (entry uuid + block index)
 *   kind: "user"|"assistant"|"tool"|"error"|"notice",
 *   text: string,
 *   tool?: string,        // tool name for kind "tool"
 *   ts?: string,
 * }} Item
 */

const MAX_TEXT = 4000;

export function toolLabel(name, input = {}) {
  const base = (p) => (typeof p === "string" && p ? basename(p) : "");
  const clip = (s, n = 60) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  switch (name) {
    case "Bash":
      return clip(input.description || input.command);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return base(input.file_path || input.notebook_path);
    case "Grep":
      return clip(input.pattern, 40);
    case "Glob":
      return clip(input.pattern, 40);
    case "WebFetch":
      try {
        return new URL(input.url).host;
      } catch {
        return clip(input.url, 40);
      }
    case "WebSearch":
      return clip(input.query, 50);
    case "Agent":
    case "Task":
      return clip(input.description || input.prompt, 50);
    case "Skill":
      return clip(input.skill, 40);
    case "TodoWrite":
      return "update tasks";
    case "AskUserQuestion":
      return clip(input.questions?.[0]?.question, 60);
    default:
      if (name?.startsWith("mcp__")) return name.split("__").pop();
      return clip(input.description || "", 50);
  }
}

function friendlyToolName(name) {
  if (name?.startsWith("mcp__")) return name.split("__")[1] || name;
  return name;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function clipText(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s;
}

/** Parse the <task-notification> block Claude Code injects when background work ends. */
function taskNotice(s) {
  const status = /<status>([^<]*)<\/status>/.exec(s)?.[1];
  const summary = /<summary>([^<]*)<\/summary>/.exec(s)?.[1];
  if (!summary && !status) return "Background task update";
  return summary || `Background task ${status}`;
}

/**
 * Convert one transcript entry into zero or more items.
 * @returns {Item[]}
 */
export function entryToItems(entry) {
  if (!entry || entry.isSidechain) return [];
  const uuid = entry.uuid || `${entry.type}-${entry.timestamp}`;
  const ts = entry.timestamp;
  const out = [];

  if (entry.type === "user") {
    if (entry.isMeta || entry.isCompactSummary) return [];
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      content.forEach((b, i) => {
        if (b?.type === "tool_result" && b.is_error) {
          const t = textOf(b.content).split("\n").find((l) => l.trim()) || "tool failed";
          out.push({ key: `${uuid}:${i}`, kind: "error", text: clipText(t.trim()), ts });
        }
      });
    }
    const text = textOf(content).trim();
    if (!text) return out;
    if (text.startsWith("<task-notification>")) {
      out.push({ key: uuid, kind: "notice", text: taskNotice(text), ts });
    } else if (text.startsWith("<command-name>")) {
      const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
      const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
      if (cmd) out.push({ key: uuid, kind: "notice", text: [cmd, args].filter(Boolean).join(" "), ts });
    } else if (text.startsWith("<local-command-stdout>")) {
      const s = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)?.[1]?.trim();
      if (s) out.push({ key: uuid, kind: "notice", text: clipText(s), ts });
    } else if (/^\[Request interrupted by user/.test(text)) {
      out.push({ key: uuid, kind: "notice", text: "Interrupted", ts });
    } else if (text.startsWith("<")) {
      // system-reminder, local-command-caveat, and other injected context
    } else {
      out.push({ key: uuid, kind: "user", text: clipText(text.replace(/\[Image #\d+\]\s*/g, "[image] ")), ts });
    }
    return out;
  }

  if (entry.type === "assistant") {
    const msg = entry.message || {};
    const synthetic = msg.model === "<synthetic>";
    (msg.content || []).forEach((b, i) => {
      if (b?.type === "text" && b.text?.trim()) {
        const t = b.text.trim();
        if (synthetic) {
          if (t === "No response requested.") return;
          out.push({ key: `${uuid}:${i}`, kind: "error", text: clipText(t), ts });
        } else {
          out.push({ key: `${uuid}:${i}`, kind: "assistant", text: clipText(t), ts });
        }
      } else if (b?.type === "thinking" && b.thinking?.trim() && !synthetic) {
        // Claude Code shows these as the progress messages between tool calls; most
        // thinking blocks are empty in the transcript and the rest are short narration.
        out.push({ key: `${uuid}:${i}`, kind: "assistant", text: clipText(b.thinking.trim()), ts });
      } else if (b?.type === "tool_use") {
        out.push({
          key: `${uuid}:${i}`,
          kind: "tool",
          tool: friendlyToolName(b.name),
          text: toolLabel(b.name, b.input || {}),
          ts,
        });
      }
    });
    return out;
  }

  if (entry.type === "attachment" && entry.attachment?.type === "queued_command") {
    const p = String(entry.attachment.prompt || "").trim();
    if (p && !p.startsWith("<")) out.push({ key: uuid, kind: "user", text: clipText(p), ts });
    return out;
  }

  if (entry.type === "system") {
    if (entry.subtype === "compact_boundary") out.push({ key: uuid, kind: "notice", text: "Conversation compacted", ts });
    if (entry.subtype === "api_error" && entry.content) out.push({ key: uuid, kind: "error", text: clipText(String(entry.content)), ts });
    return out;
  }
  return out;
}

/** Metadata worth keeping per session: title, model, summaries. */
export function entryMeta(entry) {
  if (!entry) return null;
  if (entry.type === "ai-title" && entry.aiTitle) return { title: entry.aiTitle };
  if (entry.type === "custom-title" && entry.customTitle) return { title: entry.customTitle };
  if (entry.type === "assistant" && entry.message?.model && entry.message.model !== "<synthetic>") {
    const u = entry.message.usage || {};
    const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return { model: entry.message.model, context: context || undefined };
  }
  if (entry.type === "system" && entry.subtype === "away_summary" && entry.content) return { summary: String(entry.content) };
  if (entry.type === "user" && typeof entry.permissionMode === "string") return { permissionMode: entry.permissionMode };
  return null;
}

/** Read the last `maxBytes` of a file and return complete lines. */
export function readTailLines(path, maxBytes = 2_000_000) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop partial first line
    return { lines: text.split("\n").filter(Boolean), end: size };
  } finally {
    closeSync(fd);
  }
}

export function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Follows a transcript file as it grows, emitting parsed entries.
 * Events: "entry" (entry)
 */
export class TranscriptTail extends EventEmitter {
  /**
   * @param {string} path
   * @param {{fromOffset?: number, pollMs?: number, resolvePath?: () => string}} [opts]
   *   resolvePath: called on every read, for sessions that can move to another file.
   */
  constructor(path, { fromOffset = 0, pollMs = 1000, resolvePath = null } = {}) {
    super();
    this.path = path;
    this.offset = fromOffset;
    this.partial = "";
    this.pollMs = pollMs;
    this.closed = false;
    this.resolvePath = resolvePath;
    this.ino = null;
  }

  watchPath() {
    this.watcher?.close();
    this.watcher = null;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => this.read());
    } catch {
      /* file may not exist yet; polling covers it */
    }
  }

  start() {
    this.read();
    this.watchPath();
    this.timer = setInterval(() => this.read(), this.pollMs);
    this.timer.unref?.();
    return this;
  }

  read() {
    if (this.closed || this.reading) return;
    this.reading = true;
    try {
      const next = this.resolvePath?.();
      if (next && next !== this.path) {
        // The session moved to another file: read that one from the start.
        this.path = next;
        this.offset = 0;
        this.partial = "";
        this.ino = null;
        this.watchPath();
      }
      let size;
      let ino;
      try {
        ({ size, ino } = statSync(this.path));
      } catch {
        return;
      }
      if (size < this.offset || (this.ino !== null && ino !== this.ino)) {
        // Truncated, or replaced by a rewritten file: start over.
        this.offset = 0;
        this.partial = "";
      }
      this.ino = ino;
      if (size === this.offset) return;
      const fd = openSync(this.path, "r");
      try {
        const len = size - this.offset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, this.offset);
        this.offset = size;
        const text = this.partial + buf.toString("utf8");
        const parts = text.split("\n");
        this.partial = parts.pop() ?? "";
        for (const line of parts) {
          if (!line) continue;
          const entry = parseLine(line);
          if (entry) this.emit("entry", entry);
        }
      } finally {
        closeSync(fd);
      }
    } finally {
      this.reading = false;
    }
  }

  close() {
    this.closed = true;
    this.watcher?.close();
    clearInterval(this.timer);
  }
}
