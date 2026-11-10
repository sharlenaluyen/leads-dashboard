import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./config.js";

// SQLite is a cache of the spreadsheets plus Gmail bookmarks. Everything in it
// can be rebuilt by deleting data/leads.db and syncing (npm run rebuild).
// The dashboard shows only the sheet_* / sheet-read columns; the Gmail
// columns are what sync writes into the sheet.
export const DB_PATH = process.env.LEADS_DB || path.join(ROOT, "data", "leads.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id               INTEGER PRIMARY KEY,
  source_id        TEXT NOT NULL,
  tab              TEXT NOT NULL,
  email            TEXT NOT NULL,          -- lowercased; identity within a tab (the cell's first address)
  all_emails       TEXT,                   -- every address in the email cell, comma-separated
  row_number       INTEGER NOT NULL,       -- 1-based sheet row, refreshed each sync
  business_name    TEXT,
  priority         INTEGER,
  follow_up_status TEXT,
  notes            TEXT,
  draft_id         TEXT,
  sheet_last_email    TEXT,                -- the sheet's email columns as last read/written
  sheet_last_dir      TEXT,
  sheet_last_followed TEXT,
  row_hash         TEXT,
  -- Gmail state (the truth for the email columns)
  last_email_at       INTEGER,             -- ms epoch, newest message either way
  last_email_dir      TEXT,                -- 'sent' | 'received' | 'bounced'
  last_followed_up_at INTEGER,             -- ms epoch, newest message you sent
  last_message_id     TEXT,                -- Gmail id of the newest message
  last_sent_id        TEXT,                -- Gmail id of the newest message you sent
  thread_id           TEXT,                -- thread of the newest message
  gmail_draft_id      TEXT,                -- newest Gmail draft for this lead
  gmail_checked       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, tab, email)
);
CREATE INDEX IF NOT EXISTS leads_source ON leads (source_id);
CREATE INDEX IF NOT EXISTS leads_email ON leads (email);

-- Every Gmail thread a lead is in, so replies from anyone in it count.
CREATE TABLE IF NOT EXISTS lead_threads (
  lead_id    INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL,
  PRIMARY KEY (lead_id, thread_id)
);
CREATE INDEX IF NOT EXISTS lead_threads_thread ON lead_threads (thread_id);

-- Headers of each account's current drafts, so a draft is only fetched once.
CREATE TABLE IF NOT EXISTS draft_meta (
  account     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  thread_id   TEXT,
  at          INTEGER,
  addresses   TEXT,                        -- JSON array
  PRIMARY KEY (account, message_id)
);

-- People in your mail since this was switched on who aren't in any sheet,
-- waiting for you to add them to a tab or dismiss them.
CREATE TABLE IF NOT EXISTS new_contacts (
  account     TEXT NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  first_at    INTEGER,
  last_at     INTEGER,
  last_dir    TEXT,                        -- 'sent' | 'received'
  thread_id   TEXT,
  count       INTEGER NOT NULL DEFAULT 0,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, email)
);

-- Leads with a new reply whose reopen (Closed -> Pending action) hasn't
-- reached the sheet yet. Saved with the Gmail bookmark, since Gmail reports
-- a reply only once; cleared after the sheet write, or when you change the
-- row's status yourself first.
CREATE TABLE IF NOT EXISTS pending_reopen (
  lead_id     INTEGER PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  at          INTEGER NOT NULL             -- when the reply was found
);

-- One Gmail history bookmark per account alias.
CREATE TABLE IF NOT EXISTS gmail_cursor (
  account     TEXT PRIMARY KEY,
  history_id  TEXT NOT NULL,
  synced_at   INTEGER NOT NULL
);

-- Per-tab header problems from the last sync, shown in the UI.
CREATE TABLE IF NOT EXISTS tab_state (
  source_id   TEXT NOT NULL,
  tab         TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  problem     TEXT,
  row_count   INTEGER,
  PRIMARY KEY (source_id, tab)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  api_calls   INTEGER,
  summary     TEXT                         -- JSON
);
`;

// Bump when the tables above change shape. An older cache is dropped and the
// next sync refills it from the sheets and Gmail.
const SCHEMA_VERSION = 2;
// Bump for one-off fixes to cached data that keep the layout (see init).
const DB_VERSION = 3;

// Exported for tests.
export function init(d) {
  d.exec("PRAGMA foreign_keys = ON;");
  const version = d.prepare("PRAGMA user_version").get().user_version;
  if (version < SCHEMA_VERSION) {
    d.exec(`DROP TABLE IF EXISTS lead_threads; DROP TABLE IF EXISTS draft_meta; DROP TABLE IF EXISTS leads;
      DROP TABLE IF EXISTS gmail_cursor; DROP TABLE IF EXISTS tab_state;`);
  }
  d.exec(SCHEMA);
  // Columns added after a layout version, filled in by the next sync.
  const have = new Set(d.prepare("PRAGMA table_info(leads)").all().map((c) => c.name));
  if (!have.has("all_emails")) d.exec("ALTER TABLE leads ADD COLUMN all_emails TEXT");
  // Bounces and out-of-office replies used to count as replies: the next
  // sync looks up every lead marked "received" again.
  if (version < 3) d.exec("UPDATE leads SET gmail_checked = 0 WHERE last_email_dir = 'received'");
  if (version < DB_VERSION) d.exec(`PRAGMA user_version = ${DB_VERSION}`);
}

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  init(db);
  return db;
}

// Throws the cache away: closes the open handle and deletes the file and its
// WAL/SHM companions. The next getDb() starts an empty database. Callers must
// hold the sheet lock so nothing is mid-query (see runReset in sync.js).
export function deleteDb() {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
}

// For tests: an in-memory database with the same schema.
export function openMemoryDb() {
  db = new DatabaseSync(":memory:");
  init(db);
  return db;
}

export function transaction(fn) {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const result = fn(d);
    d.exec("COMMIT");
    return result;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
