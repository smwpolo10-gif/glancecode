import type { FinishedEvent } from "./types.ts";

/** A completion event that has not been dismissed on the glasses. */
export interface CompletionNotice extends FinishedEvent {
  key: string;
}

/**
 * Small in-memory inbox for finished turns. The Hub owns replay/reconnect; this
 * class only de-duplicates what the app has already seen and drives the HUD.
 */
export class CompletionInbox {
  /** At most one unread completion per session. */
  private notices = new Map<string, CompletionNotice>();
  private seen = new Set<string>();

  ingest(events: FinishedEvent[]): boolean {
    let changed = false;
    for (const event of events) {
      const key = `${event.id}:${event.at}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.notices.set(event.id, { ...event, key });
      changed = true;
    }
    return changed;
  }

  /** Newest unread completion, whether or not its banner time has elapsed. */
  latest(): CompletionNotice | null {
    return [...this.notices.values()].sort((a, b) => b.at - a.at)[0] || null;
  }

  /** A zero duration leaves the newest banner visible until it is acknowledged. */
  banner(now = Date.now(), durationSeconds = 0): CompletionNotice | null {
    const notice = this.latest();
    if (!notice || (durationSeconds && now - notice.at >= durationSeconds * 1000)) return null;
    return notice;
  }

  acknowledge(id: string): CompletionNotice | null {
    const removed = this.notices.get(id) || null;
    this.notices.delete(id);
    return removed;
  }

  acknowledgeLatest(): CompletionNotice | null {
    const notice = this.latest();
    return notice ? this.acknowledge(notice.id) : null;
  }

  has(id: string) {
    return this.notices.has(id);
  }

  /** A new turn or an ended process makes an old completion irrelevant. */
  resolve(id: string) {
    return !!this.acknowledge(id);
  }

  clear() {
    this.notices.clear();
  }

  get count() {
    return this.notices.size;
  }
}
