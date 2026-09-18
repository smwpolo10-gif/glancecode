// Client for the glancecode hub: REST calls plus a replaying event stream.
import type { Agent, HubEvent, Item, ModelChoice, RecentProject, RecentSession, SessionSummary } from "./types.ts";
import { every } from "./timers.ts";

export interface HubConfig {
  url: string; // e.g. https://my-mac.tailnet-name.ts.net:7443
  token: string;
}

type Listener = () => void;

const DEFAULT_CLAUDE_MODELS: ModelChoice[] = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "fable", name: "Fable" },
  { id: "haiku", name: "Haiku" },
];

export class Hub {
  sessions = new Map<string, SessionSummary>();
  items = new Map<string, Item[]>();
  /** Agents the hub can start. Older hubs don't say, and only run Claude Code. */
  agents: Agent[] = ["claude"];
  private modelCache = new Map<string, ModelChoice[]>();
  connected = false;
  lastError = "";
  private es: EventSource | null = null;
  private lastEventId = 0;
  private listeners = new Set<Listener>();
  private connecting = false;
  private nextRetryAt = 0;
  private lastSignalAt = 0;

  constructor(public cfg: HubConfig) {
    // Retries and stall checks run on a native-backed interval (see timers.ts).
    every(() => this.watch(), 2000);
  }

  /** Reconnect when the stream is down, or when it has been silent too long. */
  private watch() {
    if (this.cfg.url === "demo") return;
    const now = Date.now();
    if (!this.connected && !this.connecting && this.nextRetryAt && now >= this.nextRetryAt) {
      this.nextRetryAt = 0;
      void this.connect();
    } else if (this.connected && this.es && this.lastSignalAt && now - this.lastSignalAt > 45_000) {
      // The hub sends a ping every 15 s; nothing for 45 s means the stream is dead
      // even though the WebView never reported an error.
      this.refresh();
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected notify() {
    for (const fn of this.listeners) fn();
  }

  private async req<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
    const res = await fetch(this.cfg.url.replace(/\/$/, "") + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(raw ? { "Content-Type": "application/octet-stream" } : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`);
    return data as T;
  }

  async connect() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const state = await this.req<{ seq: number; agents?: Agent[]; sessions: SessionSummary[] }>("GET", "/api/state");
      this.sessions = new Map(state.sessions.map((s) => [s.id, s]));
      this.agents = state.agents?.length ? state.agents : ["claude"];
      this.lastEventId = state.seq;
      this.openStream();
      this.connected = true;
      this.lastError = "";
      // Keep cached transcripts on screen, but refetch them: events may have been
      // missed while the stream was down. Forget sessions that no longer exist.
      for (const id of [...this.items.keys()]) {
        if (!this.sessions.has(id)) this.items.delete(id);
        else void this.loadItems(id).catch(() => {});
      }
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
    this.notify();
  }

  private openStream() {
    this.es?.close();
    const url = `${this.cfg.url.replace(/\/$/, "")}/api/events?token=${encodeURIComponent(this.cfg.token)}&since=${this.lastEventId}`;
    const es = new EventSource(url);
    this.es = es;
    this.lastSignalAt = Date.now();
    es.onmessage = (msg) => {
      this.lastSignalAt = Date.now();
      if (msg.lastEventId) this.lastEventId = Number(msg.lastEventId);
      let ev: HubEvent;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }
      this.apply(ev);
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // Leave the EventSource open: its built-in retry reconnects without app timers,
      // which the Even WebView can stall while the app is idle.
      if (this.connected) {
        this.connected = false;
        this.disconnectedAt = Date.now();
        this.notify();
      }
      if (es.readyState === EventSource.CLOSED) this.scheduleRetry();
    };
    es.onopen = () => {
      if (this.es !== es) return;
      this.lastSignalAt = Date.now();
      if (!this.connected) void this.resync();
    };
  }

  /** After the stream comes back: refresh sessions and cached transcripts, keep the stream. */
  private async resync() {
    try {
      const state = await this.req<{ seq: number; agents?: Agent[]; sessions: SessionSummary[] }>("GET", "/api/state");
      this.sessions = new Map(state.sessions.map((s) => [s.id, s]));
      this.agents = state.agents?.length ? state.agents : ["claude"];
      for (const id of [...this.items.keys()]) {
        if (!this.sessions.has(id)) this.items.delete(id);
        else void this.loadItems(id).catch(() => {});
      }
      this.connected = true;
      this.lastError = "";
      if (this.disconnectedAt) void this.log(`stream back after ${Math.round((Date.now() - this.disconnectedAt) / 1000)}s, resynced`);
      this.disconnectedAt = 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    this.notify();
  }

  private disconnectedAt = 0;

  private scheduleRetry() {
    if (!this.nextRetryAt) this.nextRetryAt = Date.now() + 3000;
  }

  /** Call when the app returns to the foreground: suspended WebViews drop streams. */
  refresh() {
    this.es?.close();
    this.es = null;
    void this.connect();
  }

  private apply(ev: HubEvent) {
    if (ev.type === "ping") return;
    if (ev.type === "session") {
      this.sessions.set(ev.session.id, ev.session);
    } else if (ev.type === "removed") {
      this.sessions.delete(ev.id);
      this.items.delete(ev.id);
    } else if (ev.type === "items") {
      const list = this.items.get(ev.id);
      if (list) {
        const keys = new Set(list.map((i) => i.key));
        for (const it of ev.items) if (!keys.has(it.key)) list.push(it);
        if (list.length > 400) list.splice(0, list.length - 400);
      }
    } else if (ev.type === "resync") {
      this.refresh();
      return;
    }
    this.notify();
  }

  async loadItems(id: string) {
    const data = await this.req<{ session: SessionSummary; items: Item[] }>("GET", `/api/sessions/${id}?items=200`);
    this.sessions.set(id, data.session);
    this.items.set(id, data.items);
    this.notify();
  }

  private loadingItems = new Set<string>();

  /** Fetch a transcript if it isn't cached and no fetch is already running. */
  ensureItems(id: string) {
    if (this.items.has(id) || this.loadingItems.has(id) || !this.connected) return;
    this.loadingItems.add(id);
    this.loadItems(id)
      .catch(() => {})
      .finally(() => this.loadingItems.delete(id));
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.state !== "ended" || Date.now() - s.lastActivity < 5 * 60_000)
      .sort((a, b) => {
        const rank = (s: SessionSummary) => ({ waiting: 0, working: 1, starting: 1, idle: 2, ended: 3 })[s.state] ?? 2;
        return rank(a) - rank(b) || b.lastActivity - a.lastActivity;
      });
  }

  prompt(id: string, text: string) {
    return this.req("POST", `/api/sessions/${id}/prompt`, { text });
  }
  interrupt(id: string) {
    return this.req("POST", `/api/sessions/${id}/interrupt`, {});
  }
  choose(id: string, kind: "permission" | "question", index: number) {
    return this.req<{ chosen: string }>("POST", `/api/sessions/${id}/choose`, { kind, index });
  }
  answer(id: string, text: string) {
    return this.req("POST", `/api/sessions/${id}/answer`, { text });
  }
  dialog(id: string) {
    return this.req<{ dialog: { kind: string; options: string[] } }>("POST", `/api/sessions/${id}/screen`, {});
  }
  command(id: string, command: string) {
    return this.req<{ ok: boolean; session?: SessionSummary }>("POST", `/api/sessions/${id}/command`, { command });
  }
  recent() {
    return this.req<{ agents?: Agent[]; projects: RecentProject[]; sessions: RecentSession[] }>("GET", "/api/recent");
  }
  launch(cwd: string, resume?: string, agent?: Agent) {
    return this.req<{ session: SessionSummary }>("POST", "/api/sessions", { cwd, resume, agent });
  }
  /** Models a session can switch to. Per agent, since every session of an agent offers the same list. */
  async models(id: string): Promise<ModelChoice[]> {
    const agent = this.sessions.get(id)?.agent || "claude";
    const cached = this.modelCache.get(agent);
    if (cached) return cached;
    try {
      const { models } = await this.req<{ models: ModelChoice[] }>("GET", `/api/sessions/${id}/models`);
      this.modelCache.set(agent, models);
      return models;
    } catch {
      // Hubs before Codex support have no models endpoint; they take these names.
      return agent === "claude" ? DEFAULT_CLAUDE_MODELS : [];
    }
  }
  log(message: string) {
    return this.req("POST", "/api/log", { message }).catch(() => {});
  }
  presence() {
    return this.req("POST", "/api/presence", {}).catch(() => {});
  }
  async transcribe(pcm: Uint8Array, partial = false): Promise<string> {
    const r = await this.req<{ text: string }>("POST", `/api/stt${partial ? "?partial=1" : ""}`, undefined, pcm as unknown as BodyInit);
    return r.text || "";
  }
}
