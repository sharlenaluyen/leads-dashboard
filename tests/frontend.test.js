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

test("a bounced lead shows 'bounced', asks you to fix the address, and can be filtered", async () => {
  const leads = [
    lead({ businessName: "Waiting Co", lastEmailAt: Date.now(), lastEmailDir: "sent" }),
    lead({ businessName: "Bounced Co", lastEmailAt: Date.now(), lastEmailDir: "bounced", draftId: "r-1" }),
  ];
  page = await boot(appState({ sources: [source("a", leads)] }));
  const r = row(page, "Bounced Co");
  assert.equal(r.querySelector(".action").textContent, "Fix address", "even with a draft waiting");
  assert.equal(r.querySelector(".dir").textContent, "bounced");
  assert.ok(page.$$(".pill").some((p) => p.textContent === "1 bounced"));
  const turn = page.$("#filter-turn");
  turn.value = "bounced";
  turn.dispatchEvent(new page.window.Event("input"));
  assert.deepEqual(names(page), ["Bounced Co"]);
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
test("the saved palette and accent color are applied when the page loads", async () => {
  page = await boot(appState({ settings: { palette: "forest", accentColor: "#ffcc00" } }));
  const root = page.document.documentElement;
  assert.equal(root.dataset.palette, "forest");
  assert.equal(root.dataset.accent, "custom");
  assert.equal(root.style.getPropertyValue("--accent-custom"), "#ffcc00");
  // A light accent gets dark text on it.
  assert.equal(root.style.getPropertyValue("--accent-custom-text"), "#15162a");
  page.close();

  page = await boot(appState());
  assert.equal(page.document.documentElement.dataset.palette, undefined);
  assert.equal(page.document.documentElement.dataset.accent, undefined);
});

test("picking a palette and an accent in Settings saves and applies them; Use default goes back to the palette's", async () => {
  page = await boot(appState(), { "PATCH /api/settings": (body) => ({ ...appState().settings, ...body }) });
  const root = page.document.documentElement;
  const patches = () => page.requests.filter((r) => r.method === "PATCH").map((r) => r.body);
  page.$("#settings-btn").click();

  const palette = page.$('[data-setting="palette"]');
  palette.value = "ocean";
  palette.dispatchEvent(new page.window.Event("change"));
  await page.settle();
  assert.deepEqual(patches().at(-1), { palette: "ocean" });
  assert.equal(root.dataset.palette, "ocean");

  // Open and close without picking: nothing is saved.
  const btn = page.$("#accentColor-input");
  btn.click();
  assert.ok(page.$(".color-pop"));
  assert.equal(page.$(".color-default"), null, "no Use default while there's no custom color");
  page.$("#settings-dialog").dispatchEvent(new page.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(page.$(".color-pop"), null);
  assert.equal(patches().length, 1);

  // Picking a swatch saves it and closes the picker.
  btn.click();
  page.$('.color-choice[title="#2f7d4a"]').click();
  await page.settle();
  assert.equal(page.$(".color-pop"), null);
  assert.deepEqual(patches().at(-1), { accentColor: "#2f7d4a" });
  assert.equal(root.dataset.accent, "custom");
  assert.equal(page.$("#accentColor-input .color-name").textContent, "#2f7d4a");

  // A typed hex works too.
  btn.click();
  const hex = page.$(".color-hex");
  hex.value = "123456";
  hex.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter" }));
  await page.settle();
  assert.deepEqual(patches().at(-1), { accentColor: "#123456" });

  btn.click();
  page.$(".color-default").click();
  await page.settle();
  assert.deepEqual(patches().at(-1), { accentColor: "" });
  assert.equal(root.dataset.accent, undefined);
  assert.equal(page.$("#accentColor-input .color-name").textContent, "Default");
});

test("picking the color the default already is saves nothing", async () => {
  page = await boot(appState(), { "PATCH /api/settings": (body) => ({ ...appState().settings, ...body }) });
  page.$("#settings-btn").click();
  page.$("#accentColor-input").click();
  page.$('.color-choice[title="#5b5fc7"]').click();
  await page.settle();
  assert.equal(page.requests.filter((r) => r.method === "PATCH").length, 0);
});

// --- Settings: timing, display, behavior, safety ------------------------------

const daysAgo = (n) => Date.now() - n * 86_400_000;
const PATCH_LEAD = { "PATCH /api/leads/:id": () => ({}) };

test("follow-up timing sets the age colors, and can flag overdue rows to follow up", async () => {
  const leads = [lead({ businessName: "Old", lastEmailAt: daysAgo(5), lastEmailDir: "sent" }), lead({ businessName: "New", lastEmailAt: daysAgo(1), lastEmailDir: "sent" })];
  page = await boot(appState({ sources: [source("a", leads)] }));
  assert.equal(row(page, "Old").querySelector(".age").className, "sub age ");
  page.close();

  page = await boot(appState({ sources: [source("a", leads)], settings: { dueSoonDays: 2, overdueDays: 4, followUpBy: "timing" } }));
  assert.ok(row(page, "Old").querySelector(".age").classList.contains("very-stale"));
  assert.equal(row(page, "Old").querySelector(".action").textContent, "Follow up");
  assert.equal(row(page, "New").querySelector(".action").textContent, "Waiting");
});

test("rows sort by the chosen order", async () => {
  const leads = [
    lead({ businessName: "Bravo", priority: 1, lastEmailAt: daysAgo(2), lastEmailDir: "sent" }),
    lead({ businessName: "alpha", priority: 3, lastEmailAt: daysAgo(9), lastEmailDir: "sent" }),
    lead({ businessName: "Charlie", priority: 2, lastEmailAt: daysAgo(30), lastEmailDir: "sent" }),
  ];
  for (const [sort, want] of [["name", ["alpha", "Bravo", "Charlie"]], ["priority", ["alpha", "Charlie", "Bravo"]], ["lastEmail", ["Charlie", "alpha", "Bravo"]]]) {
    page = await boot(appState({ sources: [source("a", leads)], settings: { defaultSort: sort } }));
    assert.deepEqual(names(page), want, sort);
    page.close();
  }
  page = null;
});

test("dates show as chosen", async () => {
  const at = new Date(2026, 10, 3, 12).getTime();
  const leads = [lead({ businessName: "A", lastEmailAt: at, lastEmailDir: "sent", lastFollowedUpAt: at })];
  page = await boot(appState({ sources: [source("a", leads)], settings: { dateFormat: "absolute" } }));
  assert.match(row(page, "A").querySelector(".col-lastEmail").textContent, /^2026-11-03/);
  assert.equal(row(page, "A").querySelector(".col-lastFollowedUp").textContent, "2026-11-03");
  page.close();
  page = await boot(appState({ sources: [source("a", leads)], settings: { dateFormat: "relative" } }));
  assert.match(row(page, "A").querySelector(".col-lastFollowedUp").textContent, /days ago$/);
});

test("density, text size and hidden columns are applied to the page", async () => {
  page = await boot(appState({ settings: { density: "compact", fontSize: "large", hiddenColumns: ["priority", "action"], overdueColor: "#aa0000" } }));
  const root = page.document.documentElement;
  assert.equal(root.dataset.density, "compact");
  assert.equal(root.dataset.font, "large");
  assert.equal(root.dataset.hide, "priority action");
  assert.equal(root.style.getPropertyValue("--overdue-custom"), "#aa0000");
  // Remembered for the next page load's first paint.
  assert.deepEqual(JSON.parse(page.window.localStorage.getItem("look")).data, { overdue: "custom", density: "compact", font: "large", hide: "priority action" });
});

test("unticking a column in Settings saves it as hidden", async () => {
  page = await boot(appState(), { "PATCH /api/settings": (body) => ({ ...appState().settings, ...body }) });
  page.$("#settings-btn").click();
  const box = page.$('[data-column="status"]');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new page.window.Event("change"));
  await page.settle();
  assert.deepEqual(page.requests.at(-1).body, { hiddenColumns: ["status"] });
  assert.equal(page.document.documentElement.dataset.hide, "status");
});

test("Show closed and sections start the way Settings says", async () => {
  const leads = [lead({ businessName: "Live" }), lead({ businessName: "Done", followUpStatus: "Closed - interested" })];
  page = await boot(appState({ sources: [source("a", leads)], settings: { showClosedDefault: true, sectionsStart: "collapsed" } }));
  assert.equal(page.$("#show-closed").checked, true);
  assert.deepEqual(names(page).sort(), ["Done", "Live"]);
  assert.ok(page.$("#sections .source").classList.contains("collapsed"));
});

test("a priority change offers Undo, which writes the old value back", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A", priority: 1 })])] }), PATCH_LEAD);
  choose(page, row(page, "A").querySelector("select.priority"), "3");
  await page.settle();
  const undo = page.$("#toast .toast-action");
  assert.equal(undo.textContent, "Undo");
  undo.click();
  await page.settle();
  assert.deepEqual(page.requests.filter((r) => r.method === "PATCH").map((r) => r.body), [
    { field: "priority", value: "3" },
    { field: "priority", value: "1" },
  ]);
  assert.equal(row(page, "A").querySelector("select.priority").value, "1");
});

test("an undo window of 0 shows no Undo", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])], settings: { undoSeconds: 0 } }), PATCH_LEAD);
  choose(page, row(page, "A").querySelector("select.priority"), "3");
  await page.settle();
  assert.equal(page.$("#toast .toast-action"), null);
});

test("with Confirm before writing on, a declined bulk change writes nothing", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])], settings: { confirmBulk: true } }), PATCH_LEAD);
  let asked = "";
  page.window.confirm = (msg) => ((asked = msg), false);
  check(page, "A");
  choose(page, page.$("#bulk-priority"), "3");
  await page.settle();
  assert.match(asked, /Priority 3 on 1 lead/);
  assert.equal(page.requests.filter((r) => r.method === "PATCH").length, 0);
});

test("done toasts can be turned off; errors still show", async () => {
  page = await boot(appState({ settings: { doneToasts: false } }), { "POST /api/sync": () => ({ ok: true }) });
  page.$("#sync-btn").click();
  await page.settle();
  assert.equal(page.$("#toast").hidden, true);
});

test("auto-sync on page open syncs once", async () => {
  page = await boot(appState({ settings: { autoSync: "open" } }), { "POST /api/sync": () => ({ ok: true }) });
  assert.equal(page.requests.filter((r) => r.url === "/api/sync").length, 1);
});

test("timed auto-sync syncs when the last sync is older than the interval, and not otherwise", async () => {
  const routes = { "POST /api/sync": () => ({ ok: true }) };
  const stateWith = (at) => ({ ...appState({ settings: { autoSync: "15" } }), lastSync: { at, ok: true, apiCalls: 1 } });
  page = await boot(stateWith(Date.now() - 20 * 60_000), routes);
  assert.equal(page.requests.filter((r) => r.url === "/api/sync").length, 1);
  page.close();
  page = await boot(stateWith(Date.now() - 60_000), routes);
  assert.equal(page.requests.filter((r) => r.url === "/api/sync").length, 0);
});

test("a toast without an Undo button has no stray text", async () => {
  page = await boot(appState(), { "POST /api/sync": () => ({ ok: true }) });
  page.$("#sync-btn").click();
  await page.settle();
  assert.doesNotMatch(page.$("#toast").textContent, /null/);
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

test("turning off Show Starred section greys out the other Starred settings", async () => {
  const st = appState({ sources: [source("a", [lead()])], settings: { showStarred: false } });
  page = await boot(st, { "PATCH /api/settings": (body) => ({ ...st.settings, ...body }) });
  page.$("#settings-btn").click();
  const sub = ["allowStarring", "starMode", "starredLayout", "starredColor"].map((k) => page.$(`[data-setting="${k}"]`));
  assert.ok(sub.every((input) => input.disabled && input.closest(".setting").classList.contains("disabled")));
  assert.equal(page.$('[data-setting="showStarred"]').disabled, false);

  const show = page.$('[data-setting="showStarred"]');
  show.checked = true;
  show.dispatchEvent(new page.window.Event("change"));
  await page.settle();
  assert.ok(sub.every((input) => !input.disabled && !input.closest(".setting").classList.contains("disabled")));
});

// --- Custom email bodies ------------------------------------------------------------

test("a saved email can be picked when drafting, and its id is sent to the server", async () => {
  const leads = [lead({ businessName: "A" })];
  const settings = { draftSignOff: "Thanks,\nSam", draftTemplates: [{ id: "t1", name: "Second nudge", body: "Checking in." }] };
  page = await boot(appState({ sources: [source("a", leads)], settings }), { "POST /api/drafts/generate": () => [] });
  check(page, "A");
  page.$("#draft-btn").click();
  assert.equal(page.$("#draft-template-field").hidden, false);
  assert.deepEqual(optionValues(page.$("#draft-template")), ["", "t1"]);
  choose(page, page.$("#draft-template"), "t1");
  assert.match(page.$("#draft-template-note").textContent, /“Second nudge” exactly as saved, then your sign-off/);
  page.$("#draft-generate").click();
  await page.settle();
  assert.equal(page.requests.find((r) => r.url === "/api/drafts/generate").body.templateId, "t1");
});

test("the Email body picker is hidden with no saved emails, and drafting sends no template", async () => {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])] }), { "POST /api/drafts/generate": () => [] });
  check(page, "A");
  page.$("#draft-btn").click();
  assert.equal(page.$("#draft-template-field").hidden, true);
  page.$("#draft-generate").click();
  await page.settle();
  assert.equal(page.requests.find((r) => r.url === "/api/drafts/generate").body.templateId, undefined);
});

test("Settings adds a custom email body without touching an unsaved edit in another", async () => {
  const existing = { id: "t1", name: "First", body: "One." };
  page = await boot(appState({ settings: { draftTemplates: [existing] } }), {
    "PATCH /api/settings": (body) => ({ ...appState().settings, draftTemplates: body.draftTemplates.map((t, i) => ({ ...t, id: t.id || `new${i}` })) }),
  });
  page.$("#settings-btn").click();
  assert.equal(page.$(".template-card .template-form").hidden, true);
  assert.equal(page.$(".template-card .template-name").textContent, "First");
  [...page.$(".template-card").querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
  const first = page.$(".template-card textarea");
  first.value = "One, edited but not saved.";
  first.dispatchEvent(new page.window.Event("input"));
  page.$("#template-add").click();
  const card = page.$$(".template-card")[1];
  card.querySelector("input").value = "Second";
  card.querySelector("textarea").value = "Two.";
  card.querySelector("textarea").dispatchEvent(new page.window.Event("input"));
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
  await page.settle();
  const patch = page.requests.find((r) => r.method === "PATCH");
  assert.deepEqual(patch.body.draftTemplates, [existing, { name: "Second", body: "Two." }]);
  assert.equal(first.value, "One, edited but not saved.");
  assert.equal(card.querySelector(".template-form").hidden, true);
  assert.equal(card.querySelector(".template-summary").hidden, false);
  assert.equal(card.querySelector(".template-name").textContent, "Second");
  assert.match(card.querySelector(".template-badge").textContent, /Saved/);
});

// --- Hard reset ------------------------------------------------------------

async function openResetConfirm(routes = {}) {
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])] }), routes);
  page.$("#settings-btn").click();
  page.$("#reset-btn").click();
  await page.settle();
  return page;
}

test("Hard reset asks first, and No leaves everything alone", async () => {
  page = await openResetConfirm();
  assert.equal(page.$("#reset-dialog").open, true);
  page.$("#reset-no").click();
  await page.settle();
  assert.equal(page.$("#reset-dialog").open, false);
  assert.equal(page.requests.filter((r) => r.url === "/api/reset").length, 0);
});

test("Yes runs the hard reset, then reloads the leads", async () => {
  page = await openResetConfirm({ "POST /api/reset": () => ({ ok: true }) });
  const loadsBefore = page.requests.filter((r) => r.url === "/api/state").length;
  page.$("#reset-yes").click();
  await page.settle();
  assert.equal(page.$("#reset-dialog").open, false);
  assert.equal(page.requests.filter((r) => r.method === "POST" && r.url === "/api/reset").length, 1);
  assert.ok(page.requests.filter((r) => r.url === "/api/state").length > loadsBefore);
  assert.equal(page.$("#reset-btn").disabled, false);
  assert.match(page.$("#toast").textContent, /Hard reset finished/);
});

test("a failed hard reset says why", async () => {
  page = await openResetConfirm({
    "POST /api/reset": () => {
      throw { status: 400, error: "Google sign-in for work has expired" };
    },
  });
  page.$("#reset-yes").click();
  await page.settle();
  assert.match(page.$("#toast").textContent, /Hard reset failed.*expired/);
  assert.equal(page.$("#reset-btn").disabled, false);
});

test("while a hard reset runs, its button and Sync are disabled", async () => {
  let release;
  page = await openResetConfirm({ "POST /api/reset": () => new Promise((r) => (release = () => r({ ok: true }))) });
  page.$("#reset-yes").click();
  await page.settle();
  assert.equal(page.$("#reset-btn").disabled, true);
  assert.match(page.$("#reset-btn").textContent, /Resetting/);
  assert.equal(page.$("#sync-btn").disabled, true);
  release();
  await page.settle();
  assert.equal(page.$("#reset-btn").disabled, false);
  assert.equal(page.$("#reset-btn").textContent, "Hard reset");
  assert.equal(page.$("#sync-btn").disabled, false);
});

test("Hard reset doesn't ask while a sync is running", async () => {
  let release;
  page = await boot(appState({ sources: [source("a", [lead({ businessName: "A" })])] }), {
    "POST /api/sync": () => new Promise((r) => (release = () => r({ ok: true }))),
  });
  page.$("#sync-btn").click();
  await page.settle();
  page.$("#settings-btn").click();
  page.$("#reset-btn").click();
  await page.settle();
  assert.equal(page.$("#reset-dialog").open, false);
  assert.match(page.$("#toast").textContent, /A sync is running/);
  release();
  await page.settle();
  assert.equal(page.requests.filter((r) => r.url === "/api/reset").length, 0);
});

test("a hard reset whose sync reported problems says so", async () => {
  page = await openResetConfirm({ "POST /api/reset": () => ({ ok: false }) });
  page.$("#reset-yes").click();
  await page.settle();
  assert.match(page.$("#toast").textContent, /Hard reset finished with errors/);
});
