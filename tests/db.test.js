import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB_PATH is read when db.js loads, so point it at a temp file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-db-"));
process.env.LEADS_DB = path.join(dir, "leads.db");
const { DB_PATH, dbVersion, deleteDb, getDb, init } = await import("../src/db.js");
const { DatabaseSync } = await import("node:sqlite");

test("an older cache sends its 'received' leads back to Gmail for a fresh look", () => {
  const d = new DatabaseSync(":memory:");
  init(d);
  d.exec(`INSERT INTO leads (source_id, tab, email, row_number, last_email_dir, gmail_checked) VALUES
    ('s', 't', 'a@x.com', 2, 'received', 1), ('s', 't', 'b@x.com', 3, NULL, 1)`);
  d.exec("PRAGMA user_version = 2");
  init(d);
  const rows = d.prepare("SELECT email, gmail_checked FROM leads ORDER BY email").all();
  assert.deepEqual(rows.map((r) => [r.email, r.gmail_checked]), [["a@x.com", 0], ["b@x.com", 1]], "kept, and only 'received' rechecked");
  d.prepare("UPDATE leads SET gmail_checked = 1").run();
  init(d);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM leads WHERE gmail_checked = 0").get().n, 0, "runs once");
  d.close();
});

test("a cache from before follow-ups were counted recounts every lead you emailed last", () => {
  const d = new DatabaseSync(":memory:");
  init(d);
  d.exec("ALTER TABLE leads DROP COLUMN sent_streak");
  d.exec(`INSERT INTO leads (source_id, tab, email, row_number, last_email_dir, gmail_checked) VALUES
    ('s', 't', 'a@x.com', 2, 'received', 1), ('s', 't', 'b@x.com', 3, 'sent', 1), ('s', 't', 'c@x.com', 4, 'bounced', 1), ('s', 't', 'd@x.com', 5, NULL, 1)`);
  d.exec("PRAGMA user_version = 3");
  init(d);
  const rows = d.prepare("SELECT email, gmail_checked, sent_streak FROM leads ORDER BY email").all();
  assert.deepEqual(rows.map((r) => [r.email, r.gmail_checked, r.sent_streak]), [["a@x.com", 1, null], ["b@x.com", 0, null], ["c@x.com", 0, null], ["d@x.com", 1, null]]);
  assert.equal(d.prepare("PRAGMA user_version").get().user_version, 4);
  d.prepare("UPDATE leads SET gmail_checked = 1").run();
  init(d);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM leads WHERE gmail_checked = 0").get().n, 0, "runs once");
  d.close();
});

test("deleteDb removes the cache files and the next getDb starts empty", () => {
  getDb().prepare("INSERT INTO leads (source_id, tab, email, row_number) VALUES ('s', 'Leads', 'a@example.com', 2)").run();
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM leads").get().n, 1);
  assert.ok(fs.existsSync(DB_PATH));

  deleteDb();
  for (const suffix of ["", "-wal", "-shm"]) assert.equal(fs.existsSync(`${DB_PATH}${suffix}`), false);

  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM leads").get().n, 0);
  deleteDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dbVersion moves on every write, from this connection or another, and never repeats after a reset", () => {
  const v1 = dbVersion();
  getDb().prepare("SELECT COUNT(*) FROM leads").get();
  assert.equal(dbVersion(), v1, "reads don't change it");
  getDb().prepare("INSERT INTO tab_state (source_id, tab, ok) VALUES ('s', 'v', 1)").run();
  const v2 = dbVersion();
  assert.notEqual(v2, v1, "a write on this connection");
  const other = new DatabaseSync(DB_PATH);
  other.prepare("DELETE FROM tab_state WHERE tab = 'v'").run();
  other.close();
  const v3 = dbVersion();
  assert.notEqual(v3, v2, "a write from another connection");
  deleteDb();
  assert.ok(![v1, v2, v3].includes(dbVersion()), "a fresh database after a reset");
});
