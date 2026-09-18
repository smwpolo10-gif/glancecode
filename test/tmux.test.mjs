import assert from "node:assert/strict";
import test from "node:test";
import { sessionNameFor, terminalAttachCommand } from "../hub/tmux.mjs";
import { BRAND } from "../hub/brand.mjs";

test("desktop attach command accepts only generated tmux session names", () => {
  assert.equal(terminalAttachCommand("Pillbee-2"), `${BRAND.name} attach Pillbee-2`);
  assert.throws(() => terminalAttachCommand("Pillbee; touch /tmp/nope"), /unsafe tmux session name/);
});

test("generated tmux session names are safe for desktop attachment", () => {
  const name = sessionNameFor("/Users/test/Pill bee; nope", new Set());
  assert.equal(name, "Pill-bee--nope");
  assert.doesNotThrow(() => terminalAttachCommand(name));
});
