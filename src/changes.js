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

// Bytes read per step when reading the log backward.
const CHUNK = 64 * 1024;

function parseLine(bytes) {
  try {
    return bytes.length ? [JSON.parse(bytes.toString("utf8"))] : [];
  } catch {
    return []; // a line cut off by a crash
  }
}

// The log's entries newest first, read backward from the end of the file in
// chunks, so a caller that stops early never reads the older part. The log
// is never rotated, so this keeps /api/changes and undo fast as it grows.
// A marker (failedOf, undoOf) is always appended after the entry it refers
// to, so by the time an entry comes up, all of its markers have too.
// Lines are split on the newline byte, which never occurs inside a
// multi-byte UTF-8 character.
export function* newestFirst() {
  let fd;
  try {
    fd = fs.openSync(CHANGES_PATH, "r");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  try {
    let pos = fs.fstatSync(fd).size;
    let rest = Buffer.alloc(0); // the start of the file up to the last newline seen
    while (pos > 0) {
      const size = Math.min(CHUNK, pos);
      pos -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, pos);
      const buf = rest.length ? Buffer.concat([chunk, rest]) : chunk;
      let end = buf.length;
      let nl;
      while (end > 0 && (nl = buf.lastIndexOf(0x0a, end - 1)) !== -1) {
        yield* parseLine(buf.subarray(nl + 1, end));
        end = nl;
      }
      rest = buf.subarray(0, end);
    }
    yield* parseLine(rest);
  } finally {
    fs.closeSync(fd);
  }
}

// Newest first, each marked with whether it has been undone (by an undo
// that reached the sheet) or its write failed.
export function readChanges({ limit = 300 } = {}) {
  const undone = new Set();
  const failed = new Map();
  const out = [];
  for (const e of newestFirst()) {
    if (e.failedOf) {
      failed.set(e.failedOf, e.error);
      continue;
    }
    if (e.undoOf && !failed.has(e.id)) undone.add(e.undoOf);
    out.push({ ...e, undone: undone.has(e.id), ...(failed.has(e.id) ? { failed: failed.get(e.id) || true } : {}) });
    if (out.length >= limit) break;
  }
  return out;
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

/**
 * The logged entry `id` names, if it can be undone; otherwise throws a
 * UserError saying why not. Reads back only as far as the entry, since
 * everything about it (failure markers, undos of it) is newer.
 * Exported for tests.
 */
export function findUndoTarget(id) {
  let entry;
  let alreadyUndone = false;
  const failed = new Set();
  for (const e of newestFirst()) {
    if (e.failedOf) failed.add(e.failedOf);
    else if (e.id === id) {
      entry = e;
      break;
    } else if (e.undoOf === id && !failed.has(e.id)) alreadyUndone = true;
  }
  if (!entry) throw new UserError("That change isn't in the log.");
  if (failed.has(id)) throw new UserError("That change never reached the spreadsheet, so there's nothing to undo.");
  if (alreadyUndone) throw new UserError("That change was already undone.");
  if (entry.by === "add-contact") throw new UserError("To undo an added row, delete the row in the spreadsheet.");
  return entry;
}

async function undoChangeNow(id) {
  if (!loadSettings().writeBack) throw new UserError("Writing to spreadsheets is turned off (Settings → Write to spreadsheets).");
  const entry = findUndoTarget(id);
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
