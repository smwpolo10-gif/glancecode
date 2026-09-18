import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBattery, normalizeBatteryLevel } from "../src/battery.ts";

test("battery readings are rounded and constrained to a percentage", () => {
  assert.equal(normalizeBatteryLevel(82.4), 82);
  assert.equal(normalizeBatteryLevel(140), 100);
  assert.equal(normalizeBatteryLevel(-4), 0);
  assert.equal(normalizeBatteryLevel(undefined), null);
});

test("battery text supports a compact label and charging marker", () => {
  assert.equal(formatBattery(82, false, "percent", true), "82%");
  assert.equal(formatBattery(82, true, "percent", true), "82%+");
  assert.equal(formatBattery(82, true, "label", false), "Bat 82%");
  assert.equal(formatBattery(null, false, "percent", true), null);
});
