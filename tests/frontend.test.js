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

test("clicking anywhere in a checkbox's cell toggles it, not just the box", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" }), lead({ businessName: "B" })])] }));
  row(page, "A").querySelector("td.cb").click();
  assert.equal(page.$("#selected-count").textContent, "1 selected");
  row(page, "A").querySelector("td.cb input").click();
  assert.equal(page.$("#actionbar").hidden, true);
  page.$("th.cb").click();
  assert.equal(page.$("#selected-count").textContent, "2 selected");
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

// --- Drafting with Save Gmail drafts off --------------------------------------

async function openDraftsWithSavingOff(routes = {}) {
  const leads = [lead({ businessName: "A" })];
  const p = await boot(appState({ sources: [source("a", leads)], settings: { createDrafts: false } }), {
    "POST /api/drafts/generate": () => [draftFor(leads[0])],
    ...routes,
  });
  check(p, "A");
  p.$("#draft-btn").click();
  return p;
}

test("with Save Gmail drafts off, the draft dialog warns and offers Close instead of Write drafts", async () => {
  page = await openDraftsWithSavingOff();
  assert.equal(page.$("#draft-off").hidden, false);
  assert.match(page.$("#draft-off").textContent, /Save Gmail drafts is off/);
  assert.equal(page.$("#draft-generate").hidden, true);
  assert.equal(page.$("#draft-close").hidden, false);
  assert.equal(page.requests.filter((r) => r.url === "/api/drafts/generate").length, 0);
});

test("Close shuts the dialog without calling Claude", async () => {
  page = await openDraftsWithSavingOff();
  page.$("#draft-close").click();
  await page.settle();
  assert.equal(page.$("#draft-dialog").open, false);
  assert.equal(page.requests.filter((r) => r.url === "/api/drafts/generate").length, 0);
});

test("with Save Gmail drafts on, there's no warning", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])] }));
  check(page, "A");
  page.$("#draft-btn").click();
  assert.equal(page.$("#draft-off").hidden, true);
  assert.equal(page.$("#draft-generate").hidden, false);
  assert.equal(page.$("#draft-close").hidden, true);
});

test("the warning's button turns saving on without calling Claude, and the drafts can then be saved", async () => {
  page = await openDraftsWithSavingOff({
    "PATCH /api/settings": (body) => ({ ...appState().settings, ...body }),
    "POST /api/drafts/save": () => ({ replaced: false }),
  });
  page.$("#draft-enable-saving").click();
  await page.settle();

  assert.deepEqual(page.requests.find((r) => r.method === "PATCH").body, { createDrafts: true });
  assert.equal(page.requests.filter((r) => r.url === "/api/drafts/generate").length, 0);
  assert.equal(page.$("#draft-off").hidden, true);
  assert.equal(page.$("#draft-generate").hidden, false);
  assert.equal(page.$("#draft-close").hidden, true);
  assert.equal(page.$("#draft-dialog").open, true);

  page.$("#draft-generate").click();
  await page.settle();
  assert.equal(button(page, "Save to Gmail drafts").disabled, false);
  assert.equal(button(page, "Save all to Gmail drafts").disabled, false);
});

test("if turning saving on fails, the warning stays and shows why", async () => {
  page = await openDraftsWithSavingOff({
    "PATCH /api/settings": () => {
      throw { status: 500, error: "Couldn't write settings.json" };
    },
  });
  page.$("#draft-enable-saving").click();
  await page.settle();
  assert.equal(page.$("#draft-off").hidden, false);
  assert.equal(page.$("#draft-enable-error").hidden, false);
  assert.match(page.$("#draft-enable-error").textContent, /Couldn't write settings.json/);
  assert.equal(page.$("#draft-generate").hidden, true);
  assert.equal(page.$("#draft-close").hidden, false);
});

// --- Starred -------------------------------------------------------------------

const bizIn = (p, sel) => [...p.$(sel).querySelectorAll("tbody tr .biz")].map((n) => n.firstChild.textContent);
const starredNames = (p) => bizIn(p, "#starred");
const sectionNames = (p) => bizIn(p, "#sections");
const starButton = (p, businessName) => row(p, businessName)?.querySelector("button.star");

test("starring a row saves only the star and copies the row into Starred", async () => {
  const leads = [lead({ businessName: "A" }), lead({ businessName: "B" })];
  page = await boot(appState({ sources: [source("a", leads)] }), { "PUT /api/leads/:id/star": (body) => body });
  assert.deepEqual(starredNames(page), []);
  assert.match(page.$("#starred").textContent, /Nothing starred yet/);
  starButton(page, "B").click();
  await page.settle();
  const req = page.requests.find((r) => r.method === "PUT");
  assert.equal(req.url, `/api/leads/${leads[1].id}/star`);
  assert.deepEqual(req.body, { starred: true });
  assert.ok(!page.requests.some((r) => r.method === "PATCH"), "nothing is written to the sheet");
  assert.deepEqual(starredNames(page), ["B"]);
  assert.deepEqual(sectionNames(page).sort(), ["A", "B"]);
  assert.equal(starButton(page, "B").getAttribute("aria-pressed"), "true");
});

test("unstarring takes the row out of Starred", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A", starred: true })])] }), { "PUT /api/leads/:id/star": (body) => body });
  assert.deepEqual(starredNames(page), ["A"]);
  starButton(page, "A").click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.method === "PUT").body, { starred: false });
  assert.deepEqual(starredNames(page), []);
});

test("in move mode a starred row shows only in Starred", async () => {
  const leads = [lead({ businessName: "A", starred: true }), lead({ businessName: "B" })];
  page = await boot(appState({ sources: [source("a", leads)], settings: { starMode: "move" } }));
  assert.deepEqual(starredNames(page), ["A"]);
  assert.deepEqual(sectionNames(page), ["B"]);
  assert.match(page.$("#sections .tab-meta").textContent, /1 in Starred/);
});

test("move mode keeps rows in their section while Starred is hidden", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A", starred: true })])], settings: { starMode: "move", showStarred: false } }));
  assert.equal(page.$("#starred").children.length, 0);
  assert.deepEqual(sectionNames(page), ["A"]);
});

test("Show Starred section off hides it; on shows it even when empty", async () => {
  page = await boot(appState({ sources: [source("a", [lead()])], settings: { showStarred: false } }));
  assert.equal(page.$("#starred").children.length, 0);
  page.close();
  page = await boot(appState({ sources: [source("a", [lead()])] }));
  assert.ok(page.$("#starred .starred"));
});

test("Allow starring off hides every star, but starred rows stay in Starred", async () => {
  const leads = [lead({ businessName: "A", starred: true }), lead({ businessName: "B" })];
  page = await boot(appState({ sources: [source("a", leads)], settings: { allowStarring: false } }));
  assert.equal(page.$$("button.star").length, 0);
  assert.deepEqual(starredNames(page), ["A"]);
});

test("Starred groups rows by sheet tab, or lists them with labels", async () => {
  const sources = [
    source("a", [lead({ businessName: "A1", starred: true }), lead({ businessName: "A2", tab: "Other", starred: true })], { tabs: ["Leads", "Other"] }),
    source("b", [lead({ businessName: "B1", starred: true })]),
  ];
  page = await boot(appState({ sources }));
  const heads = [...page.$("#starred").querySelectorAll(".tab-name")].map((n) => n.textContent);
  assert.deepEqual(heads, ["Sheet a · Leads", "Sheet a · Other", "Sheet b · Leads"]);
  assert.equal(page.$("#starred").querySelectorAll(".where").length, 0);
  page.close();

  page = await boot(appState({ sources, settings: { starredLayout: "labels" } }));
  assert.equal(page.$("#starred").querySelectorAll("table").length, 1);
  // The label gets its own column, just left of Business.
  const headers = [...page.$("#starred").querySelectorAll("thead th")].map((th) => th.textContent);
  assert.deepEqual(headers.slice(1, 4), ["Next", "Section · Tab", "Business"]);
  const labels = [...page.$("#starred").querySelectorAll("tbody tr")].map((tr) => tr.children[2].querySelector(".where").title).sort();
  assert.deepEqual(labels, ["Sheet a · Leads", "Sheet a · Other", "Sheet b · Leads"]);
  // Every row has as many cells as the header has columns.
  assert.ok([...page.$("#starred").querySelectorAll("tbody tr")].every((tr) => tr.children.length === headers.length));
  // Regular sections don't get the column.
  assert.equal(page.$("#sections").querySelectorAll(".where").length, 0);
});

test("Starred matches the other sections' color unless a color is picked", async () => {
  page = await boot(appState({ sources: [source("a", [lead()])] }));
  assert.equal(page.$("#starred .starred").className, "source starred");
  page.close();
  page = await boot(appState({ sources: [source("a", [lead()])], settings: { starredColor: "green" } }));
  assert.ok(page.$("#starred .starred").classList.contains("c-green"));
});

test("filters apply inside Starred too", async () => {
  const leads = [lead({ businessName: "Acme", starred: true }), lead({ businessName: "Globex", starred: true })];
  page = await boot(appState({ sources: [source("a", leads)] }));
  const search = page.$("#search");
  search.value = "acme";
  search.dispatchEvent(new page.window.Event("input"));
  assert.deepEqual(starredNames(page), ["Acme"]);
});

test("a failed star shows why and leaves the row unstarred", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])] }), {
    "PUT /api/leads/:id/star": () => {
      throw { status: 400, error: "That row is no longer in the dashboard. Reload the page." };
    },
  });
  starButton(page, "A").click();
  await page.settle();
  assert.match(page.$("#banners").textContent, /no longer in the dashboard/);
  assert.deepEqual(starredNames(page), []);
});

test("ticking a row in Starred ticks its copy in the section too", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A", starred: true })])] }));
  check(page, "A");
  assert.equal(page.$("#selected-count").textContent, "1 selected");
  assert.ok(page.$$("td.cb input").every((cb) => cb.checked));
});
