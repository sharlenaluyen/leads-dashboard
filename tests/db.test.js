import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB_PATH is read when db.js loads, so point it at a temp file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-db-"));
process.env.LEADS_DB = path.join(dir, "leads.db");
const { DB_PATH, deleteDb, getDb, init } = await import("../src/db.js");
const { DatabaseSync } = await import("node:sqlite");

test("an older cache sends its 'received' leads back to Gmail for a fresh look", () => {
  const d = new DatabaseSync(":memory:");
  init(d);
  d.exec(`INSERT INTO leads (source_id, tab, email, row_number, last_email_dir, gmail_checked) VALUES
    ('s', 't', 'a@x.com', 2, 'received', 1), ('s', 't', 'b@x.com', 3, 'sent', 1)`);
  d.exec("PRAGMA user_version = 2");
  init(d);
  const rows = d.prepare("SELECT email, gmail_checked FROM leads ORDER BY email").all();
  assert.deepEqual(rows.map((r) => [r.email, r.gmail_checked]), [["a@x.com", 0], ["b@x.com", 1]], "kept, and only 'received' rechecked");
  assert.equal(d.prepare("PRAGMA user_version").get().user_version, 3);
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
