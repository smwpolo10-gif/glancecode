// Client for the glancecode hub: REST calls plus a replaying event stream.
import type { HubEvent, Item, RecentProject, RecentSession, SessionSummary } from "./types.ts";

export interface HubConfig {
  url: string; // e.g. https://my-mac.tailnet-name.ts.net:7443
  token: string;
}

type Listener = () => void;

export class Hub {
  sessions = new Map<string, SessionSummary>();
  items = new Map<string, Item[]>();
  connected = false;
  lastError = "";
  private es: EventSource | null = null;
  private lastEventId = 0;
  private listeners = new Set<Listener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(public cfg: HubConfig) {}

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
    try {
      const state = await this.req<{ seq: number; sessions: SessionSummary[] }>("GET", "/api/state");
      this.sessions = new Map(state.sessions.map((s) => [s.id, s]));
      // Drop cached transcripts; they refetch when opened.
      this.items.clear();
      this.lastEventId = state.seq;
      this.openStream();
      this.connected = true;
      this.lastError = "";
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
    }
    this.notify();
  }

  private openStream() {
    this.es?.close();
    const url = `${this.cfg.url.replace(/\/$/, "")}/api/events?token=${encodeURIComponent(this.cfg.token)}&since=${this.lastEventId}`;
    const es = new EventSource(url);
    this.es = es;
    es.onmessage = (msg) => {
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
      // EventSource retries by itself, but a stale `since` would replay from the
      // wrong place after a hub restart, so reconnect from a fresh snapshot.
      if (es.readyState === EventSource.CLOSED || !this.connected) return;
      this.connected = false;
      this.notify();
      es.close();
      this.scheduleRetry();
    };
    es.onopen = () => {
      if (!this.connected) {
        this.connected = true;
        this.notify();
      }
    };
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, 3000);
  }

  /** Call when the app returns to the foreground: suspended WebViews drop streams. */
  refresh() {
    this.es?.close();
    this.es = null;
    void this.connect();
  }

  private apply(ev: HubEvent) {
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
    return this.req("POST", `/api/sessions/${id}/command`, { command });
  }
  recent() {
    return this.req<{ projects: RecentProject[]; sessions: RecentSession[] }>("GET", "/api/recent");
  }
  launch(cwd: string, resume?: string) {
    return this.req<{ session: SessionSummary }>("POST", "/api/sessions", { cwd, resume });
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
