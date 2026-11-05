import { getSource, loadSettings } from "./config.js";
import { getDb } from "./db.js";
import { CallCounter, audit, getAccountInfo, sheetsClientFor } from "./google.js";
import { cellRange, emailsIn, isEmail, locateHeaders, quoteTab, readRange, writeCells } from "./sheets.js";
import { logChanges, markFailed } from "./changes.js";
import { withSheetLock } from "./lock.js";
import { syncAfterChange } from "./sync.js";

// The review list: people in your mail who aren't in any sheet yet.
export function listNewContacts() {
  return getDb()
    .prepare("SELECT account, email, name, first_at AS firstAt, last_at AS lastAt, last_dir AS lastDir, count FROM new_contacts WHERE dismissed = 0 ORDER BY last_at DESC")
    .all();
}

export function dismissContact(account, email) {
  const r = getDb().prepare("UPDATE new_contacts SET dismissed = 1 WHERE account = ? AND email = ?").run(account, String(email).toLowerCase());
  if (!r.changes) throw new Error("That contact isn't in the list any more.");
  return { ok: true };
}

/**
 * Adds one person as a new row at the bottom of a tab: their email and
 * business name only. The sync that follows fills in everything Gmail
 * knows (dates, direction, draft, status), the same as for any new row.
 * Costs one read and one write, plus that sync. The read and write hold the
 * sheet lock, so two adds to the same tab can't pick the same empty row and
 * a running sync finishes first; the lock is let go before the sync.
 */
export async function addContact(input) {
  const { row, address } = await withSheetLock(() => writeContactRow(input));
  getDb().prepare("DELETE FROM new_contacts WHERE email = ?").run(address);
  const sync = await syncAfterChange();
  return { row, sync };
}

async function writeContactRow({ email, sourceId, tab, businessName }) {
  if (!loadSettings().writeBack) throw new Error("Writing to spreadsheets is turned off (Settings → Write to spreadsheets).");
  const address = String(email || "").trim().toLowerCase();
  if (!isEmail(address)) throw new Error("That isn't a valid email address.");
  const source = getSource(sourceId);
  if (!source.tabs.includes(tab)) throw new Error(`"${tab}" isn't one of ${source.name}'s tabs.`);
  const db = getDb();
  if (db.prepare("SELECT 1 FROM leads WHERE source_id = ? AND tab = ? AND email = ?").get(source.id, tab, address)) {
    throw new Error(`${address} is already in "${tab}".`);
  }

  const sheets = sheetsClientFor(source.account);
  const counter = new CallCounter();
  // The whole tab, once: its headers, and where the last row with data is.
  // Writing just below that, rather than using Sheets' "append", never lands
  // inside a block of rows separated by blank lines.
  const values = await readRange(sheets, source.spreadsheetId, quoteTab(tab), counter);
  const { columns, missing } = locateHeaders(values);
  if (missing.length) throw new Error(`Tab "${tab}" is missing columns: ${missing.join(", ")}`);
  // The cache only learns about rows at the next sync; the sheet knows now.
  if (values.some((r) => emailsIn(r?.[columns.email]).includes(address))) throw new Error(`${address} is already in "${tab}".`);
  const row = values.length + 1;
  const name = String(businessName || "").trim() || address.split("@")[1];
  const cells = [
    { key: "email", value: address },
    { key: "businessName", value: name },
  ];
  const logged = logChanges(
    cells.map((c) => ({ by: "add-contact", source: source.id, spreadsheetId: source.spreadsheetId, tab, row, email: address, key: c.key, old: "", new: c.value }))
  );
  try {
    await writeCells(
      sheets,
      source.spreadsheetId,
      cells.map((c) => ({ range: cellRange(tab, columns[c.key], row), value: c.value })),
      counter
    );
  } catch (err) {
    markFailed(logged, err);
    if (/exceeds grid limits/i.test(err?.message || "")) throw new Error(`Tab "${tab}" has no empty rows left. Add rows at the bottom in Sheets, then try again.`);
    throw err;
  }
  audit({
    action: "sheet_add_row",
    account: source.account,
    email: getAccountInfo(source.account).email,
    outcome: "added",
    detail: { spreadsheet: source.spreadsheetId, tab, row, to: address },
  });
  return { row, address };
}
