import { test } from "node:test";
import assert from "node:assert/strict";
import { PomodoroTimer, formatCountdown } from "../src/pomodoro.ts";

const durations = { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 2 };

test("pomodoro countdown is always MM:SS", () => {
  assert.equal(formatCountdown(25 * 60_000), "25:00");
  assert.equal(formatCountdown(61_001), "01:02");
  assert.equal(formatCountdown(0), "00:00");
});

test("pomodoro uses an absolute deadline and pauses at the correct time", () => {
  const timer = new PomodoroTimer(durations);
  timer.startPause(1000);
  assert.equal(timer.snapshot(61_000).remainingMs, 24 * 60_000);
  timer.startPause(61_000);
  assert.equal(timer.snapshot(500_000).remainingMs, 24 * 60_000);
  assert.equal(timer.snapshot().running, false);
});

test("completed focus moves to a break and every second round is long", () => {
  const timer = new PomodoroTimer({ workMinutes: 1, shortBreakMinutes: 1, longBreakMinutes: 2, roundsBeforeLongBreak: 2 });
  timer.startPause(0);
  assert.equal(timer.tick(60_000), true);
  assert.equal(timer.snapshot(60_000).phase, "shortBreak");
  timer.skip(60_000);
  timer.startPause(60_000);
  timer.tick(120_000);
  assert.equal(timer.snapshot(120_000).phase, "longBreak");
});
