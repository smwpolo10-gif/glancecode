import { BODY_INNER_W, BODY_LINES, type Frame, type MenuItem } from "./display.ts";
import type { App, Screen } from "./app.ts";
import type { Action } from "./input.ts";
import type { BreakLabel, GridCell, TerminalHudSettings } from "./settings.ts";
import { formatCountdown } from "./pomodoro.ts";
import type { PomodoroPhase } from "./pomodoro.ts";
import { padTo, spread, truncate, width, wrap } from "./text.ts";

const MENU_SESSIONS = 20;
const MENU_POMODORO = 21;
const MENU_DISMISS = 22;
const MENU_EXIT = 23;
const MENU_RESET = 30;
const MENU_SKIP = 31;
const MENU_ADD_FIVE = 32;
const MENU_HUD = 33;
const MENU_REFRESH = 7;

export type CompletionMode = "off" | "bell" | "banner";

type CompletionPreferences = TerminalHudSettings["completion"] & {
  enabled?: boolean;
  dismissAfterSeconds?: number;
};

export function completionMode(settings: TerminalHudSettings, view: "clock" | "pomodoro"): CompletionMode {
  const completion = settings.completion as CompletionPreferences;
  return completion[view === "clock" ? "clockMode" : "pomodoroMode"] || (completion.enabled === false ? "off" : "banner");
}

export function completionBannerSeconds(settings: TerminalHudSettings): number {
  const completion = settings.completion as CompletionPreferences;
  return completion.bannerDurationSeconds ?? completion.dismissAfterSeconds ?? 0;
}

function cleanFormatted(value: string) {
  return value.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatClock(at: Date, clock: TerminalHudSettings["hud"]["clock"]): string {
  let value = cleanFormatted(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      ...(clock.showSeconds ? { second: "2-digit" } : {}),
      hourCycle: clock.hourCycle,
    }).format(at),
  );
  if (clock.hourCycle === "h12" && !clock.showPeriod) value = value.replace(/\s*[AP]M$/i, "");
  return value;
}

export function formatDate(at: Date, format: TerminalHudSettings["hud"]["date"]["format"]): string {
  if (format === "numeric") return new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric" }).format(at);
  if (format === "month-day") return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(at);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(at);
}

export function sessionStamp(settings: TerminalHudSettings, now = new Date()): string {
  const parts: string[] = [];
  if (settings.sessions.showTime) parts.push(formatClock(now, { ...settings.hud.clock, showSeconds: false }));
  if (settings.sessions.showDate) parts.push(formatDate(now, settings.hud.date.format));
  return parts.join(" · ");
}

export function pomodoroText(remainingMs: number, phase: PomodoroPhase, breakLabel: BreakLabel): string {
  const countdown = formatCountdown(remainingMs);
  if (phase === "focus" || breakLabel === "off") return countdown;
  return breakLabel === "b" ? `B ${countdown}` : `Break ${countdown}`;
}

type HudWidget = { text: string; position: GridCell };

function vertical(position: GridCell): number {
  if (position === "center" || String(position).startsWith("middle")) return Math.floor(BODY_LINES / 2);
  if (String(position).startsWith("bottom")) return BODY_LINES - 1;
  return 0;
}

function horizontal(position: GridCell): "left" | "center" | "right" {
  if (String(position).endsWith("center")) return "center";
  if (String(position).endsWith("right")) return "right";
  return "left";
}

function centered(text: string): string {
  const value = truncate(text, BODY_INNER_W);
  return `${padTo("", Math.max(0, (BODY_INNER_W - width(value)) / 2))}${value}`;
}

/** Approximate the 3×3 phone preview with the native fixed-size G2 font. */
export function layoutWidgets(widgets: HudWidget[]): string[] {
  const rows = Array.from({ length: BODY_LINES }, () => ({ left: "", center: "", right: "" }));
  for (const widget of widgets) {
    const bucket = rows[vertical(widget.position)];
    const side = horizontal(widget.position);
    bucket[side] = bucket[side] ? `${bucket[side]}  ${widget.text}` : widget.text;
  }
  return rows.map((row) => {
    if (row.center && !row.left && !row.right) return centered(row.center);
    if (row.left || row.right) {
      const edges = spread(row.left, row.right, BODY_INNER_W);
      return row.center ? spread(edges, row.center, BODY_INNER_W) : edges;
    }
    return "";
  });
}

function noticeBody(app: App, now: number): string[] | null {
  const settings = app.settings.current;
  if (completionMode(settings, "clock") !== "banner") return null;
  const notice = app.completions.banner(now, completionBannerSeconds(settings));
  if (!notice) return null;
  const finishedAt = formatClock(new Date(notice.at), { ...settings.hud.clock, showSeconds: false });
  const compact = `√ ${notice.project} finished · ${finishedAt}`;
  const text = settings.completion.detail === "expanded" && notice.message ? `${compact}\n${notice.message}` : compact;
  const lines = wrap(text, BODY_INNER_W).slice(0, settings.completion.detail === "expanded" ? 4 : 2);
  const body = Array.from({ length: BODY_LINES }, () => "");
  let start = vertical(settings.completion.position);
  if (String(settings.completion.position).startsWith("middle")) start -= Math.floor(lines.length / 2);
  if (String(settings.completion.position).startsWith("bottom")) start -= lines.length - 1;
  start = Math.max(0, Math.min(BODY_LINES - lines.length, start));
  lines.forEach((line, index) => {
    const side = horizontal(settings.completion.position);
    body[start + index] = side === "center" ? centered(line) : side === "right" ? spread("", line, BODY_INNER_W) : truncate(line, BODY_INNER_W);
  });
  return body;
}

function opposite(position: GridCell): GridCell {
  const map: Partial<Record<GridCell, GridCell>> = {
    "top-left": "bottom-right",
    "top-center": "bottom-center",
    "top-right": "bottom-left",
    "middle-left": "middle-right",
    center: "top-right",
    "middle-right": "middle-left",
    "bottom-left": "top-right",
    "bottom-center": "top-center",
    "bottom-right": "top-left",
  };
  return map[position] || "top-right";
}

function addBell(app: App, view: "clock" | "pomodoro", widgets: HudWidget[], target: HudWidget | undefined) {
  const settings = app.settings.current;
  if (!app.completions.count || completionMode(settings, view) !== "bell") return;
  const bell = app.completions.count > 1 ? `◆${app.completions.count}` : "◆";
  if (target && settings.completion.bellPlacement !== "opposite-corner") {
    target.text = settings.completion.bellPlacement === "before" ? `${bell} ${target.text}` : `${target.text} ${bell}`;
  } else {
    widgets.push({ text: bell, position: target ? opposite(target.position) : "top-right" });
  }
}

export class AmbientScreen implements Screen {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  frame(): Frame {
    const settings = this.app.settings.current;
    const now = Date.now();
    const notice = noticeBody(this.app, now);
    const menu: MenuItem[] = [
      { id: MENU_SESSIONS, name: "Sessions" },
      { id: MENU_POMODORO, name: "Pomodoro" },
      ...(this.app.completions.count ? [{ id: MENU_DISMISS, name: "Dismiss all alerts" }] : []),
      { id: MENU_REFRESH, name: "Refresh" },
      { id: MENU_EXIT, name: "Exit Terminal HUD" },
    ];
    if (notice) return { header: "", body: notice, menu };

    const at = new Date(now);
    const widgets: HudWidget[] = [];
    let clockWidget: HudWidget | undefined;
    if (settings.hud.clock.visible) {
      clockWidget = { text: formatClock(at, settings.hud.clock), position: settings.hud.clock.position };
      widgets.push(clockWidget);
    }
    if (settings.hud.date.visible) widgets.push({ text: formatDate(at, settings.hud.date.format), position: settings.hud.date.position });
    const battery = this.app.batteryText();
    if (settings.battery.hud.visible && battery) widgets.push({ text: battery, position: settings.battery.hud.position });
    addBell(this.app, "clock", widgets, clockWidget);
    return { header: "", body: layoutWidgets(widgets), menu };
  }

  action(a: Action) {
    const settings = this.app.settings.current;
    const banner = completionMode(settings, "clock") === "banner" ? this.app.completions.banner(Date.now(), completionBannerSeconds(settings)) : null;
    if (a.type === "tap") {
      if (banner) {
        this.app.completions.acknowledge(banner.id);
        this.app.openSession(banner.id);
      } else this.app.openSessions();
    } else if (a.type === "down" && banner) {
      this.app.completions.acknowledge(banner.id);
      this.app.toast("Dismissed", 1200);
    } else if (a.type === "up" || a.type === "down") {
      this.app.openPomodoro();
    } else if (a.type === "doubleTap") {
      void this.app.bridge.shutDownPageContainer(1);
    } else if (a.type === "menu") {
      if (a.id === MENU_SESSIONS) this.app.openSessions();
      else if (a.id === MENU_POMODORO) this.app.openPomodoro();
      else if (a.id === MENU_DISMISS) {
        this.app.completions.clear();
        this.app.toast("Alerts dismissed", 1200);
      } else if (a.id === MENU_REFRESH) this.app.hub.refresh();
      else if (a.id === MENU_EXIT) void this.app.bridge.shutDownPageContainer(1);
    }
  }

  needsWake() {
    const settings = this.app.settings.current;
    const seconds = completionBannerSeconds(settings);
    const timedBannerVisible = completionMode(settings, "clock") === "banner" && !!seconds && !!this.app.completions.banner(Date.now(), seconds);
    return settings.hud.clock.visible || settings.hud.date.visible || settings.battery.hud.visible || timedBannerVisible;
  }

  tickKey(now = Date.now()) {
    const settings = this.app.settings.current;
    const clockUnit = settings.hud.clock.showSeconds ? 1000 : 60_000;
    const pieces = [settings.hud.clock.visible ? Math.floor(now / clockUnit) : 0, settings.hud.date.visible ? new Date(now).toDateString() : ""];
    const seconds = completionBannerSeconds(settings);
    if (completionMode(settings, "clock") === "banner" && seconds && this.app.completions.banner(now, seconds)) pieces.push(Math.floor(now / 1000));
    return pieces.join(":");
  }
}

export class PomodoroScreen implements Screen {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  frame(): Frame {
    const snapshot = this.app.pomodoro.snapshot();
    const settings = this.app.settings.current;
    const timerWidget: HudWidget = {
      text: pomodoroText(snapshot.remainingMs, snapshot.phase, settings.pomodoro.breakLabel),
      position: settings.pomodoro.position,
    };
    const widgets: HudWidget[] = [timerWidget];
    const battery = this.app.batteryText();
    if (settings.battery.pomodoro.visible && battery) widgets.push({ text: battery, position: settings.battery.pomodoro.position });
    const mode = completionMode(settings, "pomodoro");
    const banner = mode === "banner" ? this.app.completions.banner(Date.now(), completionBannerSeconds(settings)) : null;
    if (banner) {
      const text = settings.completion.detail === "expanded" && banner.message ? `√ ${banner.project} finished · ${banner.message}` : `√ ${banner.project} finished`;
      widgets.push({ text: truncate(text, BODY_INNER_W), position: settings.completion.position });
    } else {
      addBell(this.app, "pomodoro", widgets, timerWidget);
    }
    const menu: MenuItem[] = [
      { id: MENU_RESET, name: "Reset timer" },
      { id: MENU_SKIP, name: "Skip phase" },
      { id: MENU_ADD_FIVE, name: "+5 minutes" },
      ...(this.app.completions.count ? [{ id: MENU_DISMISS, name: "Dismiss all alerts" }] : []),
      { id: MENU_SESSIONS, name: "Sessions" },
      { id: MENU_HUD, name: "Ambient HUD" },
    ];
    return { header: "", body: layoutWidgets(widgets), menu };
  }

  action(a: Action) {
    const settings = this.app.settings.current;
    const banner = completionMode(settings, "pomodoro") === "banner" ? this.app.completions.banner(Date.now(), completionBannerSeconds(settings)) : null;
    if (a.type === "tap") {
      if (banner) {
        this.app.completions.acknowledge(banner.id);
        this.app.openSession(banner.id);
      } else {
        this.app.pomodoro.startPause();
        this.app.render(true);
      }
    } else if (a.type === "down" && banner) {
      this.app.completions.acknowledge(banner.id);
      this.app.toast("Dismissed", 1200);
    } else if (a.type === "up" || a.type === "down" || a.type === "doubleTap") {
      this.app.pop();
    } else if (a.type === "menu") {
      if (a.id === MENU_RESET) this.app.pomodoro.reset();
      else if (a.id === MENU_SKIP) this.app.pomodoro.skip();
      else if (a.id === MENU_ADD_FIVE) this.app.pomodoro.addMinutes(5);
      else if (a.id === MENU_DISMISS) this.app.completions.clear();
      else if (a.id === MENU_SESSIONS) this.app.openSessions();
      else if (a.id === MENU_HUD) this.app.popToAmbient();
    }
  }

  needsWake() {
    const settings = this.app.settings.current;
    const seconds = completionBannerSeconds(settings);
    return this.app.pomodoro.snapshot().running || settings.battery.pomodoro.visible || (completionMode(settings, "pomodoro") === "banner" && !!seconds && !!this.app.completions.banner(Date.now(), seconds));
  }

  tickKey(now = Date.now()) {
    const snapshot = this.app.pomodoro.snapshot(now);
    const settings = this.app.settings.current;
    const seconds = completionBannerSeconds(settings);
    const bannerTick = completionMode(settings, "pomodoro") === "banner" && seconds && this.app.completions.banner(now, seconds) ? Math.floor(now / 1000) : 0;
    return `${snapshot.phase}:${snapshot.running}:${Math.ceil(snapshot.remainingMs / 1000)}:${this.app.completions.count}:${bannerTick}`;
  }
}
