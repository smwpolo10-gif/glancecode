// The hub: HTTP API for the glasses app, hook intake for Claude Code, live feed in the terminal.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CODEX_SOCKET, loadConfig, tailscaleAddress } from "./config.mjs";
import { CodexBridge, findCodex } from "./codex.mjs";
import { recentGeminiSessions } from "./gemini.mjs";
import { Registry, recentProjects, recentTranscripts } from "./sessions.mjs";
import { Transcriber } from "./stt.mjs";
import { Notifier } from "./notify.mjs";
import * as tmuxCtl from "./tmux.mjs";
import { color, printFeed } from "./feed.mjs";
import { BRAND } from "./brand.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP_DIST = resolve(HERE, "..", "app", "dist");
const EVENT_BUFFER = 3000;
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8")).version;
// What the glasses menu offers for Claude sessions; Codex lists its own.
const CLAUDE_MODELS = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "fable", name: "Fable" },
  { id: "haiku", name: "Haiku" },
];
const AGENT_LABEL = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function startHub({ quiet = false, feed = true } = {}) {
  const cfg = loadConfig();
  const log = (...a) => {
    if (!quiet) console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
  };
  const registry = new Registry({ allowedRoots: cfg.allowedRoots });
  const transcriber = new Transcriber({ port: cfg.whisperPort, model: cfg.whisperModel, log });
  const notifier = new Notifier({ server: cfg.ntfyServer, topic: cfg.ntfyTopic, log });

  // ---------- event stream with replay ----------
  let seq = 0;
  const events = []; // {id, data}
  const clients = new Set();
  const publish = (payload) => {
    const ev = { id: ++seq, data: JSON.stringify(payload) };
    events.push(ev);
    if (events.length > EVENT_BUFFER) events.splice(0, events.length - EVENT_BUFFER);
    for (const res of clients) res.write(`id: ${ev.id}\ndata: ${ev.data}\n\n`);
  };

  registry.on("session", (s) => publish({ type: "session", session: s.summaryJSON() }));
  registry.on("removed", (s) => publish({ type: "removed", id: s.id }));
  registry.on("items", (s, items) => {
    publish({ type: "items", id: s.id, items });
    if (feed) printFeed(s, items);
  });
  registry.on("attention", (s, kind) => {
    const what = kind === "permission" ? `needs permission: ${s.waiting?.detail || ""}` : "has a question for you";
    if (feed) console.log(color(`  ◆ ${s.project} ${what}`, 33));
    notifier.send(`${s.id}:${kind}`, `${s.project} needs you`, what);
  });
  registry.on("finished", (s, last) => {
    const message = String(last || "").replace(/\s+/g, " ").trim() || "Turn complete";
    const finished = { type: "finished", id: s.id, project: s.project, message: message.slice(0, 4000), at: Date.now() };
    // Registry emits "finished" while it is still applying the Stop hook. Publish
    // after that call stack so clients receive the idle session state first; a HUD
    // must not mistake the previous working state for a newer turn and clear the alert.
    queueMicrotask(() => {
      publish(finished);
      notifier.send(`${s.id}:done`, `${s.project} finished`, message);
    });
  });

  // A sleeping Mac answers nothing, so the glasses see a dead hub. `caffeinate -s`
  // holds it awake only while it's plugged in; on battery it sleeps as usual.
  let awake = null;
  if (cfg.preventSleep && process.platform === "darwin") {
    awake = spawn("caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore", detached: true });
    awake.unref();
    awake.on("error", (err) => log(`could not hold the Mac awake: ${err.message}`));
  }

  registry.load();
  tmuxCtl.reloadTmuxConf().catch(() => {}); // settings added in newer versions reach a running tmux server

  // Codex sessions come from Codex's own app-server, which the hub joins as a client.
  const codexBin = cfg.codex === false ? null : findCodex(cfg.codexBin, { exclude: [resolve(HERE, "..")] });
  const codex = codexBin ? new CodexBridge({ registry, bin: codexBin, socket: CODEX_SOCKET, log, clientVersion: PKG_VERSION }) : null;
  if (codex) void codex.start();
  else if (cfg.codex === true) log(`codex: "${cfg.codexBin}" not found; Codex sessions are off`);
  // Gemini CLI sessions arrive through hooks like Claude Code's; the hub only needs the
  // command to start and resume them from the glasses.
  const geminiBin = cfg.gemini === false ? null : findCodex(cfg.geminiBin, { exclude: [resolve(HERE, "..")] });
  const agents = ["claude", ...(codex ? ["codex"] : []), ...(geminiBin ? ["gemini"] : [])];
  const geminiThreads = new Set(); // ids seen in the recent list, to route a resume

  function codexFor(s) {
    if (s.agent !== "codex") return null;
    if (!codex) throw new HttpError(503, "Codex support is off on this hub");
    return codex;
  }
  const sweepTimer = setInterval(() => registry.sweep().catch(() => {}), 5000);

  let lastPresenceAt = 0;

  // ---------- helpers ----------
  const tokenBuf = Buffer.from(cfg.token);
  function authorized(req, url) {
    const header = req.headers.authorization || "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") || "";
    const buf = Buffer.from(given);
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  }

  async function readBody(req, limit = 8 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, "body too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function readJSON(req) {
    const raw = await readBody(req, 256 * 1024);
    if (!raw.length) return {};
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  function send(res, status, body) {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store" });
    res.end(data);
  }

  function sessionOr404(id) {
    const s = registry.sessions.get(id);
    if (!s) throw new HttpError(404, "no such session");
    return s;
  }

  function controllable(s) {
    if (!s.tmux) throw new HttpError(409, "this session is not running inside tmux, so it is view-only");
    if (s.state === "ended") throw new HttpError(409, "session has ended");
    return s.tmux;
  }

  /**
   * Typing a prompt while a dialog is open would press its highlighted option
   * with the final Enter (for example, approve a permission). Refuse instead.
   */
  async function refuseIfDialog(s) {
    const dialog = tmuxCtl.readDialog(await tmuxCtl.capture(controllable(s), 40), s.agent);
    const who = AGENT_LABEL[s.agent] || "Claude";
    if (dialog.kind === "permission") throw new HttpError(409, `${who} is waiting for approval. Choose an option first.`);
    if (dialog.kind === "question") throw new HttpError(409, `${who} asked a question. Pick an option or answer it by voice.`);
    if (dialog.kind === "trust") throw new HttpError(409, `${who} is asking whether to trust this folder.`);
  }

  /** Wait briefly for the prompt to show up on screen (queued or echoed) or in the transcript. */
  async function confirmDelivered(s, text, ms = 4000) {
    const snippet = tmuxCtl.promptSnippet(text);
    const seenInItems = () => s.items.slice(-10).some((i) => i.kind === "user" && tmuxCtl.screenHasSnippet(i.text, snippet));
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (seenInItems()) return true;
      try {
        if (tmuxCtl.screenHasSnippet(await tmuxCtl.capture(s.tmux, 60), snippet)) return true;
      } catch {
        /* pane busy */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return seenInItems();
  }

  function vocabulary() {
    const names = new Set(registry.list().map((s) => s.project));
    for (const p of recentProjects(10, { allowedRoots: cfg.allowedRoots })) names.add(p.project);
    return `${cfg.sttVocabulary}${codex ? ", Codex" : ""}${geminiBin ? ", Gemini" : ""}, ${[...names].join(", ")}`;
  }

  /** Which agent a launch is for: asked for, known from the resumed id, or the default. */
  function launchAgent({ agent, resume }) {
    if (agent === "claude" || agent === "codex" || agent === "gemini") return agent;
    if (resume && codex?.isCodexThread(resume)) return "codex";
    if (resume && geminiThreads.has(resume)) return "gemini";
    if (!resume && cfg.defaultAgent === "codex" && codex) return "codex";
    if (!resume && cfg.defaultAgent === "gemini" && geminiBin) return "gemini";
    return "claude";
  }

  /** Start Claude Code or Gemini CLI in tmux; their hooks register the session. */
  async function launch({ cwd, resume, agent = "claude" }) {
    if (resume) {
      const live = registry.sessions.get(resume);
      if (live && live.state !== "ended") throw new HttpError(409, "that session is already open");
    }
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, "cwd must be an existing folder");
    if (!registry.allows(cwd)) throw new HttpError(403, "that folder is outside this hub's allowed roots");
    if (agent === "gemini" && !geminiBin) throw new HttpError(503, "Gemini CLI isn't installed on this computer");
    const gemini = agent === "gemini";
    const args = [...((gemini ? cfg.geminiArgs : cfg.claudeArgs) || []), ...(resume ? ["--resume", resume] : [])];
    const { name, target } = await tmuxCtl.launchClaude({ cwd, args, claudeBin: gemini ? geminiBin : "claude", env: { GLANCECODE_HOOK_PORT: String(cfg.hookPort) } });
    registry.expectLaunch(target, { name, origin: "glasses" });
    log(`launched ${gemini ? "gemini " : ""}${name} in ${cwd}${resume ? ` (resume ${resume.slice(0, 8)})` : ""}`);
    // Handle the trust dialog in the background; the SessionStart hook registers the session.
    tmuxCtl.acceptTrustIfShown(target, 8000, agent).catch(() => {});
    return { name, target };
  }

  async function waitForSessionOnPane(target, ms = 25_000, excludeId = null) {
    const key = tmuxCtl.paneKey(target);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = registry.list().find((x) => x.id !== excludeId && x.state !== "ended" && tmuxCtl.paneKey(x.tmux) === key);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // ---------- API ----------
  async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/health") return send(res, 200, { ok: true });
    if (!authorized(req, url)) throw new HttpError(401, "bad token");

    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const since = Number(req.headers["last-event-id"] || url.searchParams.get("since") || 0);
      res.write(`retry: 2000\n\n`);
      const oldest = events[0]?.id ?? seq + 1;
      // Gap in the buffer, or the client is ahead of us (the hub restarted): resync.
      if ((since && since + 1 < oldest) || since > seq) {
        res.write(`data: ${JSON.stringify({ type: "resync" })}\n\n`); // gap: client must refetch
      } else {
        for (const ev of events) if (ev.id > since) res.write(`id: ${ev.id}\ndata: ${ev.data}\n\n`);
      }
      clients.add(res);
      // A data event, not an SSE comment, so the app can tell a live stream from a dead one.
      const ping = setInterval(() => res.write(`data: {"type":"ping"}\n\n`), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (method === "GET" && path === "/api/state") {
      return send(res, 200, { seq, agents, sessions: registry.list().map((s) => s.summaryJSON()) });
    }

    if (method === "GET" && path === "/api/recent") {
      const liveIds = new Set(registry.list().filter((s) => s.state !== "ended").map((s) => s.id));
      const claude = recentTranscripts({ liveIds, limit: 15, allowedRoots: cfg.allowedRoots }).map((t) => ({ ...t, agent: "claude" }));
      const codexRecent = codex ? await codex.recent({ limit: 15, liveIds }).catch(() => []) : [];
      const geminiRecent = geminiBin ? recentGeminiSessions({ liveIds, limit: 15 }) : [];
      for (const g of geminiRecent) geminiThreads.add(g.id);
      const others = [...codexRecent, ...geminiRecent];
      const sessions = [...claude, ...others].sort((a, b) => b.mtime - a.mtime).slice(0, 20);
      // A project counts as recent for either agent.
      const projects = new Map(recentProjects(15, { allowedRoots: cfg.allowedRoots }).map((p) => [p.cwd, p]));
      for (const t of others) if (!projects.has(t.cwd) || projects.get(t.cwd).mtime < t.mtime) projects.set(t.cwd, { cwd: t.cwd, project: t.project, mtime: t.mtime });
      // An allowed project must remain launchable even before Claude has written
      // its first transcript there. This also makes the empty-session state useful.
      for (const root of cfg.allowedRoots || []) {
        const cwd = resolve(root);
        try {
          const info = statSync(cwd);
          if (info.isDirectory() && registry.allows(cwd) && !projects.has(cwd)) {
            projects.set(cwd, { cwd, project: basename(cwd) || cwd, mtime: info.mtimeMs });
          }
        } catch {
          /* an unavailable configured root cannot be launched */
        }
      }
      return send(res, 200, { agents, projects: [...projects.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 15), sessions });
    }

    if (method === "POST" && path === "/api/log") {
      const { message } = await readJSON(req);
      log(`app: ${String(message || "").slice(0, 300)}`);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/presence") {
      const now = Date.now();
      if (lastPresenceAt && now - lastPresenceAt > 75_000 && now - lastPresenceAt < 30 * 60_000) {
        log(`app: no heartbeat for ${Math.round((now - lastPresenceAt) / 1000)}s (the app was suspended or offline)`);
      }
      lastPresenceAt = now;
      notifier.markForeground();
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/stt") {
      const pcm = await readBody(req, 16000 * 2 * 120); // two minutes max
      const result = await transcriber.transcribe(pcm, vocabulary());
      // Partials arrive about once a second while a hold is in progress; only log finals.
      if (url.searchParams.get("partial") !== "1") log(`stt ${(pcm.length / 32000).toFixed(1)}s -> "${result.text}"${result.ms ? ` (${result.ms}ms)` : ""}`);
      return send(res, 200, result);
    }

    if (method === "POST" && path === "/api/sessions") {
      const body = await readJSON(req);
      if (launchAgent(body) === "codex") {
        if (!codex) throw new HttpError(503, "Codex support is off on this hub");
        if (body.resume) {
          const live = registry.sessions.get(body.resume);
          if (live && live.state !== "ended") throw new HttpError(409, "that session is already open");
          const session = await codex.resumeSession({ id: body.resume });
          if (body.prompt) await codex.prompt(session, body.prompt);
          log(`codex: resumed ${session.project} (${session.id.slice(0, 8)})`);
          return send(res, 200, { session: session.summaryJSON() });
        }
        if (!body.cwd || !existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) throw new HttpError(400, "cwd must be an existing folder");
        const session = await codex.startSession({ cwd: body.cwd, prompt: body.prompt });
        log(`codex: started ${session.project} from the glasses`);
        return send(res, 200, { session: session.summaryJSON() });
      }
      const agent = launchAgent(body);
      const { name, target } = await launch({ ...body, agent });
      const session = await waitForSessionOnPane(target);
      if (!session) throw new HttpError(504, `${agent === "gemini" ? "Gemini CLI" : "Claude Code"} started but did not report in; is the hook installed? (${BRAND.name} install)`);
      if (body.prompt) {
        await tmuxCtl.waitForInput(session.tmux, 20000, session.agent);
        await tmuxCtl.sendPrompt(session.tmux, body.prompt);
      }
      let terminalApp = null;
      if (body.openTerminal === true) {
        try {
          terminalApp = await tmuxCtl.openAttachedTerminal({ cwd: session.cwd, name });
          log(`opened ${terminalApp} for ${name}`);
        } catch (err) {
          log(`could not open a visible terminal for ${name}: ${err.message}`);
        }
      }
      return send(res, 200, { session: session.summaryJSON(), terminalOpened: !!terminalApp, terminalApp });
    }

    const m = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(path);
    if (m) {
      const s = sessionOr404(m[1]);
      const action = m[2];
      if (method === "GET" && !action) {
        const limit = Math.min(Number(url.searchParams.get("items") || 150), 300);
        return send(res, 200, { seq, session: s.summaryJSON(), items: s.items.slice(-limit) });
      }
      if (method === "GET" && action === "models") {
        if (codexFor(s)) return send(res, 200, { models: codex.models });
        // Gemini switches models through an interactive picker, so the glasses don't offer it.
        return send(res, 200, { models: s.agent === "gemini" ? [] : CLAUDE_MODELS });
      }
      if (method === "POST" && action === "end") {
        if (s.agent === "codex") throw new HttpError(409, "ending Codex sessions is not supported by this hub");
        const target = controllable(s);
        await tmuxCtl.terminateSession(target);
        s.tmux = null;
        s.state = "ended";
        s.waiting = null;
        s.activity = "";
        s.lastActivity = Date.now();
        // Ending removes the live row immediately. The transcript remains in
        // Claude's history and can still be opened from the History picker.
        registry.remove(s.id);
        log(`ended ${s.project} (${s.id.slice(0, 8)}) and terminated its tmux pane`);
        return send(res, 200, { ok: true });
      }
      const cx = codexFor(s);
      if (cx) return codexAction(req, res, s, action, method);
      if (method === "POST" && action === "prompt") {
        const { text } = await readJSON(req);
        if (!text || typeof text !== "string") throw new HttpError(400, "text required");
        await refuseIfDialog(s);
        await tmuxCtl.sendPrompt(controllable(s), text);
        if (!(await confirmDelivered(s, text))) {
          log(`✗ ${s.project}: typed but not seen in the terminal or transcript: ${text.slice(0, 80)}`);
          throw new HttpError(502, `Typed it, but ${AGENT_LABEL[s.agent] || "Claude"} didn't show it. Is that terminal scrolled or in another mode?`);
        }
        log(`→ ${s.project}: ${text}`);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && action === "interrupt") {
        await tmuxCtl.sendKey(controllable(s), "Escape");
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && action === "choose") {
        const { index, kind } = await readJSON(req);
        const chosen = await tmuxCtl.chooseOption(controllable(s), kind === "question" ? "question" : "permission", Number(index), s.agent);
        log(`→ ${s.project}: chose "${chosen}"`);
        if (kind === "question" && s.waiting?.kind === "question") {
          s.waiting.questionIndex = (s.waiting.questionIndex || 0) + 1;
          if (s.waiting.questionIndex >= (s.waiting.questions?.length || 1)) s.waiting = null;
        } else if (kind !== "question") {
          s.waiting = null;
        }
        if (!s.waiting && s.state === "waiting") s.state = "working";
        registry.changed(s);
        return send(res, 200, { ok: true, chosen });
      }
      if (method === "POST" && action === "answer") {
        const { text } = await readJSON(req);
        await tmuxCtl.answerWithText(controllable(s), String(text || ""), s.agent);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && action === "screen") {
        const screen = await tmuxCtl.capture(controllable(s), 40);
        return send(res, 200, { dialog: tmuxCtl.readDialog(screen, s.agent) });
      }
      if (method === "POST" && action === "command") {
        const { command } = await readJSON(req);
        if (s.agent === "gemini") {
          // Gemini calls compacting /compress, and has no one-line model switch.
          const geminiCommand = { "/compact": "/compress", "/compress": "/compress", "/clear": "/clear" }[String(command)];
          if (!geminiCommand) throw new HttpError(400, /^\/model /.test(String(command)) ? "Switch Gemini's model at the computer with /model" : "command not allowed");
          await refuseIfDialog(s);
          await tmuxCtl.sendPrompt(controllable(s), geminiCommand);
          log(`→ ${s.project} (gemini): ${geminiCommand}`);
          return send(res, 200, { ok: true });
        }
        const allowed = /^\/(model (opus|sonnet|haiku|fable)(\[1m\])?|compact|clear|cost|context)$/;
        if (!allowed.test(String(command))) throw new HttpError(400, "command not allowed");
        await refuseIfDialog(s);
        const model = /^\/model (\S+)$/.exec(command)?.[1];
        if (model) {
          const withWindow = !model.startsWith("haiku") && (/\[1m\]$/.test(model) || (s.context || 0) > 150_000) ? model.replace(/(\[1m\])?$/, "[1m]") : model;
          await tmuxCtl.switchModel(controllable(s), withWindow, join(homedir(), ".claude", "settings.json"));
          log(`→ ${s.project}: /model ${withWindow} (default left unchanged)`);
          return send(res, 200, { ok: true });
        }
        const target = controllable(s);
        await tmuxCtl.sendPrompt(target, command);
        log(`→ ${s.project}: ${command}`);
        if (command === "/clear") {
          const replacement = await waitForSessionOnPane(target, 12_000, s.id);
          if (replacement) {
            replacement.origin = s.origin;
            replacement.tmuxName = s.tmuxName;
            registry.changed(replacement);
            registry.remove(s.id);
            return send(res, 200, { ok: true, session: replacement.summaryJSON() });
          }
        }
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "not found");
  }

  /** The same session actions for a Codex session, through its app-server instead of tmux. */
  async function codexAction(req, res, s, action, method) {
    if (method !== "POST") throw new HttpError(404, "not found");
    const run = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(err.status || 502, err.message);
      }
    };
    if (action === "prompt") {
      const { text } = await readJSON(req);
      if (!text || typeof text !== "string") throw new HttpError(400, "text required");
      await run(() => codex.prompt(s, text));
      log(`→ ${s.project} (codex): ${text}`);
      return send(res, 200, { ok: true });
    }
    if (action === "interrupt") {
      await run(() => codex.interrupt(s));
      return send(res, 200, { ok: true });
    }
    if (action === "choose") {
      const { index, kind } = await readJSON(req);
      const chosen = await run(() => codex.choose(s, kind === "question" ? "question" : "permission", Number(index)));
      log(`→ ${s.project} (codex): chose "${chosen}"`);
      return send(res, 200, { ok: true, chosen });
    }
    if (action === "answer") {
      const { text } = await readJSON(req);
      await run(() => codex.answer(s, String(text || "")));
      return send(res, 200, { ok: true });
    }
    if (action === "screen") return send(res, 200, { dialog: codex.dialog(s) });
    if (action === "command") {
      const { command } = await readJSON(req);
      if (command === "/compact") {
        await run(() => codex.compact(s));
        log(`→ ${s.project} (codex): /compact`);
        return send(res, 200, { ok: true });
      }
      const model = /^\/model ([\w.:-]+)$/.exec(String(command))?.[1];
      if (model && codex.models.some((m) => m.id === model)) {
        await run(() => codex.setModel(s, model));
        log(`→ ${s.project} (codex): model ${model} from the next prompt`);
        return send(res, 200, { ok: true });
      }
      if (model) throw new HttpError(400, `Codex models: ${codex.models.map((m) => m.id).join(", ") || "none listed yet"}`);
      throw new HttpError(400, "command not allowed");
    }
    throw new HttpError(404, "not found");
  }

  function serveStatic(req, res, url) {
    if (!existsSync(APP_DIST)) return send(res, 404, "App not built. Run: npm run build:app");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || !extname(rel)) rel = "/index.html";
    const file = normalize(join(APP_DIST, rel));
    if (!file.startsWith(APP_DIST) || !existsSync(file)) return send(res, 404, "not found");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": rel === "/index.html" ? "no-store" : "public, max-age=3600" });
    res.end(readFileSync(file));
  }

  function handler(req, res) {
    const url = new URL(req.url, "http://hub");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const done = url.pathname.startsWith("/api/") ? api(req, res, url) : Promise.resolve(serveStatic(req, res, url));
    done.catch((err) => {
      const status = err.status || 500;
      if (status >= 500) log(`error ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    });
  }

  // ---------- hook intake (127.0.0.1 only) ----------
  const hookServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") return res.writeHead(404).end();
    try {
      const raw = await readBody(req, 4 * 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8"));
      registry.handleHook(payload, {
        tmux: req.headers["x-tmux"],
        pane: req.headers["x-tmux-pane"],
        ppid: req.headers["x-ppid"],
      });
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  hookServer.listen(cfg.hookPort, "127.0.0.1");

  const apiServers = [];
  // Loopback only by default: the phone reaches the hub through `tailscale serve`
  // (HTTPS on the machine's *.ts.net name). The raw Tailscale IP is opt-in.
  const hosts = ["127.0.0.1"];
  const ts = cfg.bindTailscaleIP ? tailscaleAddress() : null;
  if (ts) hosts.push(ts);
  for (const host of hosts) {
    const srv = createServer(handler);
    srv.listen(cfg.port, host);
    srv.on("error", (err) => log(`could not listen on ${host}:${cfg.port}: ${err.message}`));
    apiServers.push(srv);
  }

  log(`hub on ${hosts.map((h) => `http://${h}:${cfg.port}`).join(" and ")}; hooks on 127.0.0.1:${cfg.hookPort}`);
  if (!transcriber.available) log(`voice: speech model missing, run \`${BRAND.name} setup-voice\``);
  else transcriber.ensure().then(() => log("voice: whisper ready")).catch((err) => log(`voice: ${err.message}`));
  if (notifier.enabled) log(`phone push: ntfy topic set`);
  if (awake) log("holding the Mac awake while plugged in");
  if (codex) log(`codex: following Codex sessions (${codexBin})`);
  if (geminiBin) log(`gemini: Gemini CLI found (${geminiBin})`);

  return {
    cfg,
    registry,
    close() {
      clearInterval(sweepTimer);
      awake?.kill();
      for (const res of clients) res.end();
      hookServer.close();
      for (const s of apiServers) s.close();
      transcriber.stop();
      codex?.stop();
      for (const s of registry.sessions.values()) s.tail?.close();
    },
  };
}
