import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionInbox } from "../src/completion.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { BlankScreen, cycleHudMode, formatClock, formatDate, layoutWidgets, pomodoroText, sessionStamp } from "../src/hud.ts";
import type { App } from "../src/app.ts";

test("HUD swipes cycle through Pomodoro only when it is enabled", () => {
  assert.equal(cycleHudMode("ambient", "down", true), "pomodoro");
  assert.equal(cycleHudMode("pomodoro", "down", true), "blank");
  assert.equal(cycleHudMode("blank", "down", true), "ambient");
  assert.equal(cycleHudMode("ambient", "up", true), "blank");
  assert.equal(cycleHudMode("blank", "up", true), "pomodoro");
  assert.equal(cycleHudMode("pomodoro", "up", true), "ambient");

  assert.equal(cycleHudMode("ambient", "down", false), "blank");
  assert.equal(cycleHudMode("blank", "down", false), "ambient");
  assert.equal(cycleHudMode("ambient", "up", false), "blank");
  assert.equal(cycleHudMode("blank", "up", false), "ambient");
});

test("blank HUD draws nothing until a completion alert arrives", () => {
  const completions = new CompletionInbox();
  const app = { settings: { current: DEFAULT_SETTINGS }, completions } as unknown as App;
  const screen = new BlankScreen(app);
  assert.ok(screen.frame().body.every((line) => line === ""));

  completions.ingest([{ id: "done", project: "Pillbee", message: "Finished", at: Date.now() }]);
  const alert = screen.frame().body.join("\n");
  assert.match(alert, /Pillbee finished/);
});

test("clock defaults to 12-hour time without seconds", () => {
  const at = new Date(2026, 8, 18, 13, 5, 42);
  assert.equal(formatClock(at, DEFAULT_SETTINGS.hud.clock), "1:05 PM");
  assert.equal(formatClock(at, { ...DEFAULT_SETTINGS.hud.clock, showPeriod: false }), "1:05");
  assert.equal(formatClock(at, { ...DEFAULT_SETTINGS.hud.clock, hourCycle: "h24" }), "13:05");
  assert.equal(formatClock(at, { ...DEFAULT_SETTINGS.hud.clock, showSeconds: true }), "1:05:42 PM");
});

test("date formats and optional session stamp follow settings", () => {
  const at = new Date(2026, 8, 18, 13, 5);
  assert.equal(formatDate(at, "weekday-month-day"), "Fri, Sep 18");
  assert.equal(formatDate(at, "month-day"), "Sep 18");
  assert.equal(formatDate(at, "numeric"), "9/18");
  assert.equal(sessionStamp(DEFAULT_SETTINGS, at), "1:05 PM");
  assert.equal(sessionStamp({ ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions, showDate: true } }, at), "1:05 PM · Fri, Sep 18");
});

test("native HUD layout places widgets in the requested grid rows", () => {
  const body = layoutWidgets([
    { text: "1:05 PM", position: "top-left" },
    { text: "Sep 18", position: "top-right" },
    { text: "25:00", position: "center" },
    { text: "◆2", position: "bottom-right" },
  ]);
  assert.match(body[0], /^1:05 PM.*Sep 18$/);
  assert.ok(body[Math.floor(body.length / 2)].trim().endsWith("25:00"));
  assert.ok(body.at(-1)?.trim().endsWith("◆2"));
});

test("Pomodoro hides state text and only labels breaks when requested", () => {
  assert.equal(pomodoroText(5 * 60_000, "focus", "break"), "05:00");
  assert.equal(pomodoroText(5 * 60_000, "shortBreak", "off"), "05:00");
  assert.equal(pomodoroText(5 * 60_000, "shortBreak", "b"), "B 05:00");
  assert.equal(pomodoroText(5 * 60_000, "longBreak", "break"), "Break 05:00");
});
