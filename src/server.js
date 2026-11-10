import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { BUILT_IN_STATUSES, PRIORITY_LABELS, ROOT, SERVER_PID_PATH, dropStarsFor, getSource, loadStars, setStar, starKey, loadSettings, loadSources, reorderSources, saveSettings, saveSources, statusesFor, updateSource } from "./config.js";
import { withSheetLock } from "./lock.js";
import { getDb } from "./db.js";
import { CallCounter, explainGoogleError, getAccountInfo, getConnectedAliases, sheetsClientFor } from "./google.js";
import { listTabs, parseSheetDate, spreadsheetIdFrom } from "./sheets.js";
import { runSync } from "./sync.js";
import { setLeadField } from "./edits.js";
import { generateDrafts, saveDraft } from "./drafts.js";
import { readChanges, undoChange } from "./changes.js";
import { addContact, dismissContact, listNewContacts } from "./contacts.js";
import { checkSignins, refreshSignin } from "./signins.js";

const settings = loadSettings();
const app = express();
app.use(express.json({ limit: "1mb" }));

// This server can write to your sheets and Gmail drafts, so only this page
// may call it: requests must come to localhost (blocks DNS rebinding) and
// write requests must carry a header a cross-site form can't set.
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host)) return res.status(403).send("Forbidden");
  if (req.method !== "GET" && req.headers["x-dashboard"] !== "1") return res.status(403).json({ error: "Forbidden" });
  next();
});

app.use(express.static(path.join(ROOT, "public")));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || String(err) });
  }
};

function leadView(l, stars = new Set(loadStars().map((s) => starKey(s.source, s.tab, s.email)))) {
  return {
    id: l.id,
    starred: stars.has(starKey(l.source_id, l.tab, l.email)),
    tab: l.tab,
    row: l.row_number,
    email: l.email,
    emails: l.all_emails ? l.all_emails.split(",") : [l.email],
    businessName: l.business_name,
    priority: l.priority,
    followUpStatus: l.follow_up_status || "",
    notes: l.notes,
    // Everything below is what the sheet holds, as of the last sync's
    // read-and-write; Gmail reaches the dashboard only through the sheet.
    draftId: l.draft_id,
    lastEmailAt: parseSheetDate(l.sheet_last_email),
    lastEmailDir: ["sent", "received"].includes(l.sheet_last_dir) ? l.sheet_last_dir : null,
    lastFollowedUpAt: parseSheetDate(l.sheet_last_followed),
    gmailChecked: Boolean(l.gmail_checked),
  };
}

app.get(
  "/api/state",
  wrap(() => {
    const db = getDb();
    const stars = new Set(loadStars().map((s) => starKey(s.source, s.tab, s.email)));
    const sources = loadSources().map((s) => ({
      id: s.id,
      name: s.name,
      account: s.account,
      spreadsheetId: s.spreadsheetId,
      tabs: s.tabs,
      statuses: statusesFor(s),
      customStatuses: s.customStatuses || [],
      tabState: db.prepare("SELECT tab, ok, problem, row_count AS rowCount FROM tab_state WHERE source_id = ?").all(s.id),
      leads: db.prepare("SELECT * FROM leads WHERE source_id = ?").all(s.id).map((l) => leadView(l, stars)),
    }));
    const last = db.prepare("SELECT * FROM sync_log WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    const current = loadSettings();
    return {
      sources,
      builtInStatuses: BUILT_IN_STATUSES,
      priorityLabels: PRIORITY_LABELS,
      accounts: getConnectedAliases().map((a) => ({ alias: a, email: getAccountInfo(a).email })),
      newContacts: listNewContacts(),
      lastSync: last ? { at: last.finished_at, ok: Boolean(last.ok), apiCalls: last.api_calls, ...JSON.parse(last.summary || "{}") } : null,
      settings: settingsView(current),
    };
  })
);

// --- Settings -----------------------------------------------------------

function settingsView(s) {
  return {
    writeBack: Boolean(s.writeBack),
    createDrafts: Boolean(s.createDrafts),
    drafter: s.drafter,
    drafterModel: s.drafterModel || "",
    draftBatchSize: s.draftBatchSize,
    port: s.port,
    showStarred: s.showStarred !== false,
    allowStarring: s.allowStarring !== false,
    starMode: s.starMode,
    starredLayout: s.starredLayout,
    starredColor: s.starredColor,
    palette: s.palette,
    accentColor: s.accentColor || "",
    dueSoonDays: s.dueSoonDays,
    overdueDays: s.overdueDays,
    followUpBy: s.followUpBy,
    autoSync: s.autoSync,
    draftTone: s.draftTone || "",
    draftSignOff: s.draftSignOff || "",
    draftAboutMe: s.draftAboutMe || "",
    draftTemplates: s.draftTemplates || [],
    density: s.density,
    dateFormat: s.dateFormat,
    fontSize: s.fontSize,
    hiddenColumns: s.hiddenColumns || [],
    overdueColor: s.overdueColor || "",
    dueSoonColor: s.dueSoonColor || "",
    defaultSort: s.defaultSort,
    showClosedDefault: Boolean(s.showClosedDefault),
    sectionsStart: s.sectionsStart,
    toastSeconds: s.toastSeconds,
    doneToasts: s.doneToasts !== false,
    confirmBulk: Boolean(s.confirmBulk),
    undoSeconds: s.undoSeconds,
    // The port this server is listening on; a new one applies after a restart.
    runningPort: settings.port,
  };
}

// Waits for a running sync, so writeBack can't flip partway through one.
app.patch(
  "/api/settings",
  wrap((req) => withSheetLock(() => settingsView(saveSettings(req.body))))
);

app.post("/api/sync", wrap(() => runSync()));

app.patch(
  "/api/leads/:id",
  wrap(async (req) => {
    const lead = await setLeadField(Number(req.params.id), req.body.field, req.body.value);
    return leadView(lead);
  })
);

// Stars only touch config/stars.json, never the sheet, so there's no need to
// wait for a sync.
app.put(
  "/api/leads/:id/star",
  wrap((req) => {
    if (typeof req.body.starred !== "boolean") throw new Error("starred must be true or false");
    const l = getDb().prepare("SELECT source_id, tab, email FROM leads WHERE id = ?").get(Number(req.params.id));
    if (!l) throw new Error("That row is no longer in the dashboard. Reload the page.");
    setStar({ source: l.source_id, tab: l.tab, email: l.email }, req.body.starred);
    return { starred: req.body.starred };
  })
);

// --- Sources ------------------------------------------------------------

app.post(
  "/api/sources/inspect",
  wrap(async (req) => {
    const spreadsheetId = spreadsheetIdFrom(req.body.url);
    if (!spreadsheetId) throw new Error("That doesn't look like a Google Sheets link");
    const account = getAccountInfo(req.body.account).alias;
    try {
      const info = await listTabs(sheetsClientFor(account), spreadsheetId, new CallCounter());
      return { spreadsheetId, ...info };
    } catch (err) {
      throw new Error(explainGoogleError(err, account));
    }
  })
);

function slug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source";
  const taken = new Set(loadSources().map((s) => s.id));
  let id = base;
  while (taken.has(id)) id = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  return id;
}

function validTabs(tabs) {
  if (!Array.isArray(tabs) || !tabs.length || !tabs.every((t) => typeof t === "string" && t)) {
    throw new Error("Pick at least one tab");
  }
  return [...new Set(tabs)];
}

app.post(
  "/api/sources",
  wrap((req) => {
    const { name, url, account, tabs } = req.body;
    if (!name?.trim()) throw new Error("Give the section a name");
    const spreadsheetId = spreadsheetIdFrom(url);
    if (!spreadsheetId) throw new Error("That doesn't look like a Google Sheets link");
    const source = {
      id: slug(name),
      name: name.trim(),
      spreadsheetId,
      account: getAccountInfo(account).alias,
      tabs: validTabs(tabs),
      customStatuses: [],
    };
    saveSources([...loadSources(), source]);
    return source;
  })
);

app.put(
  "/api/sources/order",
  wrap((req) => reorderSources(req.body.ids).map((s) => s.id))
);

app.patch(
  "/api/sources/:id",
  wrap((req) => {
    const change = {};
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) throw new Error("Name can't be empty");
      change.name = String(req.body.name).trim();
    }
    if (req.body.tabs !== undefined) change.tabs = validTabs(req.body.tabs);
    return updateSource(req.params.id, change);
  })
);

app.delete(
  "/api/sources/:id",
  wrap((req) => {
    getSource(req.params.id);
    saveSources(loadSources().filter((s) => s.id !== req.params.id));
    // Only the dashboard's cached copy goes; the spreadsheet is untouched.
    getDb().prepare("DELETE FROM leads WHERE source_id = ?").run(req.params.id);
    getDb().prepare("DELETE FROM tab_state WHERE source_id = ?").run(req.params.id);
    dropStarsFor(req.params.id);
    return { ok: true };
  })
);

app.post(
  "/api/sources/:id/statuses",
  wrap((req) => {
    const source = getSource(req.params.id);
    const name = String(req.body.name || "").trim();
    if (!name) throw new Error("Status name can't be empty");
    if (name.length > 40) throw new Error("Keep status names under 40 characters");
    if (statusesFor(source).some((s) => s.toLowerCase() === name.toLowerCase())) throw new Error("That status already exists");
    return updateSource(source.id, { customStatuses: [...(source.customStatuses || []), name] });
  })
);

app.delete(
  "/api/sources/:id/statuses/:name",
  wrap((req) => {
    const source = getSource(req.params.id);
    const inUse = getDb()
      .prepare("SELECT COUNT(*) AS n FROM leads WHERE source_id = ? AND lower(follow_up_status) = lower(?)")
      .get(source.id, req.params.name).n;
    if (inUse) throw new Error(`${inUse} row(s) still use "${req.params.name}". Change them first.`);
    return updateSource(source.id, {
      customStatuses: (source.customStatuses || []).filter((s) => s.toLowerCase() !== req.params.name.toLowerCase()),
    });
  })
);

// --- New contacts & change log ------------------------------------------

app.post(
  "/api/contacts/add",
  wrap((req) => addContact({ email: req.body.email, sourceId: req.body.sourceId, tab: req.body.tab, businessName: req.body.businessName }))
);

app.post("/api/contacts/dismiss", wrap((req) => dismissContact(String(req.body.account || ""), String(req.body.email || ""))));

app.get("/api/changes", wrap((req) => readChanges({ limit: Math.min(Number(req.query.limit) || 300, 2000) })));

app.post("/api/changes/:id/undo", wrap((req) => undoChange(req.params.id)));

// --- Google sign-ins ------------------------------------------------------

app.get("/api/signins", wrap(() => checkSignins()));

// Waits while you sign in in the browser (up to 5 minutes).
app.post("/api/signins/:alias/refresh", wrap((req) => refreshSignin(req.params.alias)));

// --- Drafts -------------------------------------------------------------

app.post(
  "/api/drafts/generate",
  wrap((req) => {
    const ids = req.body.leadIds;
    if (!Array.isArray(ids) || !ids.length) throw new Error("Tick at least one row");
    if (ids.length > 40) throw new Error("Draft up to 40 at a time");
    return generateDrafts(ids.map(Number), String(req.body.instructions || ""), req.body.templateId ? String(req.body.templateId) : null);
  })
);

app.post(
  "/api/drafts/save",
  wrap((req) => saveDraft(Number(req.body.leadId), { subject: req.body.subject, body: req.body.body }))
);

app.listen(settings.port, "127.0.0.1", () => {
  // Lets npm run rebuild see that the server is running (see rebuild.js).
  fs.mkdirSync(path.dirname(SERVER_PID_PATH), { recursive: true });
  fs.writeFileSync(SERVER_PID_PATH, `${process.pid}\n`);
  console.log(`Leads dashboard: http://localhost:${settings.port}`);
});

// Only removes the file if it's still this process's (a newer server may
// have replaced it).
process.on("exit", () => {
  try {
    if (fs.readFileSync(SERVER_PID_PATH, "utf8").trim() === String(process.pid)) fs.rmSync(SERVER_PID_PATH);
  } catch {
    /* already gone */
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
