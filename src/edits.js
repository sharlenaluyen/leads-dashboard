import { getSource, loadSettings, statusesFor } from "./config.js";
import { getDb } from "./db.js";
import { CallCounter, audit, explainingGoogleErrors, getAccountInfo, googleFailure, sheetsClientFor } from "./google.js";
import { cellRange, emailsIn, locateHeaders, quoteTab, readRanges, writeCells } from "./sheets.js";
import { logChanges, markFailed } from "./changes.js";
import { withSheetLock } from "./lock.js";
import { UserError } from "./errors.js";

const EDITABLE = {
  priority: { header: "priority", column: "priority" },
  followUpStatus: { header: "followUpStatus", column: "follow_up_status" },
  draftId: { header: "draftId", column: "draft_id" },
};

export class StaleRowError extends UserError {}

function validate(source, field, value) {
  if (field === "priority") {
    if (value === "" || value == null) return "";
    if (!/^[0-3]$/.test(String(value))) throw new UserError("Priority must be 0, 1, 2 or 3");
    return String(value);
  }
  if (field === "followUpStatus") {
    if (value === "") return "";
    const match = statusesFor(source).find((s) => s.toLowerCase() === String(value).toLowerCase());
    if (!match) throw new UserError(`Unknown status "${value}". Add it as a custom status first.`);
    return match;
  }
  return String(value ?? "");
}

/**
 * Writes one editable field to the spreadsheet, then to SQLite. The sheet is
 * the source of truth, so the write goes there first; if the row has moved
 * or changed email since the last sync, it's refused and nothing changes.
 * Waits for a running sync (see lock.js).
 */
export function setLeadField(leadId, field, rawValue) {
  return withSheetLock(() => setLeadFieldNow(leadId, field, rawValue));
}

// setLeadField for a caller already holding the sheet lock.
export async function setLeadFieldNow(leadId, field, rawValue) {
  const spec = EDITABLE[field];
  if (!spec) throw new UserError(`"${field}" isn't editable`);
  if (!loadSettings().writeBack) {
    throw new UserError("Writing to spreadsheets is turned off (Settings → Write to spreadsheets).");
  }
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) throw new UserError("Lead not found. Sync and try again.");
  const source = getSource(lead.source_id);
  const value = validate(source, field, rawValue);

  const sheets = sheetsClientFor(source.account);
  const counter = new CallCounter();
  // One read: the header rows plus this lead's row, to find the columns and
  // confirm the row still belongs to this email.
  const tab = quoteTab(lead.tab);
  const [top, [row = []]] = await explainingGoogleErrors(source.account, () =>
    readRanges(sheets, source.spreadsheetId, [`${tab}!1:10`, `${tab}!${lead.row_number}:${lead.row_number}`], counter)
  );
  const { columns, missing } = locateHeaders(top);
  if (missing.length) throw new UserError(`Tab "${lead.tab}" is missing columns: ${missing.join(", ")}`);
  const emailNow = emailsIn(row[columns.email])[0];
  if (emailNow !== lead.email) {
    throw new StaleRowError("This row moved or changed in the spreadsheet since the last sync. Sync, then try again.");
  }

  const logged = logChanges([
    {
      by: "dashboard",
      source: source.id,
      spreadsheetId: source.spreadsheetId,
      tab: lead.tab,
      row: lead.row_number,
      email: lead.email,
      key: spec.header,
      old: String(row[columns[spec.header]] ?? ""),
      new: value,
    },
  ]);
  try {
    await writeCells(sheets, source.spreadsheetId, [{ range: cellRange(lead.tab, columns[spec.header], lead.row_number), value }], counter);
  } catch (err) {
    const failure = googleFailure(err, source.account);
    markFailed(logged, failure);
    throw failure;
  }
  const stored = field === "priority" ? (value === "" ? null : Number(value)) : value;
  // Clearing row_hash makes the next sync re-read this row instead of
  // trusting the cached copy.
  db.prepare(`UPDATE leads SET ${spec.column} = ?, row_hash = NULL WHERE id = ?`).run(stored, leadId);
  // A status you set wins over reopening the row for an earlier reply.
  if (field === "followUpStatus") db.prepare("DELETE FROM pending_reopen WHERE lead_id = ?").run(leadId);
  audit({
    action: "sheet_edit",
    account: source.account,
    email: getAccountInfo(source.account).email,
    outcome: "updated",
    detail: { spreadsheet: source.spreadsheetId, tab: lead.tab, row: lead.row_number, field },
  });
  return { ...lead, [spec.column]: stored };
}
