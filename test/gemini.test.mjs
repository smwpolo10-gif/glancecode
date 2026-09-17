import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gemini = await import("../hub/gemini.mjs");

test("gemini hooks translate to the events the registry knows", () => {
  const { normalizeGeminiHook } = gemini;
  const base = { session_id: "s1", transcript_path: "/Users/me/.gemini/tmp/app/chats/session-x-s1.jsonl", cwd: "/p" };
  assert.equal(normalizeGeminiHook({ ...base, hook_event_name: "BeforeAgent", prompt: "go" }).hook_event_name, "UserPromptSubmit");
  const tool = normalizeGeminiHook({ ...base, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "npm test", description: "Run the tests" } });
  assert.deepEqual([tool.hook_event_name, tool.tool_name, tool.tool_label], ["PreToolUse", "Shell", "Run the tests"]);
  const stop = normalizeGeminiHook({ ...base, hook_event_name: "AfterAgent", prompt_response: "All green." });
  assert.deepEqual([stop.hook_event_name, stop.last_assistant_message], ["Stop", "All green."]);
  const perm = normalizeGeminiHook({ ...base, hook_event_name: "Notification", notification_type: "ToolPermission", message: "Tool Confirm", details: { command: "rm -rf build" } });
  assert.deepEqual([perm.notification_type, perm.message], ["permission_prompt", "rm -rf build"]);
  assert.equal(normalizeGeminiHook({ ...base, hook_event_name: "PreCompress" }), null);
  assert.equal(gemini.isGeminiTranscript(base.transcript_path), true);
  assert.equal(gemini.isGeminiTranscript("/Users/me/.claude/projects/x/s1.jsonl"), false);
  assert.equal(gemini.isGeminiSubagentTranscript("/Users/me/.gemini/tmp/app/chats/parent-id/sub.jsonl"), true);
});

test("gemini session records become items, including bulk history and cancellations", () => {
  const { geminiEntryToItems } = gemini;
  assert.deepEqual(geminiEntryToItems({ id: "u1", type: "user", timestamp: "t", content: [{ text: "fix the build" }] }), [{ key: "u1", kind: "user", text: "fix the build", ts: "t" }]);
  assert.deepEqual(geminiEntryToItems({ id: "u0", type: "user", content: [{ text: "<session_context>\n..." }] }), []);

  const reply = geminiEntryToItems({
    id: "g1",
    type: "gemini",
    timestamp: "t",
    content: "Running the tests.",
    toolCalls: [
      { id: "c1", name: "run_shell_command", args: { command: "npm test" }, status: "error", resultDisplay: "\n3 failing\n" },
      { id: "c2", name: "replace", args: { file_path: "/p/src/app.ts" }, status: "cancelled" },
    ],
  });
  assert.deepEqual(
    reply.map((i) => [i.kind, i.tool, i.text]),
    [
      ["assistant", undefined, "Running the tests."],
      ["tool", "Shell", "npm test"],
      ["error", undefined, "3 failing"],
      ["tool", "Edit", "app.ts"],
      ["notice", undefined, "Interrupted"],
    ],
  );
  assert.deepEqual(geminiEntryToItems({ id: "i1", type: "info", content: "Request cancelled." }), []);

  const bulk = geminiEntryToItems({ $set: { messages: [{ id: "u1", type: "user", content: [{ text: "hi" }] }, { id: "g2", type: "gemini", content: "hello" }] } });
  assert.deepEqual(
    bulk.map((i) => i.key),
    ["u1", "g2:text"],
  );
  assert.deepEqual(gemini.geminiEntryMeta({ $set: { summary: "Fix the build" } }), { title: "Fix the build" });
  assert.equal(gemini.geminiEntryMeta({ id: "g", type: "gemini", model: "gemini-3.5-flash" }).model, "gemini-3.5-flash");
});

test("gemini dialogs: approvals and trust, ignoring the numbered tips above", () => {
  const { readGeminiDialog } = gemini;
  const approval = [
    "Tips for getting started:",
    "1. Create GEMINI.md files to customize your interactions",
    "2. /help for more information",
    " > Use the shell to run: echo hi > a.txt",
    "╭──────────────╮",
    "│ ? Shell  echo hi > a.txt   │",
    "│ Allow execution of [Shell]? │",
    "│ ● 1. Allow once              │",
    "│   2. Allow for this session  │",
    "│   3. No, suggest changes (esc) │",
    "╰──────────────╯",
  ].join("\n");
  assert.deepEqual(readGeminiDialog(approval), { kind: "permission", options: ["Allow once", "Allow for this session", "No, suggest changes (esc)"] });
  assert.equal(readGeminiDialog(`${approval}\n ✦ Done.\n >   Type your message or @path/to/file`).kind, "input");
  assert.deepEqual(readGeminiDialog("│ Do you trust the files in this folder? │\n│ ● 1. Trust folder (app) │\n│   2. Don't trust │"), { kind: "trust", options: ["Trust folder (app)", "Don't trust"] });
});

test("gemini tool names read like the Claude ones", () => {
  const t = (name, input) => Object.values(gemini.geminiTool(name, input)).join(" ");
  assert.equal(t("read_file", { file_path: "/p/README.md" }), "Read README.md");
  assert.equal(t("write_file", { file_path: "/p/new.ts" }), "Write new.ts");
  assert.equal(t("google_web_search", { query: "tmux copy mode" }), "WebSearch tmux copy mode");
  assert.equal(t("some_mcp_tool", {}), "some_mcp_tool ");
});

test("a resumed gemini session is followed into whichever file it last wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-chats-"));
  const id = "773375a0-82f6-4483-9bea-710fc4b308d9";
  const original = join(dir, "session-2026-09-17T05-33-773375a0.jsonl");
  const resumed = join(dir, "session-2026-09-17T05-44-773375a0.jsonl");
  const other = join(dir, "session-2026-09-17T05-50-ffffffff.jsonl");
  writeFileSync(original, JSON.stringify({ sessionId: id }) + "\n");
  writeFileSync(resumed, JSON.stringify({ sessionId: id }) + "\n");
  writeFileSync(other, JSON.stringify({ sessionId: "ffffffff-0000-0000-0000-000000000000" }) + "\n");
  const now = Date.now() / 1000;
  utimesSync(resumed, now - 60, now - 60);
  utimesSync(original, now, now);
  assert.equal(gemini.geminiSessionFile(resumed, id), original);
});

test("recent gemini sessions come with their project folder and title", () => {
  const home = mkdtempSync(join(tmpdir(), "gemini-home-"));
  const project = mkdtempSync(join(tmpdir(), "gemini-project-"));
  const tmp = join(home, "proj");
  mkdirSync(join(tmp, "chats"), { recursive: true });
  writeFileSync(join(tmp, ".project_root"), project);
  const lines = [{ sessionId: "abcd1234-0000-0000-0000-000000000000", kind: "main" }, { id: "u1", type: "user", content: [{ text: "add dark mode" }] }, { $set: { summary: "Add dark mode" } }];
  writeFileSync(join(tmp, "chats", "session-1-abcd1234.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + " ".repeat(300));
  const found = gemini.recentGeminiSessions({ dir: home });
  assert.deepEqual(
    found.map((s) => [s.id, s.cwd, s.title, s.agent]),
    [["abcd1234-0000-0000-0000-000000000000", project, "Add dark mode", "gemini"]],
  );
  assert.deepEqual(gemini.recentGeminiSessions({ dir: home, liveIds: new Set(["abcd1234-0000-0000-0000-000000000000"]) }), []);
});

test("tmux panes are told apart by server as well as id", async () => {
  const { paneKey } = await import("../hub/tmux.mjs");
  assert.notEqual(paneKey({ socket: "/tmp/tmux-501/one", pane: "%0" }), paneKey({ socket: "/tmp/tmux-501/two", pane: "%0" }));
  assert.equal(paneKey({ pane: "%0" }), null);
});

test("transcript tail starts over when its file is replaced by a rewritten one", async () => {
  const { TranscriptTail } = await import("../hub/transcript.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, JSON.stringify({ n: 1 }) + "\n");
  const seen = [];
  const tail = new TranscriptTail(file, { pollMs: 50 });
  tail.on("entry", (e) => seen.push(e.n));
  tail.read();
  // Replace atomically with a longer file, the way Gemini rewrites history.
  const tmp = join(dir, "t.tmp");
  writeFileSync(tmp, [1, 2, 3].map((n) => JSON.stringify({ n })).join("\n") + "\n");
  renameSync(tmp, file);
  tail.read();
  tail.close();
  assert.deepEqual(seen, [1, 1, 2, 3]);
});
