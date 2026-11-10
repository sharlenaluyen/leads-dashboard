import fs from "fs";
import path from "path";
import crypto from "crypto";
import { HEADERS, ROOT, getSource, loadSettings } from "./config.js";
import { getDb } from "./db.js";
import { CallCounter, audit, explainingGoogleErrors, getAccountInfo, googleFailure, sheetsClientFor } from "./google.js";
import { cellRange, emailsIn, formatDate, locateHeaders, parseSheetDate, quoteTab, readRanges, writeCells } from "./sheets.js";
import { withSheetLock } from "./lock.js";
import { UserError } from "./errors.js";

// Every cell the dashboard writes to a spreadsheet, one JSON object per line,
// oldest first. Unlike the SQLite cache this is never rebuilt or deleted by
// the dashboard, so any change can be traced and reversed later.
//
// Entry: { id, at, by: "sync" | "dashboard" | "add-contact" | "undo",
//          source, spreadsheetId, tab, row, email, key, column, old, new,
//          syncId?, undoOf? }
// `new` is the value being written. A write that then fails is followed by
// a marker line: { id, at, failedOf, error }.
export const CHANGES_PATH = process.env.LEADS_CHANGES || path.join(ROOT, "data", "sheet-changes.jsonl");

const DATE_KEYS = new Set(["lastEmail", "lastFollowedUp"]);

// Appends and fsyncs, so a logged change survives a crash or power loss. If
// the last line was cut off (a crash mid-write), a newline goes first so the
// partial line doesn't swallow the next entry.
function appendLines(lines) {
  fs.mkdirSync(path.dirname(CHANGES_PATH), { recursive: true });
  const fd = fs.openSync(CHANGES_PATH, "a+");
  try {
    const { size } = fs.fstatSync(fd);
    let lead = "";
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = "\n";
    }
    fs.writeSync(fd, lead + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Logged *before* the cells are written, so a crash after the write never
// leaves an unlogged change. If the write then fails, markFailed records it.
// A crash between the two leaves an entry for a write that may not have
// happened; undo is still safe, since it only goes through when the cell
// holds the entry's new value.
export function logChanges(entries) {
  if (!entries.length) return [];
  const at = Date.now();
  const stamped = entries.map((e) => ({ id: crypto.randomBytes(6).toString("hex"), at, column: HEADERS[e.key] || e.key, ...e }));
  appendLines(stamped);
  return stamped;
}

// The write behind these logged entries didn't go through.
export function markFailed(entries, err) {
  if (!entries.length) return;
  const at = Date.now();
  appendLines(entries.map((e) => ({ id: crypto.randomBytes(6).toString("hex"), at, failedOf: e.id, error: String(err?.message || err) })));
}

function readAll() {
  if (!fs.existsSync(CHANGES_PATH)) return [];
  return fs
    .readFileSync(CHANGES_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// Newest first, each marked with whether it has been undone or its write
// failed.
export function readChanges({ limit = 300 } = {}) {
  const all = readAll();
  const undone = new Set(all.filter((e) => e.undoOf).map((e) => e.undoOf));
  const failed = new Map(all.filter((e) => e.failedOf).map((e) => [e.failedOf, e.error]));
  return all
    .filter((e) => !e.failedOf)
    .slice(-limit)
    .reverse()
    .map((e) => ({ ...e, undone: undone.has(e.id), ...(failed.has(e.id) ? { failed: failed.get(e.id) || true } : {}) }));
}

const sameCell = (key, a, b) => {
  if ((a || "") === (b || "")) return true;
  return DATE_KEYS.has(key) && Boolean(a) && Boolean(b) && parseSheetDate(a) === parseSheetDate(b);
};

/**
 * Puts one logged cell back to its old value. Refused when the row no
 * longer belongs to the same email, or the cell has changed again since,
 * so an undo never overwrites something newer.
 */
export function undoChange(id) {
  return withSheetLock(() => undoChangeNow(id));
}

async function undoChangeNow(id) {
  if (!loadSettings().writeBack) throw new UserError("Writing to spreadsheets is turned off (Settings → Write to spreadsheets).");
  const all = readAll();
  const entry = all.find((e) => e.id === id && !e.failedOf);
  if (!entry) throw new UserError("That change isn't in the log.");
  const failed = new Set(all.filter((e) => e.failedOf).map((e) => e.failedOf));
  if (failed.has(id)) throw new UserError("That change never reached the spreadsheet, so there's nothing to undo.");
  if (all.some((e) => e.undoOf === id && !failed.has(e.id))) throw new UserError("That change was already undone.");
  if (entry.by === "add-contact") throw new UserError("To undo an added row, delete the row in the spreadsheet.");
  const source = getSource(entry.source);
  const sheets = sheetsClientFor(source.account);
  const counter = new CallCounter();
  // One read: the header rows plus the logged row.
  const [top, [row = []]] = await explainingGoogleErrors(source.account, () =>
    readRanges(sheets, source.spreadsheetId, [`${quoteTab(entry.tab)}!1:10`, `${quoteTab(entry.tab)}!${entry.row}:${entry.row}`], counter)
  );
  const { columns } = locateHeaders(top);
  if (columns.email === undefined || columns[entry.key] === undefined) throw new UserError(`Tab "${entry.tab}" no longer has the "${entry.column}" column.`);
  if (emailsIn(row[columns.email])[0] !== entry.email) {
    throw new UserError("That row moved or changed email since. Find the row in the spreadsheet and fix it there.");
  }
  const current = String(row[columns[entry.key]] ?? "");
  if (!sameCell(entry.key, current, entry.new)) {
    throw new UserError(`The cell has changed since (it's now "${current}"), so it wasn't undone.`);
  }
  const date = DATE_KEYS.has(entry.key) && parseSheetDate(entry.old) != null;
  const value = date ? formatDate(parseSheetDate(entry.old)) : entry.old || "";
  const [logged] = logChanges([{ ...pick(entry), by: "undo", old: current, new: value, undoOf: id }]);
  try {
    await writeCells(sheets, source.spreadsheetId, [{ range: cellRange(entry.tab, columns[entry.key], entry.row), value, date }], counter);
  } catch (err) {
    const failure = googleFailure(err, source.account);
    markFailed([logged], failure);
    throw failure;
  }
  // The next sync re-reads the row rather than trusting the cached copy.
  getDb().prepare("UPDATE leads SET row_hash = NULL WHERE source_id = ? AND tab = ? AND email = ?").run(entry.source, entry.tab, entry.email);
  audit({
    action: "sheet_edit",
    account: source.account,
    email: getAccountInfo(source.account).email,
    outcome: "undone",
    detail: { spreadsheet: source.spreadsheetId, tab: entry.tab, row: entry.row, column: entry.column, change: id },
  });
  return logged;
}

const pick = (e) => ({ source: e.source, spreadsheetId: e.spreadsheetId, tab: e.tab, row: e.row, email: e.email, key: e.key });
