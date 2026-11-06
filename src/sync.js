import { extractEmailAddress } from "multi-gmail-mcp/src/gmail.js";
import { addCustomStatuses, loadSettings, loadSources, statusesFor } from "./config.js";
import { getDb, transaction } from "./db.js";
import { CallCounter, audit, explainGoogleError, gmailClientFor, getAccountInfo, sheetsClientFor } from "./google.js";
import { syncAccount } from "./gmailSync.js";
import { logChanges, markFailed } from "./changes.js";
import { withSheetLock } from "./lock.js";
import { cellRange, emailsIn, formatDate, listTabs, parsePriority, parseSheetDate, parseTab, readTabs, rowHash, writeCells } from "./sheets.js";

const LEAD_FIELDS = [
  "last_email_at",
  "last_email_dir",
  "last_followed_up_at",
  "last_message_id",
  "last_sent_id",
  "thread_id",
  "gmail_draft_id",
  "gmail_checked",
];

// Sheet column (parseTab key) -> the leads column caching what the sheet holds.
const SHEET_COLUMNS = {
  lastEmail: "sheet_last_email",
  lastEmailDir: "sheet_last_dir",
  lastFollowedUp: "sheet_last_followed",
  draftId: "draft_id",
  followUpStatus: "follow_up_status",
  priority: "priority",
};

// Statuses sync manages from Gmail. Anything else (Closed…, Confirmed, custom
// statuses) was set by you and is left alone, except that a new reply
// reopens a Closed one.
const AUTO_STATUSES = ["", "open", "pending action", "awaiting reply", "contacted elsewhere"];
const isClosed = (status) => /^closed\b/i.test(String(status || "").trim());

// Statuses typed straight into the sheet that aren't known yet become custom
// statuses for that source, so they show up in the dashboard's dropdown.
// Known ones are returned in their canonical spelling. New ones are collected
// in `added` and saved by the caller once its SQLite transaction commits, so
// a rollback never leaves sources.json changed.
function canonicalStatus(source, value, added) {
  if (!value) return "";
  const known = statusesFor(source).find((s) => s.toLowerCase() === value.toLowerCase());
  if (known) return known;
  source.customStatuses = [...(source.customStatuses || []), value];
  added.push(value);
  return value;
}

// Free mail providers: sharing one with the account doesn't make someone a
// coworker.
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
]);
const domainOf = (email) => String(email).split("@")[1] || "";

// The account's own company domains (from its address and default_from),
// leaving out free mail providers.
export function ownDomainsOf(self) {
  return new Set([...self].map(domainOf).filter((d) => d && !PUBLIC_DOMAINS.has(d)));
}

// Google's answer for a range it can't find, e.g. "Unable to parse range: 'Old name'".
const isBadRange = (err) => (err?.code === 400 || err?.response?.status === 400) && /parse range/i.test(explainGoogleError(err));

// Sheet -> SQLite for one source. Returns the parsed rows keyed by lead id,
// which write-back compares against.
async function syncSourceSheet(source, counter, summary) {
  const db = getDb();
  const sheets = sheetsClientFor(source.account);
  // A tab renamed or deleted in Sheets fails the whole read. Find which, say
  // so for that tab, and read the rest.
  const lost = new Map();
  let values;
  try {
    values = await readTabs(sheets, source.spreadsheetId, source.tabs, counter);
  } catch (err) {
    if (!isBadRange(err)) throw err;
    const titles = new Set((await listTabs(sheets, source.spreadsheetId, counter)).tabs.map((t) => t.title));
    const gone = source.tabs.filter((t) => !titles.has(t));
    if (!gone.length) throw err;
    const google = explainGoogleError(err, source.account);
    for (const tab of gone) lost.set(tab, `Tab not found in the spreadsheet (renamed or deleted?). Google said: ${google}`);
    const readable = source.tabs.filter((t) => titles.has(t));
    values = readable.length ? await readTabs(sheets, source.spreadsheetId, readable, counter) : {};
  }
  const sheetRows = new Map();
  const newStatuses = [];

  const select = db.prepare("SELECT id, row_hash, all_emails, follow_up_status FROM leads WHERE source_id = ? AND tab = ? AND email = ?");
  const insert = db.prepare(`INSERT INTO leads
    (source_id, tab, email, row_number, business_name, priority, follow_up_status, notes, draft_id,
     sheet_last_email, sheet_last_dir, sheet_last_followed, all_emails, row_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE leads SET row_number = ?, business_name = ?, priority = ?,
    follow_up_status = ?, notes = ?, draft_id = ?, sheet_last_email = ?, sheet_last_dir = ?,
    sheet_last_followed = ?, all_emails = ?, row_hash = ? WHERE id = ?`);
  // Addresses typed into a row's email cell: look the row up in Gmail again
  // so their mail counts too.
  const recheck = db.prepare("UPDATE leads SET gmail_checked = 0 WHERE id = ?");
  // You changed the status yourself since a reply was recorded: that wins
  // over reopening the row for it.
  const dropReopen = db.prepare("DELETE FROM pending_reopen WHERE lead_id = ?");
  const remove = db.prepare("DELETE FROM leads WHERE id = ?");
  const upsertTab = db.prepare(`INSERT INTO tab_state (source_id, tab, ok, problem, row_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source_id, tab) DO UPDATE SET ok = excluded.ok, problem = excluded.problem, row_count = excluded.row_count`);

  transaction(() => {
    for (const tab of source.tabs) {
      // Its rows stay cached as they were, and nothing is written to them.
      if (lost.has(tab)) {
        upsertTab.run(source.id, tab, 0, lost.get(tab), 0);
        summary.problems.push(`${source.name} / ${tab}: ${lost.get(tab)}`);
        continue;
      }
      const parsed = parseTab(values[tab] || []);
      if (!parsed.ok) {
        upsertTab.run(source.id, tab, 0, parsed.problem, 0);
        summary.problems.push(`${source.name} / ${tab}: ${parsed.problem}`);
        continue;
      }
      const notes = [];
      if (parsed.skipped) notes.push(`${parsed.skipped} row(s) without a valid email skipped`);
      if (parsed.duplicates.length) notes.push(`duplicate emails ignored: ${parsed.duplicates.join(", ")}`);
      upsertTab.run(source.id, tab, 1, notes.join("; ") || null, parsed.rows.length);

      const keep = new Set();
      for (const row of parsed.rows) {
        const status = canonicalStatus(source, row.followUpStatus, newStatuses);
        const allEmails = row.emails.join(",");
        const fields = [row.rowNumber, row.businessName, row.priority, status, row.notes, row.draftId, row.lastEmail, row.lastEmailDir, row.lastFollowedUp, allEmails];
        const existing = select.get(source.id, tab, row.email);
        let id;
        if (!existing) {
          id = Number(insert.run(source.id, tab, row.email, ...fields, row.hash).lastInsertRowid);
          summary.sheetRowsChanged++;
        } else {
          id = existing.id;
          if (existing.row_hash !== row.hash) {
            update.run(...fields, row.hash, id);
            if (existing.all_emails != null && existing.all_emails !== allEmails) recheck.run(id);
            if ((existing.follow_up_status || "") !== status) dropReopen.run(id);
            summary.sheetRowsChanged++;
          }
        }
        keep.add(id);
        sheetRows.set(id, { ...row, tab, columns: parsed.columns });
      }
      // Rows deleted from the sheet (or whose email changed) leave the cache.
      const ids = db.prepare("SELECT id FROM leads WHERE source_id = ? AND tab = ?").all(source.id, tab);
      for (const { id } of ids) {
        if (!keep.has(id)) {
          remove.run(id);
          summary.sheetRowsChanged++;
        }
      }
    }
    // Tabs removed from the source's list.
    const placeholders = source.tabs.map(() => "?").join(",") || "''";
    db.prepare(`DELETE FROM leads WHERE source_id = ? AND tab NOT IN (${placeholders})`).run(source.id, ...source.tabs);
    db.prepare(`DELETE FROM tab_state WHERE source_id = ? AND tab NOT IN (${placeholders})`).run(source.id, ...source.tabs);
  });
  addCustomStatuses(source.id, newStatuses);
  return sheetRows;
}

// Gmail -> SQLite for one account. Returns the people to add to a lead's
// email cell because they replied in its thread. Leads with a new reply go
// in pending_reopen, saved together with the Gmail bookmark.
async function syncGmail(alias, counter, summary) {
  const db = getDb();
  const sources = loadSources().filter((s) => getAccountInfo(s.account).alias === alias);
  const out = { adds: [] };
  if (!sources.length) return out;
  const placeholders = sources.map(() => "?").join(",");
  const leads = db.prepare(`SELECT * FROM leads WHERE source_id IN (${placeholders})`).all(...sources.map((s) => s.id));
  const threads = new Map();
  const threadRows = db
    .prepare(`SELECT t.lead_id, t.thread_id FROM lead_threads t JOIN leads l ON l.id = t.lead_id WHERE l.source_id IN (${placeholders})`)
    .all(...sources.map((s) => s.id));
  for (const { lead_id, thread_id } of threadRows) {
    if (!threads.has(lead_id)) threads.set(lead_id, new Set());
    threads.get(lead_id).add(thread_id);
  }
  const draftMeta = new Map(
    db
      .prepare("SELECT * FROM draft_meta WHERE account = ?")
      .all(alias)
      .map((d) => [d.message_id, { threadId: d.thread_id, at: d.at, addresses: JSON.parse(d.addresses || "[]") }])
  );
  const cursor = db.prepare("SELECT * FROM gmail_cursor WHERE account = ?").get(alias);
  const info = getAccountInfo(alias);
  const self = new Set([info.email, info.default_from].filter(Boolean).map(extractEmailAddress));

  const result = await syncAccount(gmailClientFor(alias), { leads, threads, cursor, draftMeta, self }, counter);

  transaction(() => {
    const addThread = db.prepare("INSERT OR IGNORE INTO lead_threads (lead_id, thread_id) VALUES (?, ?)");
    for (const [id, change] of result.changes) {
      const fields = LEAD_FIELDS.filter((f) => f in change);
      if (fields.length) {
        db.prepare(`UPDATE leads SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...fields.map((f) => change[f]), id);
      }
      if (change.replaceThreads) db.prepare("DELETE FROM lead_threads WHERE lead_id = ?").run(id);
      for (const t of change.threads || []) if (t) addThread.run(id, t);
    }
    if (result.draftMeta) {
      db.prepare("DELETE FROM draft_meta WHERE account = ?").run(alias);
      const put = db.prepare("INSERT INTO draft_meta (account, message_id, thread_id, at, addresses) VALUES (?, ?, ?, ?, ?)");
      for (const [messageId, d] of result.draftMeta) put.run(alias, messageId, d.threadId, d.at, JSON.stringify(d.addresses));
    }
    // New contacts: anyone already in any sheet (any account) is left out.
    const inSheets = db.prepare("SELECT 1 FROM leads WHERE email = ? OR (',' || all_emails || ',') LIKE ('%,' || ? || ',%') LIMIT 1");
    const putContact = db.prepare(`INSERT INTO new_contacts (account, email, name, first_at, last_at, last_dir, thread_id, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, email) DO UPDATE SET
        name = COALESCE(NULLIF(new_contacts.name, ''), excluded.name),
        first_at = MIN(new_contacts.first_at, excluded.first_at),
        last_dir = CASE WHEN excluded.last_at > new_contacts.last_at THEN excluded.last_dir ELSE new_contacts.last_dir END,
        thread_id = CASE WHEN excluded.last_at > new_contacts.last_at THEN excluded.thread_id ELSE new_contacts.thread_id END,
        last_at = MAX(new_contacts.last_at, excluded.last_at),
        count = new_contacts.count + excluded.count`);
    // Someone who replied in a lead's thread is added to that lead's email
    // cell (when writing is on); everyone else waits in the review list.
    // Coworkers (your own company's domain) are never auto-added: they'd
    // end up on the lead's drafts.
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const autoAdd = loadSettings().writeBack;
    const ownDomains = ownDomainsOf(self);
    for (const c of result.contacts.values()) {
      if (inSheets.get(c.email, c.email)) continue;
      if (autoAdd && leadById.has(c.viaLead) && !ownDomains.has(domainOf(c.email))) {
        out.adds.push({ contact: c, lead: leadById.get(c.viaLead) });
        continue;
      }
      putContact.run(alias, c.email, c.name, c.firstAt, c.lastAt, c.lastDir, c.threadId, c.count);
      summary.newContacts++;
    }
    // In the same transaction as the bookmark: once the bookmark moves past
    // a reply, Gmail won't report it again, so the reopen it calls for has
    // to be saved first. Cleared once the sheet has been written.
    const putReopen = db.prepare("INSERT OR IGNORE INTO pending_reopen (lead_id, at) VALUES (?, ?)");
    for (const id of result.replies) putReopen.run(id, result.cursor.synced_at);
    db.prepare(`INSERT INTO gmail_cursor (account, history_id, synced_at) VALUES (?, ?, ?)
      ON CONFLICT (account) DO UPDATE SET history_id = excluded.history_id, synced_at = excluded.synced_at`).run(
      alias,
      result.cursor.history_id,
      result.cursor.synced_at
    );
  });
  const quiet = new Set(["gmail_checked", "threads", "replaceThreads"]);
  summary.gmailLeadsChanged += [...result.changes.values()].filter((c) => Object.keys(c).some((k) => !quiet.has(k))).length;
  return out;
}

// Puts people in the review list (used when adding them to a sheet failed,
// so they aren't lost: Gmail only reports them once).
function queueForReview(adds, alias) {
  const put = getDb().prepare(`INSERT OR IGNORE INTO new_contacts (account, email, name, first_at, last_at, last_dir, thread_id, count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const { contact: c } of adds) put.run(alias, c.email, c.name, c.firstAt, c.lastAt, c.lastDir, c.threadId, c.count);
}

const DATE_KEYS = new Set(["lastEmail", "lastFollowedUp"]);

// The follow-up status Gmail implies, or null to leave the current one alone.
//   elsewhere: the sheet shows outreach Gmail has no trace of
//   reopen:    a new reply arrived, so a Closed status gives way
export function autoStatus(lead, current, { elsewhere = false, reopen = false } = {}) {
  const now = String(current || "").trim().toLowerCase();
  if (!AUTO_STATUSES.includes(now) && !(reopen && isClosed(now))) return null;
  if (elsewhere) return "Contacted elsewhere";
  if (lead.gmail_draft_id || lead.last_email_dir === "received") return "Pending action";
  if (lead.last_email_dir === "sent") return "Awaiting Reply";
  return "Open";
}

// A sheet row's current text for one column (priority keeps its raw text).
const sheetValue = (row, key) => String((key === "priority" ? row.priorityRaw : key === "email" ? row.emailCell : row[key]) ?? "");

// The Gmail-owned cells whose sheet value differs from what Gmail says.
//   newReply: this lead got a new reply this sync (reopens a Closed row)
export function pendingWrites(lead, sheetRow, { newReply = false } = {}) {
  if (!lead.gmail_checked) return [];
  // The sheet shows a date but Gmail has no email with them at all: the
  // outreach happened somewhere else. Keep the sheet's dates.
  const gmailHasMail = lead.last_email_at != null || lead.last_followed_up_at != null;
  const elsewhere = !gmailHasMail && Boolean(sheetRow.lastEmail || sheetRow.lastFollowedUp);
  const want = elsewhere
    ? {}
    : {
        lastEmail: formatDate(lead.last_email_at),
        lastEmailDir: lead.last_email_dir || "",
        lastFollowedUp: formatDate(lead.last_followed_up_at),
      };
  want.draftId = lead.gmail_draft_id || "";
  const reopen = newReply && isClosed(sheetRow.followUpStatus);
  const status = autoStatus(lead, sheetRow.followUpStatus, { elsewhere, reopen });
  if (status !== null) want.followUpStatus = status;
  // Priority 0 means "closed out"; a reopened row shouldn't keep it.
  if (reopen && sheetValue(sheetRow, "priority") === "0") want.priority = "";
  // Dates are compared as dates, so 10/28/2026 and 2026-10-28 match.
  const same = (key, value) => {
    const now = sheetValue(sheetRow, key);
    if (DATE_KEYS.has(key)) return now === value || (Boolean(now) && parseSheetDate(now) === parseSheetDate(value));
    if (key === "followUpStatus") return now.toLowerCase() === value.toLowerCase();
    return now === value;
  };
  return Object.entries(want)
    .filter(([key, value]) => !same(key, value))
    .map(([key, value]) => ({
      leadId: lead.id,
      key,
      range: cellRange(sheetRow.tab, sheetRow.columns[key], sheetRow.rowNumber),
      value,
      ...(DATE_KEYS.has(key) ? { date: true } : {}),
    }));
}

// Each lead's email cell with the new people from its thread added after the
// addresses already there: "jane@acme.com" -> "jane@acme.com, bob@acme.com".
export function addressWrites(adds, sheetRows) {
  const byLead = new Map();
  for (const a of adds) {
    if (!sheetRows.has(a.lead.id)) continue;
    if (!byLead.has(a.lead.id)) byLead.set(a.lead.id, []);
    byLead.get(a.lead.id).push(a.contact.email);
  }
  return [...byLead].map(([leadId, emails]) => {
    const row = sheetRows.get(leadId);
    const fresh = emails.filter((e) => !row.emails.includes(e));
    return {
      leadId,
      key: "email",
      range: cellRange(row.tab, row.columns.email, row.rowNumber),
      value: [String(row.emailCell || row.email).trim(), ...fresh].join(", "),
      added: fresh,
    };
  }).filter((w) => w.added.length);
}

// Splits updates into those whose row is still where this sync read it and
// those whose row moved since (sorted, inserted above, deleted, email
// changed) or whose tab's columns moved. `fresh` is each tab's values as
// re-read just before writing. Same check a dashboard edit makes, for every
// row at once. An email-cell write also needs the cell unchanged, since it
// rewrites the whole cell.
export function confirmRows(updates, sheetRows, fresh) {
  const tabs = new Map();
  const tabNow = (tab) => {
    if (!tabs.has(tab)) {
      const parsed = parseTab(fresh[tab] || []);
      tabs.set(tab, parsed.ok ? { parsed, byRow: new Map(parsed.rows.map((r) => [r.rowNumber, r])) } : null);
    }
    return tabs.get(tab);
  };
  const ok = [];
  const moved = new Set();
  for (const u of updates) {
    const row = sheetRows.get(u.leadId);
    const now = tabNow(row.tab);
    const same =
      now &&
      now.parsed.columns.email === row.columns.email &&
      now.parsed.columns[u.key] === row.columns[u.key] &&
      now.byRow.get(row.rowNumber)?.email === row.email &&
      (u.key !== "email" || now.byRow.get(row.rowNumber).emailCell === String(row.emailCell || row.email).trim());
    if (same) ok.push(u);
    else moved.add(u.leadId);
  }
  // A lead is written all or nothing.
  return { ok: ok.filter((u) => !moved.has(u.leadId)), moved };
}

// Gmail -> sheet, then the sheet's answer -> the cache the dashboard reads.
// All of a spreadsheet's changes go in one write call.
async function writeBack(source, sheetRows, counter, summary, { adds = [] } = {}) {
  const db = getDb();
  const leads = db.prepare("SELECT * FROM leads WHERE source_id = ?").all(source.id);
  // Replies from this sync or an earlier one whose write didn't happen.
  const replies = new Set(
    db.prepare("SELECT p.lead_id FROM pending_reopen p JOIN leads l ON l.id = p.lead_id WHERE l.source_id = ?").all(source.id).map((r) => r.lead_id)
  );
  const gmailWrites = leads.flatMap((lead) =>
    sheetRows.has(lead.id) ? pendingWrites(lead, sheetRows.get(lead.id), { newReply: replies.has(lead.id) }) : []
  );
  // A lead whose tab couldn't be read this sync: its new people wait in the
  // review list instead.
  const alias = getAccountInfo(source.account).alias;
  queueForReview(adds.filter((a) => !sheetRows.has(a.lead.id)), alias);
  const planned = [...gmailWrites, ...addressWrites(adds, sheetRows)];
  if (!loadSettings().writeBack) {
    summary.writesHeld += planned.length;
    return;
  }
  // Writes go by row number, so re-read the tabs being written and drop any
  // row that moved since the read above (e.g. the sheet was sorted mid-sync).
  // Their Gmail columns are written by the next sync; their new people wait
  // in the review list.
  const sheets = sheetsClientFor(source.account);
  let updates = planned;
  let moved = new Set();
  if (planned.length) {
    let fresh;
    try {
      fresh = await readTabs(sheets, source.spreadsheetId, [...new Set(planned.map((u) => sheetRows.get(u.leadId).tab))], counter);
    } catch (err) {
      queueForReview(adds, alias);
      throw err;
    }
    ({ ok: updates, moved } = confirmRows(planned, sheetRows, fresh));
    if (moved.size) {
      queueForReview(adds.filter((a) => moved.has(a.lead.id)), alias);
      summary.problems.push(
        `${source.name}: ${moved.size} row(s) moved in the spreadsheet during the sync and weren't written; the next sync updates them.`
      );
    }
  }
  // Logged before writing, so no written cell ever goes unlogged.
  const logged = logChanges(
    updates.map((u) => {
      const row = sheetRows.get(u.leadId);
      return {
        by: "sync",
        syncId: summary.syncId,
        source: source.id,
        spreadsheetId: source.spreadsheetId,
        tab: row.tab,
        row: row.rowNumber,
        email: row.email,
        key: u.key,
        old: sheetValue(row, u.key),
        new: u.value,
      };
    })
  );
  let now;
  try {
    now = await writeCells(sheets, source.spreadsheetId, updates, counter);
  } catch (err) {
    markFailed(logged, err);
    queueForReview(adds, alias);
    throw err;
  }
  summary.cellsWritten += now.length;
  summary.addressesAdded += updates.reduce((n, u) => n + (u.added?.length || 0), 0);
  if (now.length) {
    audit({
      action: "sheet_sync_write",
      account: source.account,
      email: getAccountInfo(source.account).email,
      outcome: "updated",
      detail: { spreadsheet: source.spreadsheetId, cells: now.length, sync: summary.syncId, log: "data/sheet-changes.jsonl" },
    });
  }

  const newStatuses = [];
  transaction(() => {
    const touched = new Set();
    updates.forEach((u, i) => {
      const row = sheetRows.get(u.leadId);
      if (u.key === "email") {
        // The row keeps its identity (the first address); Gmail state is
        // already current, since the new address came from its thread.
        row.emailCell = now[i];
        row.emails = emailsIn(now[i]);
        db.prepare("UPDATE leads SET all_emails = ? WHERE id = ?").run(row.emails.join(","), u.leadId);
        touched.add(u.leadId);
        return;
      }
      let value = u.key === "followUpStatus" ? canonicalStatus(source, now[i], newStatuses) : now[i];
      if (u.key === "priority") {
        row.priorityRaw = now[i];
        row.priority = value = parsePriority(now[i]);
      } else {
        row[u.key] = value;
      }
      db.prepare(`UPDATE leads SET ${SHEET_COLUMNS[u.key]} = ? WHERE id = ?`).run(value, u.leadId);
      touched.add(u.leadId);
    });
    // The rows now read as written, so the next sync doesn't count them as
    // changed in the sheet.
    const rehash = db.prepare("UPDATE leads SET row_hash = ? WHERE id = ?");
    for (const id of touched) rehash.run(rowHash(sheetRows.get(id)), id);
    // Every row read this sync has now had its reopen applied (or didn't
    // need one); rows in tabs that couldn't be read, and rows that moved
    // before the write, keep theirs for later.
    const done = db.prepare("DELETE FROM pending_reopen WHERE lead_id = ?");
    for (const id of replies) if (sheetRows.has(id) && !moved.has(id)) done.run(id);
  });
  addCustomStatuses(source.id, newStatuses);
}

let running = null;

// Sheets (who the leads are) -> Gmail (what happened) -> sheets (the email
// columns and auto statuses) -> the dashboard, which shows only what the
// sheet holds. Concurrent calls share one run, and it waits for (and holds
// off) any other spreadsheet write; see lock.js.
export function runSync() {
  if (!running) running = withSheetLock(doSync).finally(() => (running = null));
  return running;
}

// A sync that's guaranteed to see a change just made to a sheet: one already
// running may have read the sheet before the change, so wait it out first.
export async function syncAfterChange() {
  if (running) await running.catch(() => {});
  return runSync();
}

async function doSync() {
  const db = getDb();
  const counter = new CallCounter();
  const startedAt = Date.now();
  const logId = Number(db.prepare("INSERT INTO sync_log (started_at) VALUES (?)").run(startedAt).lastInsertRowid);
  const summary = {
    syncId: logId,
    newContacts: 0,
    addressesAdded: 0,
    sheetRowsChanged: 0,
    gmailLeadsChanged: 0,
    cellsWritten: 0,
    writesHeld: 0,
    problems: [],
    errors: [],
  };

  const sources = loadSources();
  const sheetRowsBySource = new Map();
  for (const source of sources) {
    try {
      sheetRowsBySource.set(source.id, await syncSourceSheet(source, counter, summary));
    } catch (err) {
      summary.errors.push(`${source.name}: ${explainGoogleError(err, source.account)}`);
    }
  }

  // Someone added to a sheet (by you or from the review list) leaves the list.
  const known = db.prepare("SELECT email, all_emails FROM leads").all().flatMap((l) => (l.all_emails ? l.all_emails.split(",") : [l.email]));
  const drop = db.prepare("DELETE FROM new_contacts WHERE email = ?");
  transaction(() => known.forEach((e) => drop.run(e)));

  const aliases = [...new Set(sources.map((s) => getAccountInfo(s.account).alias))];
  const gmailOk = new Set();
  const adds = new Map();
  for (const alias of aliases) {
    try {
      const out = await syncGmail(alias, counter, summary);
      for (const a of out.adds) if (!adds.has(a.contact.email)) adds.set(a.contact.email, a);
      gmailOk.add(alias);
    } catch (err) {
      summary.errors.push(`Gmail (${alias}): ${explainGoogleError(err, alias)}`);
    }
  }

  // A source whose Gmail check failed isn't written: its cells would be
  // compared against stale Gmail state.
  for (const source of sources) {
    const mine = [...adds.values()].filter((a) => a.lead.source_id === source.id);
    if (!sheetRowsBySource.has(source.id) || !gmailOk.has(getAccountInfo(source.account).alias)) {
      queueForReview(mine, getAccountInfo(source.account).alias);
      continue;
    }
    try {
      await writeBack(source, sheetRowsBySource.get(source.id), counter, summary, { adds: mine });
    } catch (err) {
      summary.errors.push(`${source.name} write-back: ${explainGoogleError(err, source.account)}`);
    }
  }

  const finishedAt = Date.now();
  const ok = summary.errors.length === 0;
  db.prepare("UPDATE sync_log SET finished_at = ?, ok = ?, api_calls = ?, summary = ? WHERE id = ?").run(
    finishedAt,
    ok ? 1 : 0,
    counter.count,
    JSON.stringify(summary),
    logId
  );
  return { ok, startedAt, finishedAt, durationMs: finishedAt - startedAt, apiCalls: counter.count, ...summary };
}
