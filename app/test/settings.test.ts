import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsStore, normalizeSettings } from "../src/settings.ts";

class MemoryBridge {
  values = new Map<string, string>();
  writes: Array<[string, string]> = [];

  async getLocalStorage(key: string) {
    return this.values.get(key) || "";
  }

  async setLocalStorage(key: string, value: string) {
    this.values.set(key, value);
    this.writes.push([key, value]);
    return true;
  }
}

test("defaults match the personal Terminal HUD setup", () => {
  const settings = normalizeSettings(null);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.startView, "hud");
  assert.equal(settings.hud.clock.hourCycle, "h12");
  assert.equal(settings.hud.clock.showPeriod, true);
  assert.equal(settings.hud.clock.showSeconds, false);
  assert.equal(settings.completion.clockMode, "banner");
  assert.equal(settings.completion.pomodoroMode, "bell");
  assert.equal(settings.completion.bannerDurationSeconds, 0);
  assert.equal(settings.openTerminalOnLaunch, true);
});

test("normalization preserves valid settings and clamps unsafe numbers", () => {
  const settings = normalizeSettings({
    startView: "sessions",
    hud: {
      brightness: 99,
      clock: { visible: false, hourCycle: "h24", showSeconds: true, showPeriod: false, position: "bottom-right", size: "large" },
      date: { format: "numeric" },
    },
    completion: { clockMode: "bell", pomodoroMode: "off", bellPlacement: "opposite-corner", bannerDurationSeconds: 5 },
    pomodoro: { workMinutes: 500, shortBreakMinutes: 0, longBreakMinutes: 31.7, roundsBeforeLongBreak: 30 },
    sessions: { showHistory: false },
    openTerminalOnLaunch: false,
  });

  assert.equal(settings.startView, "sessions");
  assert.equal(settings.hud.brightness, 4);
  assert.deepEqual(settings.hud.clock, {
    visible: false,
    hourCycle: "h24",
    showSeconds: true,
    showPeriod: false,
    position: "bottom-right",
    size: "large",
  });
  assert.equal(settings.completion.clockMode, "bell");
  assert.equal(settings.completion.pomodoroMode, "off");
  assert.equal(settings.completion.bellPlacement, "opposite-corner");
  assert.equal(settings.completion.bannerDurationSeconds, 5);
  assert.equal(settings.pomodoro.workMinutes, 180);
  assert.equal(settings.pomodoro.shortBreakMinutes, 1);
  assert.equal(settings.pomodoro.longBreakMinutes, 32);
  assert.equal(settings.pomodoro.roundsBeforeLongBreak, 12);
  assert.equal(settings.sessions.showHistory, false);
  assert.equal(settings.openTerminalOnLaunch, false);
});

test("invalid persisted values fall back field by field", () => {
  const settings = normalizeSettings({
    startView: "nope",
    hud: { brightness: "bright", clock: { position: "outside", size: "huge", hourCycle: "h13" } },
    completion: { clockMode: "toast", pomodoroMode: 3, bellPlacement: "under", bannerDurationSeconds: 12 },
    pomodoro: { workMinutes: "25" },
  });
  assert.equal(settings.startView, DEFAULT_SETTINGS.startView);
  assert.equal(settings.hud.clock.position, DEFAULT_SETTINGS.hud.clock.position);
  assert.equal(settings.hud.clock.size, DEFAULT_SETTINGS.hud.clock.size);
  assert.equal(settings.completion.clockMode, DEFAULT_SETTINGS.completion.clockMode);
  assert.equal(settings.completion.pomodoroMode, DEFAULT_SETTINGS.completion.pomodoroMode);
  assert.equal(settings.completion.bellPlacement, DEFAULT_SETTINGS.completion.bellPlacement);
  assert.equal(settings.completion.bannerDurationSeconds, DEFAULT_SETTINGS.completion.bannerDurationSeconds);
  assert.equal(settings.pomodoro.workMinutes, DEFAULT_SETTINGS.pomodoro.workMinutes);
});

test("old completion settings migrate without re-enabling disabled alerts", () => {
  const disabled = normalizeSettings({ completion: { enabled: false, dismissAfterSeconds: 30 } });
  assert.equal(disabled.completion.clockMode, "off");
  assert.equal(disabled.completion.pomodoroMode, "off");
  assert.equal(disabled.completion.bannerDurationSeconds, 30);
});

test("store survives corrupt JSON, deep-merges patches, publishes and persists", async () => {
  const bridge = new MemoryBridge();
  bridge.values.set(SETTINGS_KEY, "{not json");
  const store = await SettingsStore.open(bridge);
  assert.deepEqual(store.current, DEFAULT_SETTINGS);

  const seen: string[] = [];
  const unsubscribe = store.subscribe((settings) => seen.push(`${settings.hud.clock.hourCycle}:${settings.hud.date.visible}`));
  await store.update({ hud: { clock: { hourCycle: "h24" }, date: { visible: false } } });
  unsubscribe();

  assert.deepEqual(seen, ["h12:true", "h24:false"]);
  assert.equal(store.current.hud.clock.visible, true);
  assert.equal(store.current.hud.clock.showSeconds, false);
  assert.equal(store.current.hud.date.format, DEFAULT_SETTINGS.hud.date.format);
  assert.equal(bridge.writes.length, 1);
  assert.equal(bridge.writes[0][0], SETTINGS_KEY);
  assert.deepEqual(JSON.parse(bridge.writes[0][1]), store.current);
});
