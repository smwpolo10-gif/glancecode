// Normalize Even Hub events into a small set of actions, with the debouncing
// real hardware needs (duplicate events, phantom scrolls after text updates).
import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";

export type Action =
  | { type: "tap" }
  | { type: "doubleTap" }
  | { type: "up" }
  | { type: "down" }
  | { type: "holdStart" }
  | { type: "holdEnd" }
  | { type: "menu"; id: number }
  | { type: "foreground" }
  | { type: "background" }
  | { type: "exit" }
  | { type: "audio"; pcm: Uint8Array };

function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null;
  // A tap is value 0, which protobuf omits: a present envelope with no type is a click.
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
}

export class InputRouter {
  private last = new Map<string, number>();
  private holdEndedAt = 0;
  private holding = false;

  constructor(private emit: (a: Action) => void, private lastDisplayWrite: () => number) {}

  handle(event: EvenHubEvent) {
    if (event.audioEvent?.audioPcm) {
      this.emit({ type: "audio", pcm: event.audioEvent.audioPcm });
      return;
    }
    if (event.menuItemClickEvent?.itemID) {
      this.emit({ type: "menu", id: event.menuItemClickEvent.itemID });
      return;
    }
    const sys = typeOf(event.sysEvent);
    const text = typeOf(event.textEvent);
    const list = typeOf(event.listEvent);
    const t = [sys, text, list].find((v) => v !== null && v !== OsEventTypeList.CLICK_EVENT) ?? (sys ?? text ?? list);
    if (t === null || t === undefined) return;

    switch (t) {
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (this.debounce("double", 350)) this.emit({ type: "doubleTap" });
        return;
      case OsEventTypeList.SCROLL_TOP_EVENT:
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
        // Text updates can make the firmware report a boundary scroll; ignore those.
        if (Date.now() - this.lastDisplayWrite() < 120) return;
        const dir = t === OsEventTypeList.SCROLL_TOP_EVENT ? "up" : "down";
        if (this.debounce(`scroll-${dir}`, 220)) this.emit({ type: dir });
        return;
      }
      case OsEventTypeList.LONG_PRESS_EVENT:
        if (!this.holding && this.debounce("hold", 300)) {
          this.holding = true;
          this.emit({ type: "holdStart" });
        }
        return;
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
        if (this.holding) {
          this.holding = false;
          this.holdEndedAt = Date.now();
          this.emit({ type: "holdEnd" });
        }
        return;
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        if (this.debounce("fg", 600)) this.emit({ type: "foreground" });
        return;
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        if (this.debounce("bg", 600)) this.emit({ type: "background" });
        return;
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        this.emit({ type: "exit" });
        return;
      case OsEventTypeList.CLICK_EVENT:
        if (Date.now() - this.holdEndedAt < 500) return; // release of a long press
        if (this.debounce("tap", 250)) this.emit({ type: "tap" });
        return;
    }
  }

  private debounce(key: string, ms: number) {
    const now = Date.now();
    if (now - (this.last.get(key) || 0) < ms) return false;
    this.last.set(key, now);
    return true;
  }
}
