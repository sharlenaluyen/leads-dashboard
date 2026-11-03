import crypto from "crypto";
import { HEADERS, OPTIONAL_HEADERS } from "./config.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();

// 'ca, hotel' -> "'ca, hotel'" (single quotes doubled inside, per A1 notation)
export function quoteTab(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

// 0 -> A, 25 -> Z, 26 -> AA
export function columnLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellRange(tab, colIndex, rowNumber) {
  return `${quoteTab(tab)}!${columnLetter(colIndex)}${rowNumber}`;
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isEmail(value) {
  return EMAIL_RE.test(String(value ?? "").trim());
}

// An email cell can hold several addresses (separated by commas, semicolons,
// spaces or line breaks), e.g. a lead plus colleagues who joined the thread.
// The first is the row's identity; all of them are matched against Gmail.
export function emailsIn(cell) {
  const found = String(cell ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^["'<(\[]+|["'>)\],.]+$/g, "").toLowerCase())
    .filter(isEmail);
  return [...new Set(found)];
}

export function parsePriority(value) {
  const s = String(value ?? "").trim();
  if (!/^[0-3]$/.test(s)) return null;
  return Number(s);
}

// Local calendar date, YYYY-MM-DD. Entered as a real date, so it shows in
// the column's own date format (see writeCells).
export function formatDate(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A date cell as written by formatDate (or typed by hand) -> local-midnight
// ms, or null when blank or unreadable.
export function parseSheetDate(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Finds the header row (the first of the top 10 rows with an "email" cell)
// and maps each required header to its column. Returns a list of the
// required headers that are missing, if any.
export function locateHeaders(values) {
  const top = (values || []).slice(0, 10);
  const headerIndex = top.findIndex((row) => (row || []).some((c) => norm(c) === HEADERS.email));
  const all = { ...HEADERS, ...OPTIONAL_HEADERS };
  if (headerIndex === -1) {
    return { headerIndex: -1, columns: {}, missing: Object.values(HEADERS) };
  }
  const headerRow = values[headerIndex].map(norm);
  const columns = {};
  for (const [key, name] of Object.entries(all)) {
    const i = headerRow.indexOf(name);
    if (i !== -1) columns[key] = i;
  }
  const missing = Object.entries(HEADERS)
    .filter(([key]) => columns[key] === undefined)
    .map(([, name]) => name);
  return { headerIndex, columns, missing };
}

export function rowHash(row) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        row.businessName,
        row.priority,
        row.followUpStatus,
        row.notes,
        row.draftId,
        row.rowNumber,
        row.lastEmail,
        row.lastEmailDir,
        row.lastFollowedUp,
        (row.emails || []).join(","),
      ])
    )
    .digest("hex");
}

// One tab's values (as returned by values.get) -> header check + clean rows.
// Rows without a valid email are counted but not tracked; a repeated email in
// the same tab keeps only its first row.
export function parseTab(values) {
  const { headerIndex, columns, missing } = locateHeaders(values);
  if (missing.length) {
    return { ok: false, problem: `Missing columns: ${missing.join(", ")}`, missing, rows: [], skipped: 0 };
  }
  const get = (row, key) => (columns[key] === undefined ? "" : String(row[columns[key]] ?? "").trim());
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  const duplicates = [];
  for (let i = headerIndex + 1; i < values.length; i++) {
    const raw = values[i] || [];
    if (raw.every((c) => String(c ?? "").trim() === "")) continue;
    const emails = emailsIn(get(raw, "email"));
    const email = emails[0];
    if (!email) {
      skipped++;
      continue;
    }
    if (seen.has(email)) {
      duplicates.push(email);
      continue;
    }
    seen.add(email);
    const row = {
      rowNumber: i + 1,
      email,
      emails,
      emailCell: get(raw, "email"),
      businessName: get(raw, "businessName"),
      priorityRaw: get(raw, "priority"),
      priority: parsePriority(get(raw, "priority")),
      followUpStatus: get(raw, "followUpStatus"),
      lastEmail: get(raw, "lastEmail"),
      lastEmailDir: get(raw, "lastEmailDir"),
      lastFollowedUp: get(raw, "lastFollowedUp"),
      draftId: get(raw, "draftId"),
      notes: get(raw, "notes"),
    };
    row.hash = rowHash(row);
    rows.push(row);
  }
  return { ok: true, columns, rows, skipped, duplicates };
}

// --- Google Sheets calls ----------------------------------------------------

export async function listTabs(sheets, spreadsheetId, counter) {
  const { data } = await counter.run(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(sheetId,title,hidden)",
    })
  );
  return {
    title: data.properties?.title,
    tabs: (data.sheets || []).map((s) => ({
      title: s.properties.title,
      hidden: Boolean(s.properties.hidden),
    })),
  };
}

// Several ranges of one spreadsheet in a single call, in the order given.
export async function readRanges(sheets, spreadsheetId, ranges, counter) {
  const { data } = await counter.run(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      valueRenderOption: "FORMATTED_VALUE",
      majorDimension: "ROWS",
    })
  );
  return ranges.map((_, i) => data.valueRanges?.[i]?.values || []);
}

// All listed tabs of one spreadsheet in a single call.
export async function readTabs(sheets, spreadsheetId, tabs, counter) {
  const values = await readRanges(sheets, spreadsheetId, tabs.map(quoteTab), counter);
  return Object.fromEntries(tabs.map((tab, i) => [tab, values[i]]));
}

export async function readRange(sheets, spreadsheetId, range, counter) {
  const { data } = await counter.run(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" })
  );
  return data.values || [];
}

// updates: [{ range, value, date? }]. `date` values (YYYY-MM-DD) are entered
// as real dates so the column's date format applies; everything else gets a
// leading apostrophe, which Sheets stores as exact text, never reinterpreted.
// One call either way. Returns what each cell holds after the write, as the
// same call reports it back, so callers can trust the sheet's own answer
// without reading it again.
export async function writeCells(sheets, spreadsheetId, updates, counter) {
  if (!updates.length) return [];
  const entered = (u) => (u.date || u.value === "" ? u.value : `'${u.value}`);
  const { data } = await counter.run(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        includeValuesInResponse: true,
        responseValueRenderOption: "FORMATTED_VALUE",
        data: updates.map((u) => ({ range: u.range, values: [[entered(u)]] })),
      },
    })
  );
  const responses = data?.responses || [];
  return updates.map((u, i) => {
    const echoed = responses[i]?.updatedData;
    return echoed ? String(echoed.values?.[0]?.[0] ?? "") : u.value;
  });
}

// "https://docs.google.com/spreadsheets/d/<id>/edit..." or a bare id -> id
export function spreadsheetIdFrom(input) {
  const s = String(input || "").trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}
