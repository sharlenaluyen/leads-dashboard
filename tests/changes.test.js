import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-changes-"));
process.env.LEADS_CHANGES = path.join(dir, "sheet-changes.jsonl");
const { UserError } = await import("../src/errors.js");
const { findUndoTarget, logChanges, markFailed, newestFirst, readChanges } = await import("../src/changes.js");

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

test("an undo whose write failed doesn't mark the change undone", () => {
  const [e] = logChanges([{ by: "dashboard", source: "s", tab: "t", row: 6, email: "e@x.com", key: "priority", old: "", new: "1" }]);
  const [u] = logChanges([{ by: "undo", source: "s", tab: "t", row: 6, email: "e@x.com", key: "priority", old: "1", new: "", undoOf: e.id }]);
  markFailed([u], new Error("offline"));
  const entries = readChanges();
  assert.equal(entries.find((x) => x.id === e.id).undone, false);
  assert.equal(entries.find((x) => x.id === u.id).failed, "offline");
});

test("reading backward matches the whole file, across chunk boundaries and multi-byte text", () => {
  // Well over one 64 KB read, with names whose UTF-8 bytes can straddle a boundary.
  logChanges(
    Array.from({ length: 1500 }, (_, i) => ({ by: "sync", source: "s", tab: "Café ☕ 東京", row: i + 10, email: `n${i}@x.com`, key: "notes", old: "", new: "é".repeat(i % 50) }))
  );
  const forward = fs
    .readFileSync(process.env.LEADS_CHANGES, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  assert.ok(fs.statSync(process.env.LEADS_CHANGES).size > 3 * 64 * 1024);
  assert.deepEqual([...newestFirst()], forward.reverse());
});

test("readChanges returns only the newest `limit` entries", () => {
  const entries = readChanges({ limit: 5 });
  assert.equal(entries.length, 5);
  assert.equal(entries[0].row, 1509);
  assert.equal(entries[4].row, 1505);
});

// --- findUndoTarget: which logged changes Undo will act on -----------------

const cell = (over = {}) => ({ by: "dashboard", source: "s", tab: "u", row: 7, email: "u@x.com", key: "priority", old: "", new: "2", ...over });
const undoOf = (e) => cell({ by: "undo", old: e.new, new: e.old, undoOf: e.id });

test("undo finds a logged change, even with newer entries after it", () => {
  const [e] = logChanges([cell()]);
  logChanges([cell({ row: 8, email: "v@x.com" }), cell({ row: 9, email: "w@x.com" })]);
  const found = findUndoTarget(e.id);
  assert.equal(found.id, e.id);
  assert.equal(found.new, "2");
});

test("undo refuses an id that isn't in the log, including a failure marker's id", () => {
  assert.throws(() => findUndoTarget("nope"), (err) => err instanceof UserError && /isn't in the log/.test(err.message));
  const [e] = logChanges([cell()]);
  markFailed([e], new Error("x"));
  const marker = [...newestFirst()][0];
  assert.equal(marker.failedOf, e.id);
  assert.throws(() => findUndoTarget(marker.id), /isn't in the log/);
});

test("undo refuses a change whose write failed", () => {
  const [e] = logChanges([cell()]);
  markFailed([e], new Error("quota"));
  assert.throws(() => findUndoTarget(e.id), /never reached the spreadsheet/);
});

test("undo refuses a change that was already undone", () => {
  const [e] = logChanges([cell()]);
  logChanges([undoOf(e)]);
  assert.throws(() => findUndoTarget(e.id), /already undone/);
});

test("a change whose undo failed can be undone again", () => {
  const [e] = logChanges([cell()]);
  const [u] = logChanges([undoOf(e)]);
  markFailed([u], new Error("offline"));
  assert.equal(findUndoTarget(e.id).id, e.id);
  // ...and once a retry goes through, it's undone.
  logChanges([undoOf(e)]);
  assert.throws(() => findUndoTarget(e.id), /already undone/);
});

test("an undo of some other change doesn't block this one", () => {
  const [a, b] = logChanges([cell(), cell({ row: 10, email: "z@x.com" })]);
  logChanges([undoOf(b)]);
  assert.equal(findUndoTarget(a.id).id, a.id);
});

test("undo refuses an added row", () => {
  const [e] = logChanges([cell({ by: "add-contact", key: "email", new: "new@x.com" })]);
  assert.throws(() => findUndoTarget(e.id), /delete the row/);
});

test("undo finds an old change far back in a long log", () => {
  const [e] = logChanges([cell({ row: 11, email: "old@x.com" })]);
  logChanges(Array.from({ length: 2000 }, (_, i) => cell({ row: 100 + i, email: `f${i}@x.com`, new: "é".repeat(i % 30) })));
  assert.equal(findUndoTarget(e.id).email, "old@x.com");
});
