import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

export const SETTINGS_KEY = "terminalhud.settings.v1";

export type GridCell =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type WidgetSize = "small" | "medium" | "large";
export type DateFormat = "weekday-month-day" | "month-day" | "numeric";
export type CompletionMode = "off" | "bell" | "banner";
export type BellPlacement = "before" | "after" | "opposite-corner";
export type BannerDurationSeconds = 0 | 5 | 10 | 30 | 60;
export type BreakLabel = "off" | "b" | "break";

export interface WidgetPlacement {
  position: GridCell;
  size: WidgetSize;
}

export interface TerminalHudSettings {
  version: 1;
  startView: "hud" | "sessions";
  hud: {
    brightness: 0 | 1 | 2 | 3 | 4;
    clock: WidgetPlacement & {
      visible: boolean;
      hourCycle: "h12" | "h24";
      showSeconds: boolean;
      showPeriod: boolean;
    };
    date: WidgetPlacement & {
      visible: boolean;
      format: DateFormat;
    };
  };
  completion: WidgetPlacement & {
    clockMode: CompletionMode;
    pomodoroMode: CompletionMode;
    bellPlacement: BellPlacement;
    detail: "compact" | "expanded";
    bannerDurationSeconds: BannerDurationSeconds;
  };
  pomodoro: WidgetPlacement & {
    workMinutes: number;
    shortBreakMinutes: number;
    longBreakMinutes: number;
    roundsBeforeLongBreak: number;
    breakLabel: BreakLabel;
  };
  sessions: {
    showTime: boolean;
    showDate: boolean;
    showHistory: boolean;
  };
  openTerminalOnLaunch: boolean;
}

export type AppSettings = TerminalHudSettings;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_SETTINGS: TerminalHudSettings = {
  version: 1,
  startView: "hud",
  hud: {
    brightness: 4,
    clock: {
      visible: true,
      hourCycle: "h12",
      showSeconds: false,
      showPeriod: true,
      position: "top-left",
      size: "medium",
    },
    date: {
      visible: true,
      format: "weekday-month-day",
      position: "top-right",
      size: "small",
    },
  },
  completion: {
    clockMode: "banner",
    pomodoroMode: "bell",
    bellPlacement: "after",
    detail: "compact",
    position: "center",
    size: "medium",
    bannerDurationSeconds: 0,
  },
  pomodoro: {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    roundsBeforeLongBreak: 4,
    breakLabel: "off",
    position: "bottom-center",
    size: "medium",
  },
  sessions: {
    showTime: true,
    showDate: false,
    showHistory: true,
  },
  openTerminalOnLaunch: true,
};

const GRID_CELLS = new Set<GridCell>([
  "top-left", "top-center", "top-right",
  "middle-left", "center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
]);
const WIDGET_SIZES = new Set<WidgetSize>(["small", "medium", "large"]);
const DATE_FORMATS = new Set<DateFormat>(["weekday-month-day", "month-day", "numeric"]);
const COMPLETION_MODES = new Set<CompletionMode>(["off", "bell", "banner"]);
const BELL_PLACEMENTS = new Set<BellPlacement>(["before", "after", "opposite-corner"]);
const BANNER_DURATIONS = new Set<BannerDurationSeconds>([0, 5, 10, 30, 60]);
const BREAK_LABELS = new Set<BreakLabel>(["off", "b", "break"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function placement(raw: Record<string, unknown>, fallback: WidgetPlacement): WidgetPlacement {
  return {
    position: oneOf(raw.position, GRID_CELLS, fallback.position),
    size: oneOf(raw.size, WIDGET_SIZES, fallback.size),
  };
}

/** Merge saved or partial settings with v1 defaults and discard malformed values. */
export function normalizeSettings(value: unknown): TerminalHudSettings {
  const root = record(value);
  const hud = record(root.hud);
  const clock = record(hud.clock);
  const date = record(hud.date);
  const completion = record(root.completion);
  const pomodoro = record(root.pomodoro);
  const sessions = record(root.sessions);
  const d = DEFAULT_SETTINGS;

  const legacyEnabled = completion.enabled;
  const legacyDismiss = Number(completion.dismissAfterSeconds);
  const bannerDuration = Number(completion.bannerDurationSeconds ?? legacyDismiss);
  const brightness = int(hud.brightness, d.hud.brightness, 0, 4) as TerminalHudSettings["hud"]["brightness"];

  return {
    version: 1,
    startView: root.startView === "sessions" ? "sessions" : "hud",
    hud: {
      brightness,
      clock: {
        ...placement(clock, d.hud.clock),
        visible: bool(clock.visible, d.hud.clock.visible),
        hourCycle: clock.hourCycle === "h24" ? "h24" : "h12",
        showSeconds: bool(clock.showSeconds, d.hud.clock.showSeconds),
        showPeriod: bool(clock.showPeriod, d.hud.clock.showPeriod),
      },
      date: {
        ...placement(date, d.hud.date),
        visible: bool(date.visible, d.hud.date.visible),
        format: oneOf(date.format, DATE_FORMATS, d.hud.date.format),
      },
    },
    completion: {
      ...placement(completion, d.completion),
      clockMode: legacyEnabled === false ? "off" : oneOf(completion.clockMode, COMPLETION_MODES, d.completion.clockMode),
      pomodoroMode: legacyEnabled === false ? "off" : oneOf(completion.pomodoroMode, COMPLETION_MODES, d.completion.pomodoroMode),
      bellPlacement: oneOf(completion.bellPlacement, BELL_PLACEMENTS, d.completion.bellPlacement),
      detail: completion.detail === "expanded" ? "expanded" : "compact",
      bannerDurationSeconds: BANNER_DURATIONS.has(bannerDuration as BannerDurationSeconds)
        ? bannerDuration as BannerDurationSeconds
        : d.completion.bannerDurationSeconds,
    },
    pomodoro: {
      ...placement(pomodoro, d.pomodoro),
      workMinutes: int(pomodoro.workMinutes, d.pomodoro.workMinutes, 1, 180),
      shortBreakMinutes: int(pomodoro.shortBreakMinutes, d.pomodoro.shortBreakMinutes, 1, 60),
      longBreakMinutes: int(pomodoro.longBreakMinutes, d.pomodoro.longBreakMinutes, 1, 120),
      roundsBeforeLongBreak: int(pomodoro.roundsBeforeLongBreak, d.pomodoro.roundsBeforeLongBreak, 1, 12),
      breakLabel: oneOf(pomodoro.breakLabel, BREAK_LABELS, d.pomodoro.breakLabel),
    },
    sessions: {
      showTime: bool(sessions.showTime, d.sessions.showTime),
      showDate: bool(sessions.showDate, d.sessions.showDate),
      showHistory: bool(sessions.showHistory, d.sessions.showHistory),
    },
    openTerminalOnLaunch: bool(root.openTerminalOnLaunch, d.openTerminalOnLaunch),
  };
}

function mergeSettings(base: TerminalHudSettings, patch: DeepPartial<TerminalHudSettings>): unknown {
  const root = record(patch);
  return {
    ...base,
    ...root,
    hud: {
      ...base.hud,
      ...record(root.hud),
      clock: { ...base.hud.clock, ...record(record(root.hud).clock) },
      date: { ...base.hud.date, ...record(record(root.hud).date) },
    },
    completion: { ...base.completion, ...record(root.completion) },
    pomodoro: { ...base.pomodoro, ...record(root.pomodoro) },
    sessions: { ...base.sessions, ...record(root.sessions) },
  };
}

type SettingsBridge = Pick<EvenAppBridge, "getLocalStorage" | "setLocalStorage">;
type Listener = (settings: TerminalHudSettings) => void;

export class SettingsStore {
  private bridge: SettingsBridge;
  private value: TerminalHudSettings;
  private listeners = new Set<Listener>();
  private write: Promise<unknown> = Promise.resolve();

  private constructor(bridge: SettingsBridge, initial: TerminalHudSettings) {
    this.bridge = bridge;
    this.value = initial;
  }

  static async open(bridge: SettingsBridge): Promise<SettingsStore> {
    let saved: unknown = null;
    try {
      const text = await bridge.getLocalStorage(SETTINGS_KEY);
      if (text) saved = JSON.parse(text);
    } catch {
      // Corrupt or unavailable storage falls back to safe defaults.
    }
    return new SettingsStore(bridge, normalizeSettings(saved));
  }

  get current(): TerminalHudSettings {
    return this.value;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  async update(next: DeepPartial<TerminalHudSettings> | TerminalHudSettings): Promise<TerminalHudSettings> {
    this.value = normalizeSettings(mergeSettings(this.value, next));
    for (const listener of this.listeners) listener(this.value);
    const serialized = JSON.stringify(this.value);
    this.write = this.write.catch(() => {}).then(() => this.bridge.setLocalStorage(SETTINGS_KEY, serialized));
    await this.write;
    return this.value;
  }
}
