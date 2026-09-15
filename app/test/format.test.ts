import { test } from "node:test";
import assert from "node:assert/strict";
import { getTextWidth } from "@evenrealities/pretext";
import { padTo, sanitize, spread, truncate, wrap } from "../src/text.ts";
import { itemsToLines, shortModel, tidyMarkdown } from "../src/format.ts";
import type { Item } from "../src/types.ts";

const W = 568;

test("wrap keeps every line within the pixel width", () => {
  const text = "Both fixes are in and on their way to the phone: the attribution line now counts repeated shares, and the tap target covers the whole row so the title no longer eats taps. ".repeat(3);
  const lines = wrap(text, W, "» ", "   ");
  assert.ok(lines.length > 3);
  for (const l of lines) assert.ok(getTextWidth(l) <= W, `too wide (${getTextWidth(l)}): ${l}`);
  assert.ok(lines[0].startsWith("» "));
  assert.ok(lines[1].startsWith("   "));
});

test("wrap splits a word longer than the line", () => {
  const long = "packages/mobile_app/lib/features/checkout/widgets/order_summary_attribution_line_with_extra_long_name.dart";
  const lines = wrap(long, 200);
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.ok(getTextWidth(l) <= 200);
  assert.equal(lines.join(""), long);
});

test("wrap preserves blank lines between paragraphs", () => {
  assert.deepEqual(wrap("one\n\ntwo", W), ["one", "", "two"]);
});

test("sanitize maps glyphs the firmware lacks and drops emoji", () => {
  assert.equal(sanitize("✓ done ✗ fail ❯ go 🚀"), "√ done × fail › go ");
});

test("truncate, padTo and spread respect pixel widths", () => {
  assert.ok(getTextWidth(truncate("a very long header line that will not fit in the space", 150)) <= 150);
  assert.ok(getTextWidth(padTo("ab", 60)) >= 60);
  const line = spread("api-server · working", "Opus 5", W);
  assert.ok(getTextWidth(line) <= W);
  assert.ok(line.endsWith("Opus 5"));
});

test("markdown tidy: fences dropped, bullets become dots, blank runs collapse", () => {
  assert.equal(tidyMarkdown("## Plan\n\n\n- one\n* two\n```ts\ncode\n```\n"), "## Plan\n\n• one\n• two\ncode");
});

test("items render with turn gaps and collapsed tool runs", () => {
  const items: Item[] = [
    { key: "1", kind: "user", text: "fix the grocery rows" },
    { key: "2", kind: "assistant", text: "Looking at it." },
    { key: "3", kind: "tool", tool: "Read", text: "grocery_screen.dart" },
    { key: "4", kind: "tool", tool: "Read", text: "grocery_row.dart" },
    { key: "5", kind: "tool", tool: "Edit", text: "grocery_row.dart" },
    { key: "6", kind: "assistant", text: "Done." },
    { key: "7", kind: "user", text: "thanks" },
  ];
  assert.deepEqual(itemsToLines(items, W), [
    "» fix the grocery rows",
    "Looking at it.",
    "▷ Read ×2 · grocery_row.dart",
    "▷ Edit grocery_row.dart",
    "Done.",
    "",
    "» thanks",
  ]);
});

test("model names shorten", () => {
  assert.equal(shortModel("claude-opus-5"), "Opus 5");
  assert.equal(shortModel("claude-fable-5-1[1m]"), "Fable 5.1");
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
});
