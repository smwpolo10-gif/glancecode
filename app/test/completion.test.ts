import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionInbox } from "../src/completion.ts";

test("completion inbox keeps one unread notice per session", () => {
  const inbox = new CompletionInbox();
  inbox.ingest([
    { id: "a", project: "Pillbee", message: "first", at: 1000 },
    { id: "a", project: "Pillbee", message: "second", at: 2000 },
    { id: "b", project: "Docs", message: "done", at: 1500 },
  ]);

  assert.equal(inbox.count, 2);
  assert.equal(inbox.latest()?.message, "second");
  assert.equal(inbox.acknowledge("a")?.message, "second");
  assert.equal(inbox.count, 1);
});

test("resolved completion does not return when old hub events replay", () => {
  const inbox = new CompletionInbox();
  const event = { id: "a", project: "Pillbee", message: "done", at: 1000 };
  inbox.ingest([event]);
  assert.equal(inbox.resolve("a"), true);
  inbox.ingest([event]);
  assert.equal(inbox.count, 0);
});

test("timed banners hide without acknowledging the unread notice", () => {
  const inbox = new CompletionInbox();
  inbox.ingest([{ id: "a", project: "Pillbee", message: "done", at: 1000 }]);
  assert.equal(inbox.banner(10_999, 10)?.id, "a");
  assert.equal(inbox.banner(11_000, 10), null);
  assert.equal(inbox.count, 1);
});
