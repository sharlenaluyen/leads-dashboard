import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB_PATH is read when db.js loads, so point it at a temp file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-db-"));
process.env.LEADS_DB = path.join(dir, "leads.db");
const { DB_PATH, deleteDb, getDb } = await import("../src/db.js");

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
