import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { formatClock, formatDate, layoutWidgets, pomodoroText, sessionStamp } from "../src/hud.ts";

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
