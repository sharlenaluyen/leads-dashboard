import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Everything the server reads lives in a temp folder, set before it loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-state-"));
fs.mkdirSync(path.join(dir, "config"));
fs.mkdirSync(path.join(dir, "google"));
process.env.LEADS_CONFIG_DIR = path.join(dir, "config");
process.env.LEADS_DB = path.join(dir, "leads.db");
process.env.LEADS_CHANGES = path.join(dir, "changes.jsonl");
process.env.GOOGLE_MCP_DIR = path.join(dir, "google");
const accountsFile = path.join(dir, "google", "accounts.json");
fs.writeFileSync(accountsFile, JSON.stringify({ work: { email: "me@work.com", refresh_token: "r", scopes: [] } }));
fs.writeFileSync(
  path.join(dir, "config", "sources.json"),
  JSON.stringify([{ id: "s", name: "Sheet", spreadsheetId: "ss", account: "work", tabs: ["Leads"], customStatuses: [] }])
);

const { app } = await import("../src/app.js");
const { getDb, closeDb } = await import("../src/db.js");
const { DatabaseSync } = await import("node:sqlite");

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
after(() => {
  server.close();
  closeDb();
});

// node:http rather than fetch: fetch sends "Cache-Control: no-cache", which
// (correctly) makes any server skip the 304.
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, method, path: url, headers: { ...headers, ...(body ? { "Content-Type": "application/json", "X-Dashboard": "1" } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      }
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const getState = (etag) => request("GET", "/api/state", { headers: etag ? { "If-None-Match": etag } : {} });

let leadCount = 0;
function addLead() {
  leadCount++;
  return getDb()
    .prepare("INSERT INTO leads (source_id, tab, email, row_number, business_name) VALUES ('s', 'Leads', ?, ?, ?)")
    .run(`lead${leadCount}@x.com`, leadCount + 1, `Business ${leadCount}`).lastInsertRowid;
}

// Expects `change` to make the old ETag stale, and returns the new one.
async function expectNewState(etag, change, what) {
  await change();
  const res = await getState(etag);
  assert.equal(res.status, 200, `${what}: a fresh state, not a 304`);
  assert.notEqual(res.headers.etag, etag, what);
  const again = await getState(res.headers.etag);
  assert.equal(again.status, 304, `${what}: and the new ETag is then stable`);
  return res;
}

test("an unchanged state answers 304 with no body, and says to revalidate", async () => {
  addLead();
  const first = await getState();
  assert.equal(first.status, 200);
  assert.match(first.headers.etag, /^"[\w-]+"$/);
  assert.equal(first.headers["cache-control"], "no-cache");
  assert.equal(first.json().sources[0].leads.length, 1);

  const second = await getState(first.headers.etag);
  assert.equal(second.status, 304);
  assert.equal(second.text, "");
  assert.equal(second.headers.etag, first.headers.etag);

  assert.equal((await getState('"something-else"')).status, 200);
  assert.equal((await getState(`"x", ${first.headers.etag}`)).status, 304, "a list of ETags that includes the current one");
});

test("a write through the server's own database connection makes a new state", async () => {
  const { headers } = await getState();
  const res = await expectNewState(headers.etag, () => addLead(), "new lead");
  assert.equal(res.json().sources[0].leads.length, 2);
});

test("a write from another connection makes a new state", async () => {
  const { headers } = await getState();
  await expectNewState(
    headers.etag,
    () => {
      const other = new DatabaseSync(process.env.LEADS_DB);
      other.prepare("UPDATE leads SET business_name = 'Renamed elsewhere' WHERE email = 'lead1@x.com'").run();
      other.close();
    },
    "other connection"
  );
  const lead = (await getState()).json().sources[0].leads.find((l) => l.email === "lead1@x.com");
  assert.equal(lead.businessName, "Renamed elsewhere");
});

test("starring a row (stars.json) makes a new state", async () => {
  const { headers, json } = await getState();
  const id = json().sources[0].leads[0].id;
  const res = await expectNewState(headers.etag, async () => assert.equal((await request("PUT", `/api/leads/${id}/star`, { body: { starred: true } })).status, 200), "star");
  assert.equal(res.json().sources[0].leads.find((l) => l.id === id).starred, true);
});

test("saving a setting (settings.json) makes a new state", async () => {
  const { headers } = await getState();
  const res = await expectNewState(headers.etag, async () => assert.equal((await request("PATCH", "/api/settings", { body: { density: "compact" } })).status, 200), "setting");
  assert.equal(res.json().settings.density, "compact");
});

test("adding a section (sources.json) makes a new state", async () => {
  const { headers } = await getState();
  const res = await expectNewState(
    headers.etag,
    async () => assert.equal((await request("POST", "/api/sources", { body: { name: "Second", url: "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstu/edit", account: "work", tabs: ["Leads"] } })).status, 200),
    "section"
  );
  assert.equal(res.json().sources.length, 2);
});

test("a hand edit to a config file makes a new state", async () => {
  const { headers } = await getState();
  const file = path.join(dir, "config", "settings.json");
  const res = await expectNewState(
    headers.etag,
    () => {
      fs.writeFileSync(`${file}.hand`, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), fontSize: "large" }));
      fs.renameSync(`${file}.hand`, file);
    },
    "hand edit"
  );
  assert.equal(res.json().settings.fontSize, "large");
});

test("a sign-in (accounts.json) makes a new state", async () => {
  const { headers } = await getState();
  const res = await expectNewState(
    headers.etag,
    () => {
      fs.writeFileSync(`${accountsFile}.tmp`, JSON.stringify({ work: { email: "me@work.com", refresh_token: "r2", scopes: [] }, home: { email: "me@home.com", refresh_token: "h", scopes: [] } }));
      fs.renameSync(`${accountsFile}.tmp`, accountsFile);
    },
    "sign-in"
  );
  assert.deepEqual(res.json().accounts.map((a) => a.alias).sort(), ["home", "work"]);
});

test("a request that fails validation and writes nothing keeps the same state", async () => {
  const { headers } = await getState();
  assert.equal((await request("PATCH", "/api/settings", { body: { nope: 1 } })).status, 400);
  assert.equal((await request("POST", "/api/contacts/dismiss", { body: { account: "work", email: "nobody@x.com" } })).status, 400);
  assert.equal((await getState(headers.etag)).status, 304);
});

test("other routes don't get the state's ETag", async () => {
  const res = await request("GET", "/api/changes");
  assert.equal(res.status, 200);
  assert.notEqual(res.headers["cache-control"], "no-cache");
});
