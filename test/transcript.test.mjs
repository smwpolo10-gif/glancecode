import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryMeta, entryToItems, isLocalCommandOutput, toolLabel, TranscriptTail } from "../hub/transcript.mjs";
import { readClaudeModel, readDialog, readEffort } from "../hub/tmux.mjs";
import { Registry } from "../hub/sessions.mjs";

test("registry ignores hooks outside its allowed roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "glancecode-roots-"));
  const allowed = join(dir, "allowed");
  const blocked = join(dir, "blocked");
  mkdirSync(allowed);
  mkdirSync(blocked);
  const registry = new Registry({ allowedRoots: [allowed] });
  registry.handleHook({ session_id: "blocked", hook_event_name: "SessionStart", cwd: blocked, transcript_path: join(blocked, "blocked.jsonl") });
  assert.equal(registry.sessions.size, 0);

  const transcript = join(allowed, "allowed.jsonl");
  writeFileSync(transcript, "");
  registry.handleHook({ session_id: "allowed", hook_event_name: "SessionStart", cwd: allowed, transcript_path: transcript });
  assert.equal(registry.sessions.size, 1);
  registry.sessions.get("allowed")?.tail?.close();
});

test("user prompt becomes a user item; injected context is dropped", () => {
  assert.deepEqual(entryToItems({ type: "user", uuid: "u1", message: { content: "fix the build" } }).map((i) => i.kind), ["user"]);
  assert.equal(entryToItems({ type: "user", uuid: "u2", message: { content: "<system-reminder>x</system-reminder>" } }).length, 0);
  assert.equal(entryToItems({ type: "user", uuid: "u3", isMeta: true, message: { content: "hello" } }).length, 0);
  assert.equal(entryToItems({ type: "user", uuid: "u4", isSidechain: true, message: { content: "sub" } }).length, 0);
});

test("task notification becomes a notice with its summary", () => {
  const [item] = entryToItems({
    type: "user",
    uuid: "u5",
    message: { content: "<task-notification><status>completed</status><summary>Background command \"deploy\" completed</summary></task-notification>" },
  });
  assert.equal(item.kind, "notice");
  assert.match(item.text, /deploy/);
});

test("slash commands and their output become notices", () => {
  const [cmd] = entryToItems({ type: "user", uuid: "c1", message: { content: "<command-name>/model</command-name><command-args>opus</command-args>" } });
  assert.deepEqual([cmd.kind, cmd.text], ["notice", "/model opus"]);
  const [out] = entryToItems({ type: "user", uuid: "c2", message: { content: "<local-command-stdout>Set model to Opus</local-command-stdout>" } });
  assert.equal(out.text, "Set model to Opus");
  assert.equal(isLocalCommandOutput({ type: "user", message: { content: "<local-command-stdout>Set model to Opus</local-command-stdout>" } }), true);
  assert.equal(isLocalCommandOutput({ type: "user", message: { content: "ordinary prompt" } }), false);
});

test("assistant text, tool calls, and failed tool results", () => {
  const items = entryToItems({
    type: "assistant",
    uuid: "a1",
    message: {
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Looking now." },
        { type: "tool_use", name: "Edit", input: { file_path: "/x/y/grocery_screen.dart" } },
      ],
    },
  });
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [["assistant", "Looking now."], ["tool", "grocery_screen.dart"]]);
  const [err] = entryToItems({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", is_error: true, content: "\nExit code 1\nmore" }] } });
  assert.deepEqual([err.kind, err.text], ["error", "Exit code 1"]);
});

test("synthetic assistant messages: limits surface as errors, filler is skipped", () => {
  const limit = entryToItems({ type: "assistant", uuid: "s1", message: { model: "<synthetic>", content: [{ type: "text", text: "You've reached your Fable limit." }] } });
  assert.equal(limit[0].kind, "error");
  const filler = entryToItems({ type: "assistant", uuid: "s2", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } });
  assert.equal(filler.length, 0);
});

test("queued prompts typed while busy show as user items", () => {
  const [q] = entryToItems({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: "also run lint" } });
  assert.deepEqual([q.kind, q.text], ["user", "also run lint"]);
});

test("meta: title, model, effort and context size", () => {
  assert.deepEqual(entryMeta({ type: "ai-title", aiTitle: "Grocery fixes" }), { title: "Grocery fixes" });
  const m = entryMeta({ type: "assistant", effort: "xhigh", message: { model: "claude-opus-5", usage: { input_tokens: 2, cache_read_input_tokens: 1000 } } });
  assert.deepEqual(m, { model: "claude-opus-5", context: 1002, effort: "xhigh" });
});

test("tool labels", () => {
  assert.equal(toolLabel("Bash", { command: "npm test", description: "Run the suite" }), "Run the suite");
  assert.equal(toolLabel("WebFetch", { url: "https://example.com/a" }), "example.com");
  assert.equal(toolLabel("mcp__github__create_issue", {}), "create_issue");
});

test("TranscriptTail emits only complete new lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-tail-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", uuid: "old" }) + "\n");
  const tail = new TranscriptTail(file, { fromOffset: 0, pollMs: 50 });
  const seen = [];
  tail.on("entry", (e) => seen.push(e.uuid));
  tail.start();
  appendFileSync(file, JSON.stringify({ type: "user", uuid: "new" }) + "\n" + '{"type":"user","uu');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen, ["old", "new"]);
  appendFileSync(file, 'id":"split"}\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen, ["old", "new", "split"]);
  tail.close();
});

test("readDialog recognizes Claude Code's permission, question and trust screens", () => {
  const permission = ` Bash command
   touch made-by-test.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/proj from this project
   3. No
 Esc to cancel · Tab to amend`;
  assert.deepEqual(readDialog(permission), { kind: "permission", options: ["Yes", "Yes, and always allow access to /tmp/proj from this project", "No"] });

  const question = ` ☐ Fruit choice
Which fruit do you prefer?
❯ 1. Apple
     A crisp, sweet red fruit
  2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;
  const q = readDialog(question);
  assert.equal(q.kind, "question");
  assert.equal(q.options[3], "Type something.");

  const trust = ` Quick safety check: Is this a project you created or one you trust?
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
  assert.equal(readDialog(trust).kind, "trust");

  const idle = `⏺ pong
────────────────
❯
────────────────
  ⏸ manual mode on · ? for shortcuts`;
  assert.equal(readDialog(idle).kind, "input");
});

test("readEffort reads Claude Code's exact status-line value", () => {
  assert.equal(readEffort("  ◉ xhigh · /effort"), "xhigh");
  assert.equal(readEffort("Opus 5 (1M context) with xhigh effort · Claude Max"), "xhigh");
  assert.equal(readClaudeModel("Opus 5 (1M context) with xhigh effort · Claude Max"), "Opus 5");
  assert.equal(readClaudeModel("  │ Nebula Experimental 7.2 (200K context) with medium effort · Claude Max"), "Nebula Experimental 7.2");
  assert.equal(readClaudeModel("Fable (1M context) with high effort"), "Fable");
  assert.equal(readEffort("Opus 5 · idle"), null);
});

test("transcript cleanup drops sound-effect captions and silence hallucinations", async () => {
  const { cleanTranscript } = await import("../hub/stt.mjs");
  assert.equal(cleanTranscript("*phone rings*"), "");
  assert.equal(cleanTranscript("[music] Please run the tests (laughs)"), "Please run the tests");
  assert.equal(cleanTranscript(" Thank you. "), "");
  assert.equal(cleanTranscript("Commit it, then deploy."), "Commit it, then deploy.");
});

test("an interrupted request renders as a notice, not a user prompt", () => {
  const [item] = entryToItems({ type: "user", uuid: "i1", message: { content: "[Request interrupted by user for tool use]" } });
  assert.deepEqual([item.kind, item.text], ["notice", "Interrupted"]);
});

test("non-empty thinking blocks are the progress messages the terminal shows", () => {
  const items = entryToItems({
    type: "assistant",
    uuid: "t1",
    message: { model: "claude-opus-5", content: [{ type: "thinking", thinking: "The grocery API deployed successfully. Checking the live list next." }, { type: "thinking", thinking: "" }] },
  });
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [["assistant", "The grocery API deployed successfully. Checking the live list next."]]);
});

test("delivery check matches a prompt across wrapped terminal lines", async () => {
  const { promptSnippet, screenHasSnippet } = await import("../hub/tmux.mjs");
  const text = "I am not sure if it is worth mentioning, but if I have garlic added twice";
  const snip = promptSnippet(text);
  assert.ok(screenHasSnippet("❯ I am not sure if it is worth\n  mentioning, but if I have garlic", snip));
  assert.ok(screenHasSnippet("  ❯ I am not sure if it is worth mentio\n    ning, but if I", snip));
  assert.ok(!screenHasSnippet("⏺ something else entirely", snip));
});
