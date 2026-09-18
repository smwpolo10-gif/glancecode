import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenSlashCommand } from "../src/voice-command.ts";

test("spoken slash commands normalize explicit dictation", () => {
  assert.equal(spokenSlashCommand("slash clear."), "/clear");
  assert.equal(spokenSlashCommand("Forward slash resume"), "/resume");
  assert.equal(spokenSlashCommand("/ model Opus"), "/model opus");
  assert.equal(spokenSlashCommand("slash context?"), "/context");
  assert.equal(spokenSlashCommand("slash effort high"), "/effort high");
  assert.equal(spokenSlashCommand("slash effort"), "/effort");
});

test("ordinary prompts and unsupported commands remain prompts", () => {
  assert.equal(spokenSlashCommand("clear the test output"), null);
  assert.equal(spokenSlashCommand("resume the work"), null);
  assert.equal(spokenSlashCommand("slash permissions"), null);
});
