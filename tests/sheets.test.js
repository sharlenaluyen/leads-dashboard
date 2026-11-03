import { test } from "node:test";
import assert from "node:assert/strict";
import { cellRange, columnLetter, formatDate, locateHeaders, parsePriority, parseTab, spreadsheetIdFrom } from "../src/sheets.js";

const HEADER = ["Business Name", "Email", "Priority", "Follow-up Status", "Last Email", "Last Email Dir", "Last Followed Up", "Draft ID", "Notes"];

test("columnLetter covers single and double letters", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(27), "AB");
  assert.equal(columnLetter(701), "ZZ");
  assert.equal(columnLetter(702), "AAA");
});

test("cellRange quotes tab names with commas and apostrophes", () => {
  assert.equal(cellRange("ca, hotel", 2, 5), "'ca, hotel'!C5");
  assert.equal(cellRange("bob's list", 0, 2), "'bob''s list'!A2");
});

test("locateHeaders matches case-insensitively and finds a header row below a legend", () => {
  const values = [["", "", "", "", "no reply"], HEADER, ["Roxy", "press@roxy.com"]];
  const { headerIndex, missing, columns } = locateHeaders(values);
  assert.equal(headerIndex, 1);
  assert.deepEqual(missing, []);
  assert.equal(columns.notes, 8);
});

test("locateHeaders lists every missing required column", () => {
  const { missing } = locateHeaders([["contact", "hotel", "email", "status"]]);
  assert.deepEqual(missing, ["business name", "priority", "follow-up status", "last email", "last email dir", "last followed up", "draft id"]);
});

test("parseTab skips rows without a valid email and keeps the first of duplicates", () => {
  const values = [
    HEADER,
    ["Roxy", "Press@Roxy.com", "1", "Open"],
    ["No email", "Not published - contact form only"],
    [],
    ["Roxy again", "press@roxy.com", "2"],
    ["Soho", "press@soho.com", "7", "waiting for response"],
  ];
  const r = parseTab(values);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.duplicates, ["press@roxy.com"]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].email, "press@roxy.com");
  assert.equal(r.rows[0].rowNumber, 2);
  assert.equal(r.rows[0].priority, 1);
  assert.equal(r.rows[1].priority, null, "out-of-range priority is ignored");
  assert.equal(r.rows[1].rowNumber, 6);
});

test("parseTab reports a missing-header problem instead of rows", () => {
  const r = parseTab([["email"], ["a@b.com"]]);
  assert.equal(r.ok, false);
  assert.match(r.problem, /Missing columns: business name/);
});

test("row hash changes when a user-edited field changes", () => {
  const a = parseTab([HEADER, ["Roxy", "a@b.com", "1", "Open"]]).rows[0].hash;
  const b = parseTab([HEADER, ["Roxy", "a@b.com", "2", "Open"]]).rows[0].hash;
  assert.notEqual(a, b);
});

test("parsePriority accepts only 0-3", () => {
  assert.equal(parsePriority("0"), 0);
  assert.equal(parsePriority(" 3 "), 3);
  assert.equal(parsePriority("4"), null);
  assert.equal(parsePriority("P1"), null);
  assert.equal(parsePriority(""), null);
});

test("formatDate is a local YYYY-MM-DD", () => {
  assert.equal(formatDate(new Date(2026, 9, 5, 23, 30).getTime()), "2026-10-05");
  assert.equal(formatDate(null), "");
});

test("spreadsheetIdFrom handles links and bare ids", () => {
  assert.equal(
    spreadsheetIdFrom("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcde/edit?gid=1#gid=1"),
    "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcde"
  );
  assert.equal(spreadsheetIdFrom("1ZyXwVuTsRqPoNmLkJiHgFeDcBa-9876543210_zyxw"), "1ZyXwVuTsRqPoNmLkJiHgFeDcBa-9876543210_zyxw");
  assert.equal(spreadsheetIdFrom("https://example.com"), null);
});

test("an email cell can hold several addresses; the first is the row's identity", async () => {
  const { emailsIn, parseTab } = await import("../src/sheets.js");
  assert.deepEqual(emailsIn("Jane@Acme.com, bob@acme.com; <cy@acme.com>\nnot-an-email"), ["jane@acme.com", "bob@acme.com", "cy@acme.com"]);
  assert.deepEqual(emailsIn("website only - echoartstudio.net"), []);
  assert.deepEqual(emailsIn('"stay@pantai.com", stay@pantai.com'), ["stay@pantai.com"], "quotes stripped, duplicates merged");
  const parsed = parseTab([
    ["business name", "email", "priority", "follow-up status", "last email", "last email dir", "last followed up", "draft id"],
    ["Acme", "jane@acme.com, bob@acme.com", "", "", "", "", "", ""],
  ]);
  assert.equal(parsed.rows[0].email, "jane@acme.com");
  assert.deepEqual(parsed.rows[0].emails, ["jane@acme.com", "bob@acme.com"]);
});
