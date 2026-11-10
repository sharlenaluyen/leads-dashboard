// Timing of the hard reset (Settings → Hard reset / npm run rebuild) against
// syncs and dashboard edits, with a fake sync in place of the real one.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB_PATH is read when db.js loads, so point it at a temp file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-reset-"));
process.env.LEADS_DB = path.join(dir, "leads.db");
const { deleteDb, getDb } = await import("../src/db.js");
const { runReset, runSync, setSyncForTests } = await import("../src/sync.js");
const { withSheetLock } = await import("../src/lock.js");

const leadCount = () => getDb().prepare("SELECT COUNT(*) AS n FROM leads").get().n;
const seedLead = () =>
  getDb().prepare("INSERT INTO leads (source_id, tab, email, row_number) VALUES ('s', 'Leads', ?, 2)").run(`a${Math.random()}@example.com`);

// A fake sync that logs what it saw and finishes only when released.
function heldSync(log, name) {
  let release;
  const gate = new Promise((r) => (release = r));
  const fn = async () => {
    log.push(`${name} start (${leadCount()} leads)`);
    await gate;
    log.push(`${name} end`);
    return { ok: true, name };
  };
  return { fn, release };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  setSyncForTests(null);
  deleteDb();
});

test("a reset waits for a running sync to finish before deleting anything", async () => {
  seedLead();
  const log = [];
  const first = heldSync(log, "sync");
  setSyncForTests(first.fn);
  const sync = runSync();
  await tick();

  const second = heldSync(log, "reset sync");
  const reset = runReset();
  setSyncForTests(second.fn);
  await tick();
  assert.equal(leadCount(), 1, "the cache must survive until the running sync ends");
  assert.deepEqual(log, ["sync start (1 leads)"]);

  first.release();
  await sync;
  await tick();
  second.release();
  assert.deepEqual(await reset, { ok: true, name: "reset sync" });
  assert.deepEqual(log, ["sync start (1 leads)", "sync end", "reset sync start (0 leads)", "reset sync end"]);
});

test("a sync asked for during a reset shares it instead of running again", async () => {
  seedLead();
  const log = [];
  const held = heldSync(log, "reset sync");
  setSyncForTests(held.fn);
  const reset = runReset();
  await tick();
  const sync = runSync();
  held.release();
  assert.deepEqual(await sync, await reset);
  assert.deepEqual(log, ["reset sync start (0 leads)", "reset sync end"]);
});

test("a dashboard edit made during a reset waits for it to finish", async () => {
  seedLead();
  const log = [];
  const held = heldSync(log, "reset sync");
  setSyncForTests(held.fn);
  const reset = runReset();
  await tick();
  const edit = withSheetLock(async () => log.push("edit"));
  await tick();
  assert.deepEqual(log, ["reset sync start (0 leads)"]);
  held.release();
  await Promise.all([reset, edit]);
  assert.deepEqual(log, ["reset sync start (0 leads)", "reset sync end", "edit"]);
});

test("a reset waits for a dashboard edit in progress before deleting anything", async () => {
  seedLead();
  const log = [];
  let release;
  const edit = withSheetLock(async () => {
    await new Promise((r) => (release = r));
    log.push(`edit end (${leadCount()} leads)`);
  });
  await tick();
  setSyncForTests(async () => log.push(`reset sync (${leadCount()} leads)`));
  const reset = runReset();
  await tick();
  const countDuringEdit = leadCount();
  release(); // before asserting, so a failure can't leave the lock held
  await Promise.all([edit, reset]);
  assert.equal(countDuringEdit, 1, "the cache must survive until the edit ends");
  assert.deepEqual(log, ["edit end (1 leads)", "reset sync (0 leads)"]);
});

test("a sync asked for during a reset that waited on an earlier sync still shares the reset", async () => {
  const log = [];
  const first = heldSync(log, "sync");
  setSyncForTests(first.fn);
  const sync = runSync();
  await tick();
  const second = heldSync(log, "reset sync");
  const reset = runReset();
  setSyncForTests(second.fn);
  first.release();
  await sync;
  await tick();
  // The earlier sync's cleanup mustn't have cleared the reset's place.
  const during = runSync();
  second.release();
  assert.deepEqual(await during, await reset);
  assert.deepEqual(log, ["sync start (0 leads)", "sync end", "reset sync start (0 leads)", "reset sync end"]);
});

test("after a failed reset, the next sync still runs", async () => {
  setSyncForTests(async () => {
    throw new Error("Google sign-in for work has expired");
  });
  await assert.rejects(runReset(), /expired/);
  setSyncForTests(async () => ({ ok: true }));
  assert.deepEqual(await runSync(), { ok: true });
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
