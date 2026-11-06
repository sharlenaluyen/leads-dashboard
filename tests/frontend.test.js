import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appState, boot, check, choose, lead, row, source } from "./helpers/dashboard.js";

let page;
afterEach(() => page?.close());

const names = (p) => p.$$("tbody tr .biz").map((n) => n.firstChild.textContent);
const optionValues = (select) => [...select.options].map((o) => o.value);

// --- Rendering -------------------------------------------------------------

test("renders one row per lead, ordered by what needs doing next", async () => {
  const leads = [
    lead({ businessName: "Waiting Co", lastEmailAt: Date.now(), lastEmailDir: "sent" }),
    lead({ businessName: "Replied Co", lastEmailAt: Date.now(), lastEmailDir: "received" }),
    lead({ businessName: "Never Co" }),
  ];
  page = await boot(appState({ sources: [source("a", leads)] }));
  assert.deepEqual(names(page), ["Replied Co", "Never Co", "Waiting Co"]);
  assert.equal(row(page, "Replied Co").querySelector(".action").textContent, "Reply");
});

test("closed leads are hidden until 'show closed' is ticked", async () => {
  const leads = [lead({ businessName: "Live" }), lead({ businessName: "Done", followUpStatus: "Closed - interested" })];
  page = await boot(appState({ sources: [source("a", leads)] }));
  assert.deepEqual(names(page), ["Live"]);
  const box = page.$("#show-closed");
  box.checked = true;
  box.dispatchEvent(new page.window.Event("input"));
  assert.deepEqual(names(page).sort(), ["Done", "Live"]);
});

test("search filters rows by business name or email", async () => {
  const leads = [lead({ businessName: "Acme" }), lead({ businessName: "Globex", emails: ["hi@globex.test"] })];
  page = await boot(appState({ sources: [source("a", leads)] }));
  const search = page.$("#search");
  search.value = "globex.test";
  search.dispatchEvent(new page.window.Event("input"));
  assert.deepEqual(names(page), ["Globex"]);
});

// --- Selection bar -----------------------------------------------------------

test("the selection bar appears with a count once a lead is checked", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" }), lead({ businessName: "B" })])] }));
  assert.equal(page.$("#actionbar").hidden, true);
  check(page, "A");
  assert.equal(page.$("#actionbar").hidden, false);
  assert.equal(page.$("#selected-count").textContent, "1 selected");
  check(page, "A");
  assert.equal(page.$("#actionbar").hidden, true);
});

test("select-all checks every visible row in the tab, and Clear unchecks them", async () => {
  page = await boot(appState({ sources: [source("a", [lead(), lead(), lead()])] }));
  const all = page.$(".select-all");
  all.checked = true;
  all.dispatchEvent(new page.window.Event("change"));
  assert.equal(page.$("#selected-count").textContent, "3 selected");
  assert.ok(page.$$("td.cb input").every((cb) => cb.checked));
  page.$("#clear-selection").click();
  assert.equal(page.$("#actionbar").hidden, true);
});

// --- Bulk priority / status --------------------------------------------------

test("setting priority from the selection bar updates every checked lead", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" }), lead({ businessName: "C" })];
  page = await boot(appState({ sources: [source("a", leads)] }), { "PATCH /api/leads/:id": () => ({}) });
  check(page, "A");
  check(page, "C");
  choose(page, page.$("#bulk-priority"), "3");
  await page.settle();

  const patches = page.requests.filter((r) => r.method === "PATCH");
  assert.deepEqual(
    patches.map((r) => [r.url, r.body]),
    [
      [`/api/leads/${leads[0].id}`, { field: "priority", value: "3" }],
      [`/api/leads/${leads[2].id}`, { field: "priority", value: "3" }],
    ]
  );
  assert.equal(row(page, "A").querySelector("select.priority").value, "3");
  assert.equal(row(page, "B").querySelector("select.priority").value, "");
  assert.equal(row(page, "C").querySelector("select.priority").value, "3");
  assert.match(page.$("#toast").textContent, /Priority 3 set on 2 leads/);
  // Selection stays so you can go straight on to drafting.
  assert.equal(page.$("#selected-count").textContent, "2 selected");
  // The dropdown snaps back to its prompt for the next pick.
  assert.equal(page.$("#bulk-priority").value, "__");
});

test("setting status from the selection bar updates every checked lead", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" })];
  page = await boot(appState({ sources: [source("a", leads)] }), { "PATCH /api/leads/:id": () => ({}) });
  check(page, "A");
  check(page, "B");
  choose(page, page.$("#bulk-status"), "Awaiting Reply");
  await page.settle();

  const patches = page.requests.filter((r) => r.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.ok(patches.every((r) => r.body.field === "followUpStatus" && r.body.value === "Awaiting Reply"));
  assert.equal(row(page, "A").querySelector("select.status").value, "Awaiting Reply");
  assert.equal(row(page, "B").querySelector("select.status").value, "Awaiting Reply");
});

test("clearing priority from the selection bar sends an empty value", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A", priority: 2 })])] }), { "PATCH /api/leads/:id": () => ({}) });
  check(page, "A");
  choose(page, page.$("#bulk-priority"), "");
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.method === "PATCH").body, { field: "priority", value: "" });
  assert.equal(row(page, "A").querySelector("select.priority").value, "");
});

test("when some leads fail, the rest still update and the failures are named", async () => {
  const leads = [lead({ businessName: "Good" }), lead({ businessName: "Moved" })];
  page = await boot(appState({ sources: [source("a", leads)] }), {
    "PATCH /api/leads/:id": (body, [id]) => {
      if (Number(id) === leads[1].id) throw { status: 409, error: "This row moved" };
      return {};
    },
  });
  check(page, "Good");
  check(page, "Moved");
  choose(page, page.$("#bulk-priority"), "1");
  await page.settle();

  const toast = page.$("#toast").textContent;
  assert.match(toast, /1 updated, 1 failed/);
  assert.match(toast, /Moved: This row moved/);
  assert.equal(page.requests.filter((r) => r.method === "PATCH").length, 2);
  // Reloads from the server afterwards so the table shows what really saved.
  assert.equal(page.requests.filter((r) => r.url === "/api/state").length, 2);
});

test("status choices are limited to statuses every selected sheet has", async () => {
  const a = source("a", [lead({ businessName: "From A" })], { statuses: ["Open", "Hot", "Awaiting Reply"] });
  const b = source("b", [lead({ businessName: "From B" })], { statuses: ["Open", "Awaiting Reply", "Cold"] });
  page = await boot(appState({ sources: [a, b] }));

  check(page, "From A");
  assert.deepEqual(optionValues(page.$("#bulk-status")), ["__", "Open", "Hot", "Awaiting Reply", ""]);
  check(page, "From B");
  assert.deepEqual(optionValues(page.$("#bulk-status")), ["__", "Open", "Awaiting Reply", ""]);
});

test("bulk controls are disabled when writing to spreadsheets is off", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])], settings: { writeBack: false } }));
  check(page, "A");
  assert.equal(page.$("#bulk-priority").disabled, true);
  assert.equal(page.$("#bulk-status").disabled, true);
  assert.match(page.$("#bulk-priority").title, /turned off/);
});

// --- Single-row edits --------------------------------------------------------

test("changing one row's priority saves just that row", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" })];
  page = await boot(appState({ sources: [source("a", leads)] }), { "PATCH /api/leads/:id": () => ({}) });
  choose(page, row(page, "B").querySelector("select.priority"), "2");
  await page.settle();
  const patches = page.requests.filter((r) => r.method === "PATCH");
  assert.deepEqual(patches.map((r) => r.url), [`/api/leads/${leads[1].id}`]);
  assert.deepEqual(patches[0].body, { field: "priority", value: "2" });
});

// --- Saving drafts -----------------------------------------------------------

const draftFor = (l, overrides = {}) => ({ leadId: l.id, email: l.email, businessName: l.businessName, subject: `Hi ${l.businessName}`, body: "Just checking in.", inThread: false, ...overrides });
const button = (p, text) => p.$$("#draft-results button").find((b) => b.textContent === text);
const saveRequests = (p) => p.requests.filter((r) => r.url === "/api/drafts/save");

// Selects the leads, opens the dialog and writes drafts, leaving the draft list showing.
async function writeDrafts(leads, drafts, saveRoute = () => ({ replaced: false })) {
  const p = await boot(appState({ sources: [source("a", leads)] }), {
    "POST /api/drafts/generate": () => drafts,
    "POST /api/drafts/save": saveRoute,
  });
  for (const l of leads) check(p, l.businessName);
  p.$("#draft-btn").click();
  p.$("#draft-generate").click();
  await p.settle();
  return p;
}

test("Save all closes the dialog once every draft is saved", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" })];
  page = await writeDrafts(leads, leads.map((l) => draftFor(l)));
  assert.equal(page.$("#draft-dialog").open, true);

  button(page, "Save all to Gmail drafts").click();
  await page.settle();

  assert.deepEqual(saveRequests(page).map((r) => r.body.leadId), [leads[0].id, leads[1].id]);
  assert.equal(page.$("#draft-dialog").open, false);
  assert.match(page.$("#toast").textContent, /Saved 2 drafts to Gmail/);
  // Reloads so the table picks up the new draft ids.
  assert.equal(page.requests.filter((r) => r.url === "/api/state").length, 2);
});

test("Save all keeps the dialog open when a draft fails, and a retry only resends the failed one", async () => {
  const leads = [lead({ businessName: "Good" }), lead({ businessName: "Flaky" })];
  let failFlaky = true;
  page = await writeDrafts(leads, leads.map((l) => draftFor(l)), (body) => {
    if (body.leadId === leads[1].id && failFlaky) throw { status: 502, error: "Gmail is down" };
    return { replaced: false };
  });

  button(page, "Save all to Gmail drafts").click();
  await page.settle();

  assert.equal(page.$("#draft-dialog").open, true);
  assert.match(page.$("#draft-results").textContent, /Gmail is down/);
  assert.match(page.$("#toast").textContent, /1 saved, 1 not saved/);
  const saveAll = button(page, "Save all to Gmail drafts");
  assert.equal(saveAll.disabled, false);

  failFlaky = false;
  saveAll.click();
  await page.settle();

  assert.deepEqual(saveRequests(page).map((r) => r.body.leadId), [leads[0].id, leads[1].id, leads[1].id]);
  assert.equal(page.$("#draft-dialog").open, false);
  assert.match(page.$("#toast").textContent, /Saved 2 drafts to Gmail/);
});

test("Save all keeps the dialog open when Claude couldn't write one of the drafts", async () => {
  const leads = [lead({ businessName: "Fine" }), lead({ businessName: "Broken" })];
  page = await writeDrafts(leads, [draftFor(leads[0]), draftFor(leads[1], { subject: "", body: "", error: "No thread found" })]);

  button(page, "Save all to Gmail drafts").click();
  await page.settle();

  assert.deepEqual(saveRequests(page).map((r) => r.body.leadId), [leads[0].id]);
  assert.equal(page.$("#draft-dialog").open, true);
  assert.match(page.$("#toast").textContent, /1 saved, 1 not saved/);
});

test("Save all skips drafts already saved one by one, then closes", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" })];
  page = await writeDrafts(leads, leads.map((l) => draftFor(l)));

  button(page, "Save to Gmail drafts").click();
  await page.settle();
  assert.equal(page.$("#draft-dialog").open, true);

  button(page, "Save all to Gmail drafts").click();
  await page.settle();

  assert.deepEqual(saveRequests(page).map((r) => r.body.leadId), [leads[0].id, leads[1].id]);
  assert.equal(page.$("#draft-dialog").open, false);
  assert.match(page.$("#toast").textContent, /Saved 2 drafts to Gmail/);
});

test("saving drafts one by one leaves the dialog open", async () => {
  const leads = [lead({ businessName: "A" })];
  page = await writeDrafts(leads, [draftFor(leads[0])]);
  button(page, "Save to Gmail drafts").click();
  await page.settle();
  assert.equal(page.$("#draft-dialog").open, true);
  assert.match(page.$("#draft-results").textContent, /Saved to Gmail drafts/);
});
