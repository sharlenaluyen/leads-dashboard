import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-changes-"));
process.env.LEADS_CHANGES = path.join(dir, "sheet-changes.jsonl");
const { logChanges, markFailed, readChanges } = await import("../src/changes.js");

test("logged changes read back newest first, with undone ones marked", () => {
  const [a, b] = logChanges([
    { by: "sync", source: "s", tab: "t", row: 2, email: "a@x.com", key: "lastEmail", old: "", new: "10/28/2026" },
    { by: "sync", source: "s", tab: "t", row: 3, email: "b@x.com", key: "followUpStatus", old: "Open", new: "Awaiting Reply" },
  ]);
  assert.equal(a.column, "last email", "the sheet's header name is recorded");
  logChanges([{ by: "undo", source: "s", tab: "t", row: 3, email: "b@x.com", key: "followUpStatus", old: "Awaiting Reply", new: "Open", undoOf: b.id }]);
  const entries = readChanges();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].by, "undo");
  assert.equal(entries.find((e) => e.id === b.id).undone, true);
  assert.equal(entries.find((e) => e.id === a.id).undone, false);
});

test("an entry after a cut-off last line still reads back", () => {
  fs.appendFileSync(process.env.LEADS_CHANGES, '{"id":"half","by":"sy');
  const [c] = logChanges([{ by: "dashboard", source: "s", tab: "t", row: 4, email: "c@x.com", key: "priority", old: "", new: "2" }]);
  assert.ok(readChanges().some((e) => e.id === c.id));
});

test("a change whose write failed is marked, not listed twice", () => {
  const [d] = logChanges([{ by: "dashboard", source: "s", tab: "t", row: 5, email: "d@x.com", key: "priority", old: "", new: "3" }]);
  markFailed([d], new Error("quota"));
  const entries = readChanges();
  assert.equal(entries.filter((e) => e.failedOf).length, 0);
  assert.equal(entries.find((e) => e.id === d.id).failed, "quota");
});
