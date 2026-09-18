import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";

const codex = await import("../hub/codex.mjs");

test("codex context usage supports live and persisted protocol shapes", () => {
  assert.equal(codex.codexContextTokens({ last: { totalTokens: 42_000 } }), 42_000);
  assert.equal(codex.codexContextTokens({ last_token_usage: { total_tokens: 42_000 } }), 42_000);
  assert.equal(codex.codexContextTokens({ turn_token_usage: { total_tokens: 42_000 } }), 42_000);
  assert.equal(codex.codexContextTokens(null), null);
});

test("codex items: messages, commands, edits and failures become glasses items", () => {
  const { codexItems } = codex;
  assert.deepEqual(codexItems({ id: "u1", type: "userMessage", content: [{ type: "text", text: "fix the tests" }, { type: "localImage", path: "/x.png" }] }), [
    { key: "u1", kind: "user", text: "fix the tests [image]", ts: undefined },
  ]);
  assert.equal(codexItems({ id: "a1", type: "agentMessage", text: "  Done.  " })[0].text, "Done.");
  assert.deepEqual(codexItems({ id: "r1", type: "reasoning", summary: ["x"], content: [] }), []);

  const shell = codexItems({ id: "c1", type: "commandExecution", command: `/bin/zsh -lc "printf '%s\\\\n' hi > a.txt"`, commandActions: [{ type: "unknown" }], status: "completed", exitCode: 0 });
  assert.deepEqual(shell, [{ key: "c1", kind: "tool", tool: "Shell", text: "printf '%s\\n' hi > a.txt", ts: undefined }]);

  const read = codexItems({ id: "c2", type: "commandExecution", command: "cat src/app.ts", commandActions: [{ type: "read", command: "cat", name: "app.ts", path: "/p/src/app.ts" }], status: "completed", exitCode: 0 });
  assert.equal(`${read[0].tool} ${read[0].text}`, "Read app.ts");

  const failed = codexItems({ id: "c3", type: "commandExecution", command: "npm test", commandActions: [], status: "failed", exitCode: 1, aggregatedOutput: "\n  1 test failed\nmore" });
  assert.equal(failed[1].kind, "error");
  assert.equal(failed[1].text, "exit 1: 1 test failed");

  const edit = codexItems({ id: "f1", type: "fileChange", status: "completed", changes: [{ path: "/p/a.ts", kind: { type: "update" } }, { path: "/p/b.ts", kind: { type: "update" } }, { path: "/p/c.ts", kind: { type: "update" } }] });
  assert.equal(`${edit[0].tool} ${edit[0].text}`, "Edit a.ts, b.ts +1");
  const add = codexItems({ id: "f2", type: "fileChange", status: "declined", changes: [{ path: "/p/new.md", kind: { type: "add" } }] });
  assert.equal(add[0].tool, "Write");
  assert.equal(add[1].text, "Edit declined");
});

test("codex turns note interruptions and failures", () => {
  const items = codex.turnItems({ id: "t1", status: "interrupted", startedAt: 1789619153, items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "go" }] }] });
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ["user", "go"],
      ["notice", "Interrupted"],
    ],
  );
  assert.equal(codex.turnItems({ id: "t2", status: "failed", error: { message: "usage limit reached" }, items: [] })[0].text, "usage limit reached");
});

test("codex approvals map to options and back to decisions", () => {
  const { waitingFromRequest, approvalResult } = codex;
  const cmd = waitingFromRequest("item/commandExecution/requestApproval", { command: "/bin/zsh -lc 'rm -rf build'", reason: "clean the build" });
  assert.deepEqual(cmd, { kind: "permission", tool: "Shell", detail: "rm -rf build", options: ["Yes", "Yes, for this session", "No"], reason: "clean the build" });
  assert.deepEqual(approvalResult("item/commandExecution/requestApproval", {}, 0), { decision: "accept" });
  assert.deepEqual(approvalResult("item/fileChange/requestApproval", {}, 1), { decision: "acceptForSession" });
  assert.deepEqual(approvalResult("item/fileChange/requestApproval", {}, 2), { decision: "decline" });

  const edit = waitingFromRequest("item/fileChange/requestApproval", { reason: null }, { type: "fileChange", changes: [{ path: "/p/README.md", kind: { type: "update" } }] });
  assert.equal(`${edit.tool} ${edit.detail}`, "Edit README.md");

  const perms = { network: { enabled: true }, fileSystem: null };
  assert.deepEqual(approvalResult("item/permissions/requestApproval", { permissions: perms }, 1), { permissions: { network: { enabled: true } }, scope: "session" });
  assert.deepEqual(approvalResult("item/permissions/requestApproval", { permissions: perms }, 2), { permissions: {}, scope: "turn" });

  assert.equal(waitingFromRequest("mcpServer/elicitation/request", {}), null); // left to the terminal
});

test("codex questions are answered one at a time and sent together", async () => {
  const sent = [];
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  bridge.respond = (id, result) => sent.push({ id, result });
  const s = { id: "th", agent: "codex", state: "working", codexJoined: true, lastActivity: 0 };
  registry.sessions.set("th", s);

  bridge.onServerRequest(7, "item/tool/requestUserInput", {
    threadId: "th",
    questions: [
      { id: "q1", header: "Plan", question: "Which approach?", isOther: false, isSecret: false, options: [{ label: "Small", description: "" }, { label: "Big", description: "" }] },
      { id: "q2", header: "Name", question: "What should it be called?", isOther: true, isSecret: false, options: null },
    ],
  });
  assert.equal(s.state, "waiting");
  assert.deepEqual(bridge.dialog(s), { kind: "question", options: ["Small", "Big"] });

  assert.equal(await bridge.choose(s, "question", 1), "Big");
  assert.equal(sent.length, 0); // one question still open
  assert.equal(s.waiting.detail, "What should it be called?");
  await bridge.answer(s, "glasses mode");
  assert.deepEqual(sent, [{ id: 7, result: { answers: { q1: { answers: ["Big"] }, q2: { answers: ["glasses mode"] } } } }]);
  assert.equal(s.waiting, null);
  assert.equal(s.state, "working");
});

test("an approval answered elsewhere clears the glasses", () => {
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  const s = { id: "th", agent: "codex", state: "working", codexJoined: true };
  registry.sessions.set("th", s);
  let attention = 0;
  registry.on("attention", () => attention++);
  bridge.onServerRequest(3, "item/commandExecution/requestApproval", { threadId: "th", command: "ls" });
  assert.equal(s.state, "waiting");
  assert.equal(attention, 1);
  bridge.onNotification("serverRequest/resolved", { threadId: "th", requestId: 3 });
  assert.equal(s.waiting, null);
  assert.equal(s.state, "working");
});

test("codex tracks effort and live context usage and changes thread settings", async () => {
  const changed = [];
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), allows: () => true, changed: (s) => changed.push(s.id) });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  const s = { id: "th", agent: "codex", state: "idle", codexJoined: true, model: "gpt-5.6-sol", effort: "high", context: null };
  registry.sessions.set("th", s);

  bridge.onNotification("thread/settings/updated", { threadId: "th", threadSettings: { model: "gpt-5.6-sol", effort: "xhigh" } });
  bridge.onNotification("thread/tokenUsage/updated", { threadId: "th", tokenUsage: { last: { totalTokens: 42_000 } } });
  assert.equal(s.effort, "xhigh");
  assert.equal(s.context, 42_000);

  bridge.ready = true;
  bridge.models = [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["high", "xhigh"], defaultEffort: "high" }];
  const calls = [];
  bridge.call = async (method, params) => calls.push({ method, params });
  await bridge.setModel(s, "gpt-5.6-sol");
  await bridge.setEffort(s, "high");
  assert.deepEqual(calls, [
    { method: "thread/settings/update", params: { threadId: "th", model: "gpt-5.6-sol" } },
    { method: "thread/settings/update", params: { threadId: "th", effort: "high" } },
  ]);
  assert.equal(s.effort, "high");
  assert.ok(changed.length >= 3);
});

test("codex exposes every visible model with its supported effort choices", async () => {
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), allows: () => true, changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ws = { open: true };
  bridge.call = async () => ({
    data: [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", hidden: false, isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
      { id: "hidden", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [] },
    ],
  });
  assert.deepEqual(await bridge.loadModels(), [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", isDefault: true, efforts: ["low", "high", "xhigh"], defaultEffort: "high" }]);
});

test("ending a Codex session stays absent while Codex still reports it loaded", async () => {
  const removed = [];
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: () => true,
    changed() {},
    remove(id) { removed.push(id); return this.sessions.delete(id); },
  });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  const s = { id: "th", agent: "codex", state: "idle", codexJoined: true, waiting: null, activity: "", lastActivity: 0 };
  registry.sessions.set("th", s);
  bridge.ready = true;
  const calls = [];
  bridge.call = async (method, params) => calls.push({ method, params });
  await bridge.end(s);
  assert.deepEqual(calls, [{ method: "thread/unsubscribe", params: { threadId: "th" } }]);
  assert.deepEqual(removed, ["th"]);
  assert.equal(s.state, "ended");
  assert.equal(s.codexJoined, false);

  bridge.call = async (method) => {
    if (method === "thread/loaded/list") return { data: ["th"] };
    throw new Error(`ended thread was unexpectedly rejoined with ${method}`);
  };
  await bridge.poll();
  assert.equal(registry.sessions.has("th"), false);
});

test("an explicit History resume unsuppresses an ended Codex thread", async () => {
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: () => true,
    changed() {},
    attach(s) { this.sessions.set(s.id, s); },
    addItems() {},
  });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  bridge.suppressedThreads.add("th");
  bridge.joining.set("th", { attempts: 999, lastAt: Date.now() });
  const calls = [];
  bridge.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "th", cwd: "/allowed/project", status: { type: "idle" }, turns: [] }, model: "gpt-5.6-sol", reasoningEffort: "high" };
    if (method === "thread/turns/list") return { data: [] };
    return {};
  };

  const resumed = await bridge.resumeSession({ id: "th" });
  assert.equal(resumed.id, "th");
  assert.equal(bridge.suppressedThreads.has("th"), false);
  assert.deepEqual(calls.map((c) => c.method), ["thread/resume", "thread/turns/list"]);
});

test("Codex clear creates a fresh thread and carries model and effort", async () => {
  const removed = [];
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: (cwd) => cwd === "/allowed/project",
    changed() {},
    attach(s) { this.sessions.set(s.id, s); },
    remove(id) { removed.push(id); return this.sessions.delete(id); },
  });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  const old = { id: "old", agent: "codex", cwd: "/allowed/project", project: "project", state: "idle", codexJoined: true, model: "gpt-5.6-sol", effort: "xhigh", context: 87_000, origin: "glasses", waiting: null, activity: "", lastActivity: 0 };
  registry.sessions.set(old.id, old);
  const calls = [];
  bridge.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new", cwd: "/allowed/project", status: { type: "idle" }, turns: [] }, model: "gpt-5.6-sol", reasoningEffort: "medium" };
    return {};
  };

  const replacement = await bridge.clear(old);
  assert.equal(replacement.id, "new");
  assert.equal(replacement.model, "gpt-5.6-sol");
  assert.equal(replacement.effort, "xhigh");
  assert.equal(replacement.context, null);
  assert.equal(replacement.origin, "glasses");
  assert.deepEqual(calls, [
    { method: "thread/start", params: { cwd: "/allowed/project", model: "gpt-5.6-sol" } },
    { method: "thread/settings/update", params: { threadId: "new", effort: "xhigh" } },
    { method: "thread/unsubscribe", params: { threadId: "old" } },
  ]);
  assert.deepEqual(removed, ["old"]);
  assert.equal(bridge.suppressedThreads.has("old"), true);
  assert.equal(registry.sessions.get("new"), replacement);
});

test("a new Codex session defaults to high effort when its model supports it", async () => {
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: () => true,
    changed() {},
    attach(s) { this.sessions.set(s.id, s); },
  });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  bridge.models = [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh"] }];
  const calls = [];
  bridge.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new", cwd: "/allowed/project", status: { type: "idle" }, turns: [] }, model: "gpt-5.6-sol", reasoningEffort: "medium" };
    return {};
  };

  const started = await bridge.startSession({ cwd: "/allowed/project" });
  assert.equal(started.effort, "high");
  assert.deepEqual(calls, [
    { method: "thread/start", params: { cwd: "/allowed/project" } },
    { method: "thread/settings/update", params: { threadId: "new", effort: "high" } },
  ]);
});

test("a glasses Codex session opens a waiting Mac terminal, attaches on first prompt, and closes it on End", async () => {
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: () => true,
    changed() {},
    attach(s) { this.sessions.set(s.id, s); },
    remove(id) { return this.sessions.delete(id); },
  });
  const tmuxCalls = [];
  const fakeTmux = {
    async listOurSessions() { return new Set(); },
    sessionNameFor() { return "project"; },
    async tmux(socket, args) { tmuxCalls.push({ socket, args }); return ""; },
    async openAttachedTerminal() { return "orca"; },
    loginShellCommand(bin, args) { return [bin, ...args]; },
  };
  const bridge = new codex.CodexBridge({ registry, bin: "/bin/codex", socket: "/tmp/codex.sock", tmux: fakeTmux });
  bridge.ready = true;
  bridge.models = [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["high"] }];
  const rpc = [];
  bridge.call = async (method, params) => {
    rpc.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new", cwd: "/allowed/project", status: { type: "idle" }, turns: [] }, model: "gpt-5.6-sol", reasoningEffort: "high" };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };

  const s = await bridge.startSession({ cwd: "/allowed/project", openTerminal: true });
  assert.equal(s.tmuxName, "project");
  assert.equal(s.codexTerminalPending, true);
  assert.equal(s.codexTerminalApp, "orca");
  assert.equal(s.summaryJSON().terminalState, "waiting");
  assert.equal(tmuxCalls[0].args[0], "new-session");

  await bridge.prompt(s, "hello");
  assert.equal(s.codexTerminalPending, false);
  assert.equal(s.summaryJSON().terminalState, "open");
  const respawn = tmuxCalls.find((c) => c.args[0] === "respawn-pane");
  assert.ok(respawn);
  assert.ok(respawn.args.includes("check_for_update_on_startup=false"));
  assert.ok(respawn.args.includes("new"));

  s.codexTurnId = null;
  await bridge.end(s);
  assert.equal(s.tmuxName, null);
  assert.equal(registry.sessions.has("new"), false);
  assert.deepEqual(tmuxCalls.at(-1).args, ["kill-session", "-t", "project"]);
  assert.ok(rpc.some((c) => c.method === "thread/unsubscribe"));
});

test("codex refuses threads outside the configured roots", async () => {
  const attached = [];
  const registry = Object.assign(new EventEmitter(), {
    sessions: new Map(),
    allows: (cwd) => cwd.startsWith("/allowed/"),
    attach: (s) => attached.push(s),
    changed() {},
  });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  assert.equal(bridge.adopt({ id: "outside", cwd: "/private/project", status: { type: "idle" } }, "gpt-5.6-sol", "high"), null);
  assert.equal(attached.length, 0);
});

test("joining an outside-root Codex thread immediately unsubscribes it", async () => {
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), allows: () => false, changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  const calls = [];
  bridge.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "outside", cwd: "/private/project", ephemeral: false, source: "cli" } };
    return {};
  };
  assert.equal(await bridge.join("outside", { force: true }), null);
  assert.deepEqual(calls.map((c) => c.method), ["thread/resume", "thread/unsubscribe"]);
});

test("helper threads are hidden and remote arguments carry the folder", () => {
  assert.equal(codex.isHelperThread({ ephemeral: true }), true);
  assert.equal(codex.isHelperThread({ ephemeral: false, source: { subAgent: {} } }), true);
  assert.equal(codex.isHelperThread({ ephemeral: false, source: "cli", parentThreadId: null }), false);

  const sock = "/home/me/.config/glancecode/codex.sock";
  assert.deepEqual(codex.remoteArgs(sock, ["-m", "gpt-5.5"], "/p"), ["--remote", `unix://${sock}`, "-C", "/p", "-m", "gpt-5.5"]);
  assert.deepEqual(codex.remoteArgs(sock, ["resume", "abc"], "/p"), ["resume", "--remote", `unix://${sock}`, "-C", "/p", "abc"]);
  assert.deepEqual(codex.remoteArgs(sock, ["-C", "/other"], "/p"), ["--remote", `unix://${sock}`, "-C", "/other"]);
});

test("websocket client: handshake, masked sends, long and fragmented messages", async () => {
  const { WsClient } = await import("../hub/wsclient.mjs");
  const received = [];
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {}); // the client hangs up at the end of the test
    socket.once("data", (buf) => {
      // Answer the first message only; the next frame is the client's close.
      // Decode one masked client frame (the test only sends small ones).
      const len = buf[1] & 0x7f;
      const mask = buf.subarray(2, 6);
      received.push(Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString());
      const big = "x".repeat(70_000);
      const long = Buffer.alloc(10);
      long[0] = 0x81;
      long[1] = 127;
      long.writeBigUInt64BE(BigInt(big.length), 2);
      socket.write(Buffer.concat([long, Buffer.from(big)]));
      // "he" + "llo" as a text frame and a continuation frame, split across writes.
      socket.write(Buffer.from([0x01, 2, ...Buffer.from("he")]));
      socket.write(Buffer.from([0x80, 3]));
      socket.write(Buffer.from("llo"));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ws = new WsClient(`ws://127.0.0.1:${server.address().port}`);
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send('{"hi":1}'));
    ws.on("message", (m) => {
      messages.push(m);
      if (messages.length === 2) resolve();
    });
  });
  ws.close();
  server.close();
  assert.deepEqual(received, ['{"hi":1}']);
  assert.equal(messages[0].length, 70_000);
  assert.equal(messages[1], "hello");
});
