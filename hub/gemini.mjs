// Gemini CLI support. Gemini's hooks and session files are close to Claude Code's, so
// Gemini sessions take the same path: hooks tell the hub what a session is doing, its
// JSONL session file supplies the transcript, and tmux carries keys into the terminal.
// This module holds what differs: event names, tool names, the session record format
// and the look of its dialogs.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseLine, readTailLines } from "./transcript.mjs";

export const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");
export const GEMINI_SETTINGS = join(homedir(), ".gemini", "settings.json");
export const GEMINI_HOOK_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification"];

const MAX_TEXT = 4000;
const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const clipText = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

/** Session files live under ~/.gemini/tmp/<project>/chats/. */
export function isGeminiTranscript(path) {
  return typeof path === "string" && /\/\.gemini\/tmp\/[^/]+\/chats\//.test(path);
}

/** Sub-agents write into a folder named after their parent session. */
export function isGeminiSubagentTranscript(path) {
  return isGeminiTranscript(path) && /\/chats\/[^/]+\/[^/]+$/.test(path);
}

// ---------- tools ----------

/** Display name and short detail for a Gemini tool call, in the words the glasses use for Claude. */
export function geminiTool(name, input = {}) {
  const base = (p) => (typeof p === "string" && p ? basename(p) : "");
  switch (name) {
    case "run_shell_command":
      return { tool: "Shell", text: clip(input.description || input.command) };
    case "read_file":
    case "read_many_files":
      return { tool: "Read", text: base(input.file_path || input.absolute_path) || clip((input.paths || []).join(", "), 50) };
    case "write_file":
      return { tool: "Write", text: base(input.file_path) };
    case "replace":
    case "edit":
      return { tool: "Edit", text: base(input.file_path) };
    case "glob":
      return { tool: "Glob", text: clip(input.pattern, 40) };
    case "search_file_content":
    case "grep":
    case "grep_search":
      return { tool: "Grep", text: clip(input.pattern, 40) };
    case "list_directory":
      return { tool: "List", text: base(input.dir_path || input.path) || "files" };
    case "web_fetch":
      return { tool: "WebFetch", text: clip(input.prompt || input.url, 40) };
    case "google_web_search":
      return { tool: "WebSearch", text: clip(input.query, 50) };
    case "save_memory":
      return { tool: "Memory", text: clip(input.fact, 50) };
    case "write_todos":
      return { tool: "Todos", text: "update tasks" };
    default:
      return { tool: name || "Tool", text: clip(input.description || "", 50) };
  }
}

// ---------- hooks ----------

/**
 * Translate a Gemini hook payload into the Claude Code shape the registry handles.
 * Returns null for events the glasses don't need.
 */
export function normalizeGeminiHook(p) {
  const out = { ...p };
  switch (p.hook_event_name) {
    case "SessionStart":
    case "SessionEnd":
      return out;
    case "BeforeAgent":
      return { ...out, hook_event_name: "UserPromptSubmit" };
    case "BeforeTool": {
      const t = geminiTool(p.tool_name, p.tool_input || {});
      return { ...out, hook_event_name: "PreToolUse", tool_name: t.tool, tool_label: t.text };
    }
    case "AfterTool":
      return { ...out, hook_event_name: "PostToolUse", tool_name: geminiTool(p.tool_name, p.tool_input || {}).tool };
    case "AfterAgent":
      return { ...out, hook_event_name: "Stop", last_assistant_message: p.prompt_response || "" };
    case "Notification":
      if (p.notification_type !== "ToolPermission") return null;
      return { ...out, notification_type: "permission_prompt", message: clip(p.details?.command || p.details?.title || p.message) };
    default:
      return null; // PreCompress, model hooks
  }
}

// ---------- transcript ----------

function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" && !part.thought ? part.text : ""))
    .join("")
    .trim();
}

function firstLine(value) {
  const text = typeof value === "string" ? value : partsText(value);
  return (
    String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || ""
  );
}

/**
 * One Gemini session record as display items. A message is written again whenever it
 * changes (a tool call finishing, say), with the same id, so keys are stable per
 * message and per tool call and a repeat adds only what is new.
 */
export function geminiEntryToItems(record) {
  // History rewritten in bulk (after a resume, for example) arrives as one $set record.
  if (Array.isArray(record?.$set?.messages)) return record.$set.messages.flatMap((m) => geminiEntryToItems(m));
  if (!record || typeof record !== "object" || !record.id || !record.type) return [];
  const { id, timestamp: ts } = record;
  const out = [];
  switch (record.type) {
    case "user": {
      const text = partsText(record.displayContent || record.content);
      if (text && !text.startsWith("<")) out.push({ key: id, kind: "user", text: clipText(text), ts });
      return out;
    }
    case "gemini": {
      const text = partsText(record.content);
      if (text) out.push({ key: `${id}:text`, kind: "assistant", text: clipText(text), ts });
      for (const tc of record.toolCalls || []) {
        const t = geminiTool(tc.name, tc.args || {});
        out.push({ key: `${id}:${tc.id}`, kind: "tool", tool: t.tool, text: t.text, ts: tc.timestamp || ts });
        if (tc.status === "error") out.push({ key: `${tc.id}:err`, kind: "error", text: clipText(firstLine(tc.resultDisplay) || firstLine(tc.result) || `${t.tool} failed`), ts: tc.timestamp || ts });
        if (tc.status === "cancelled") out.push({ key: `${tc.id}:cancelled`, kind: "notice", text: "Interrupted", ts: tc.timestamp || ts });
      }
      return out;
    }
    case "info":
    case "warning": {
      const text = partsText(record.content);
      // A cancelled tool call already shows as "Interrupted".
      if (text && text !== "Request cancelled.") out.push({ key: id, kind: "notice", text: clipText(text), ts });
      return out;
    }
    case "error": {
      const text = partsText(record.content);
      if (text) out.push({ key: id, kind: "error", text: clipText(text), ts });
      return out;
    }
    default:
      return out;
  }
}

/** Title and model worth keeping per session. */
export function geminiEntryMeta(record) {
  if (!record || typeof record !== "object") return null;
  const set = record.$set;
  if (set && typeof set.summary === "string" && set.summary) return { title: set.summary };
  if (typeof record.summary === "string" && record.summary && record.sessionId) return { title: record.summary };
  if (record.type === "gemini" && record.model) {
    const t = record.tokens;
    return { model: record.model, context: t ? (t.input || 0) + (t.cached || 0) || undefined : undefined };
  }
  return null;
}

/**
 * The file a Gemini session is writing to. Resuming starts a short-lived file for the
 * session and then goes back to writing the original, so the hook's path can be stale:
 * follow whichever file for this session id changed last.
 */
export function geminiSessionFile(path, sessionId) {
  if (!path || !sessionId) return path;
  const dir = dirname(path);
  const suffix = `-${sessionId.slice(0, 8)}.jsonl`;
  let best = path;
  let bestTime = -1;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(suffix)) continue;
      const file = join(dir, name);
      const head = parseLine(readHead(file, 2048).split("\n")[0]);
      if (head?.sessionId && head.sessionId !== sessionId) continue;
      const mtime = statSync(file).mtimeMs;
      if (mtime > bestTime) {
        best = file;
        bestTime = mtime;
      }
    }
  } catch {
    /* folder not there yet */
  }
  return best;
}

// ---------- dialogs ----------

/**
 * What Gemini CLI is showing at the bottom of the pane. Its dialogs sit in boxes drawn
 * with │, and the highlighted option carries a ● before its number.
 * @returns {{kind: "permission"|"trust"|"input"|"unknown", options: string[]}}
 */
export function readGeminiDialog(screen) {
  const lines = screen
    .split("\n")
    .map((l) => l.replace(/^[\s│╭╰]+|[\s│╮╯]+$/g, ""))
    .filter((l) => l.trim())
    .slice(-40);
  const isQuestion = (l) => /Do you trust the files in this folder|Allow execution of|Apply this change\?|Do you want to proceed\?/.test(l);
  let question = -1;
  let input = -1;
  lines.forEach((l, i) => {
    if (isQuestion(l)) question = i;
    if (/Type your message/.test(l)) input = i;
  });
  // A dialog counts only when the input box isn't drawn below it, and only its own
  // numbered lines are options, not the numbered tips higher up the screen.
  if (question >= 0 && question > input) {
    const options = [];
    for (const l of lines.slice(question + 1)) {
      const m = /^(?:●\s*)?(\d+)\.\s+(.+?)$/.exec(l.trim());
      if (m) options[Number(m[1]) - 1] = m[2];
    }
    const clean = options.filter(Boolean);
    if (clean.length) return { kind: /Do you trust/.test(lines[question]) ? "trust" : "permission", options: clean };
  }
  if (input >= 0) return { kind: "input", options: [] };
  return { kind: "unknown", options: [] };
}

// ---------- past sessions ----------

function readHead(path, bytes = 8192) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function sessionFiles(chatsDir) {
  try {
    return readdirSync(chatsDir)
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => join(chatsDir, f));
  } catch {
    return [];
  }
}

/**
 * Recent Gemini sessions for the resume picker. Each project folder under
 * ~/.gemini/tmp records its root in .project_root.
 */
export function recentGeminiSessions({ liveIds = new Set(), days = 14, limit = 15, dir = GEMINI_TMP_DIR } = {}) {
  const out = [];
  const cutoff = Date.now() - days * 86_400_000;
  let projects = [];
  try {
    projects = readdirSync(dir);
  } catch {
    return out;
  }
  for (const p of projects) {
    let cwd = "";
    try {
      cwd = readFileSync(join(dir, p, ".project_root"), "utf8").trim();
    } catch {
      continue;
    }
    if (!cwd || !existsSync(cwd)) continue;
    for (const path of sessionFiles(join(dir, p, "chats"))) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff || st.size < 200) continue;
      out.push({ path, cwd, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { path, cwd, mtime } of out) {
    if (sessions.length >= limit) break;
    let title = "";
    let firstPrompt = "";
    // The first line of a session file holds its id; big files only get their tail read below.
    const head = parseLine(readHead(path).split("\n")[0]);
    const id = head?.kind === "subagent" ? "" : head?.sessionId || "";
    try {
      const { lines } = readTailLines(path, 400_000);
      for (const line of lines) {
        const r = parseLine(line);
        if (!r) continue;
        const meta = geminiEntryMeta(r);
        if (meta?.title) title = meta.title;
        if (!firstPrompt && r.type === "user") firstPrompt = partsText(r.content);
      }
    } catch {
      continue;
    }
    if (!id || liveIds.has(id)) continue;
    sessions.push({ id, cwd, project: basename(cwd), title: title || clip(firstPrompt, 60), mtime, agent: "gemini" });
  }
  return sessions;
}
