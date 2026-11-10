const $ = (sel, root = document) => root.querySelector(sel);
const DAY = 86_400_000;
const SHORT_PRIORITY = { 3: "Overdue", 2: "Due soon", 1: "Too recent", 0: "No action" };
const isClosed = (status) => /^closed\b/i.test(String(status || "").trim());

let state = null;
const selected = new Set();
let bulkBusy = false; // a selection-bar edit is running
const collapsed = new Set(JSON.parse(safeGet("collapsed") || "[]"));

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window etc. - just don't remember */
  }
}

// --- Theme ------------------------------------------------------------------

// Follows the system until you pick one; the choice is remembered in this
// browser (index.html applies it before the page paints).
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");

function renderThemeButton() {
  const btn = $("#theme-btn");
  const next = currentTheme() === "dark" ? "light" : "dark";
  btn.textContent = next === "dark" ? "☾ Dark mode" : "☀ Light mode";
  btn.setAttribute("aria-label", `Switch to ${next} mode`);
}

$("#theme-btn").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  safeSet("theme", next);
  renderThemeButton();
});
systemDark.addEventListener("change", renderThemeButton);
renderThemeButton();

// --- Appearance -------------------------------------------------------------

// Palette, colors, density, text size and hidden columns come from
// settings.json. They're also remembered in this browser ("look") so
// index.html can apply them before the page paints.
function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? "#15162a" : "#ffffff";
}

function lookFor(s) {
  const data = {};
  const vars = {};
  if (s.palette && s.palette !== "periwinkle") data.palette = s.palette;
  if (s.accentColor) {
    data.accent = "custom";
    vars["--accent-custom"] = s.accentColor;
    vars["--accent-custom-text"] = readableOn(s.accentColor);
  }
  if (s.overdueColor) {
    data.overdue = "custom";
    vars["--overdue-custom"] = s.overdueColor;
  }
  if (s.dueSoonColor) {
    data.dueSoon = "custom";
    vars["--due-soon-custom"] = s.dueSoonColor;
  }
  if (s.density === "compact") data.density = "compact";
  if (s.fontSize && s.fontSize !== "normal") data.font = s.fontSize;
  if (s.hiddenColumns?.length) data.hide = s.hiddenColumns.join(" ");
  return { data, vars };
}

const LOOK_KEYS = ["palette", "accent", "overdue", "dueSoon", "density", "font", "hide"];
const LOOK_VARS = ["--accent-custom", "--accent-custom-text", "--overdue-custom", "--due-soon-custom"];

function applyAppearance(s) {
  const root = document.documentElement;
  const { data, vars } = lookFor(s);
  for (const k of LOOK_KEYS) {
    if (data[k]) root.dataset[k] = data[k];
    else delete root.dataset[k];
  }
  for (const v of LOOK_VARS) {
    if (vars[v]) root.style.setProperty(v, vars[v]);
    else root.style.removeProperty(v);
  }
  safeSet("look", JSON.stringify({ data, vars }));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Dashboard": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
function ago(ms) {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(ms);
}

// --- Loading & sync -------------------------------------------------------

let firstLoad = true;

// Settings that only apply when the page opens.
function applyStartupSettings() {
  firstLoad = false;
  $("#show-closed").checked = state.settings.showClosedDefault;
  startAutoSync();
}

async function load() {
  state = await api("GET", "/api/state");
  applyAppearance(state.settings);
  if (firstLoad) applyStartupSettings();
  render();
}

// --- Toast ----------------------------------------------------------------

let toastTimer;
const TOAST_ICONS = {
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 4v5"/><path d="M8 12h.01"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 7v5"/><path d="M8 4h.01"/></svg>',
};

// A modal dialog sits in the browser's top layer, above any z-index, so a
// toast in <body> would show behind it. Keep the toast inside the topmost
// open modal (or <body> when none is open).
function toastHost() {
  return [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal")).at(-1) || document.body;
}
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("close", () => {
    const node = $("#toast");
    if (d.contains(node)) toastHost().append(node);
  })
);

// title: the short headline; detail: an optional second line.
// action: { label, run } adds a button (Undo); seconds overrides how long it stays.
function toast(title, { detail = "", kind = "", sticky = false, action = null, seconds = null } = {}) {
  const node = $("#toast");
  // "Done" confirmations can be turned off in Settings; hiding the node also
  // clears a "Syncing…" toast the confirmation would have replaced.
  if (kind === "done" && !action && state?.settings && state.settings.doneToasts === false) {
    clearTimeout(toastTimer);
    node.hidden = true;
    return;
  }
  const host = toastHost();
  if (node.parentElement !== host) host.append(node);
  clearTimeout(toastTimer);
  node.className = `toast${kind ? ` ${kind}` : ""}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  const icon = el("span", { class: "toast-icon", "aria-hidden": "true" });
  if (kind === "busy") icon.append(el("span", { class: "spinner" }));
  else icon.innerHTML = TOAST_ICONS[kind] || TOAST_ICONS.info;
  const close = el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss" }, "×");
  close.addEventListener("click", () => {
    clearTimeout(toastTimer);
    node.hidden = true;
  });
  let actionBtn = null;
  if (action) {
    actionBtn = el("button", { class: "toast-action", type: "button" }, action.label);
    actionBtn.addEventListener("click", () => {
      clearTimeout(toastTimer);
      node.hidden = true;
      action.run();
    });
  }
  node.replaceChildren(
    icon,
    el("div", { class: "toast-body" }, el("div", { class: "toast-title" }, title), detail ? el("div", { class: "toast-detail" }, detail) : ""),
    ...(actionBtn ? [actionBtn] : []),
    close
  );
  // Re-run the entrance animation for each new toast.
  node.hidden = true;
  void node.offsetWidth;
  node.hidden = false;
  const ms = (seconds ?? state?.settings?.toastSeconds ?? 6) * 1000;
  if (!sticky) toastTimer = setTimeout(() => (node.hidden = true), ms);
}

// Anything that syncs writes to the sheets by row number, so editing rows
// mid-sync could put a write on the wrong row: say so for the duration.
// Dashboard edits and saved drafts wait for the sync to finish.
async function withSyncToast(fn) {
  toast("Syncing…", { detail: "Don't edit the spreadsheet or draft emails until this finishes.", kind: "busy", sticky: true });
  try {
    const result = await fn();
    const r = result?.sync || result;
    if (r && r.ok === false) toast("Sync finished with errors", { detail: "See the banner for details. It's safe to edit the spreadsheet.", kind: "error" });
    else toast("Sync finished", { detail: "It's safe to edit the spreadsheet.", kind: "done" });
    return result;
  } catch (err) {
    toast("Sync stopped", { detail: err.message, kind: "error" });
    throw err;
  }
}

let syncing = false;

async function sync() {
  if (syncing) return;
  syncing = true;
  const btn = $("#sync-btn");
  btn.disabled = true;
  btn.replaceChildren(el("span", { class: "spinner" }), " Syncing");
  try {
    await withSyncToast(() => api("POST", "/api/sync"));
  } catch (err) {
    showBanner(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync";
    syncing = false;
  }
  await load();
}

// Auto-sync (Settings → Sync). Timed syncs run only while the page is
// visible, and wait while a dialog is open or an edit is running, so a sync
// never starts under someone mid-change.
let autoSyncTimer = null;
let lastAutoAttempt = 0;
const autoSyncMinutes = () => Number(state?.settings?.autoSync) || 0;

function startAutoSync() {
  clearInterval(autoSyncTimer);
  autoSyncTimer = null;
  if (state.settings.autoSync === "open") {
    lastAutoAttempt = Date.now();
    sync();
    return;
  }
  if (!autoSyncMinutes()) return;
  autoSyncTimer = setInterval(maybeAutoSync, 60_000);
  maybeAutoSync();
}

function maybeAutoSync() {
  const minutes = autoSyncMinutes();
  if (!minutes || syncing || bulkBusy || document.hidden || document.querySelector("dialog[open]")) return;
  const every = minutes * 60_000;
  const last = Math.max(state.lastSync?.at || 0, lastAutoAttempt);
  if (Date.now() - last < every) return;
  lastAutoAttempt = Date.now();
  sync();
}
document.addEventListener("visibilitychange", () => state && maybeAutoSync());

let transientBanner = null;
function showBanner(message, isError) {
  transientBanner = { message, isError };
  renderBanners();
}

// A warning banner with a close button. Dismissing only hides it until the
// next render, so it shows again after a reload or sync.
function dismissibleBanner(text) {
  const node = el("div", { class: "banner dismissible" }, el("span", {}, text));
  node.append(el("button", { class: "banner-close", type: "button", "aria-label": "Dismiss", title: "Dismiss", onclick: () => node.remove() }, "×"));
  return node;
}

function renderBanners() {
  const box = $("#banners");
  box.replaceChildren();
  if (transientBanner) {
    box.append(el("div", { class: `banner${transientBanner.isError ? " error" : ""}` }, transientBanner.message));
  }
  const s = state?.settings;
  if (s && (!s.writeBack || !s.createDrafts)) {
    const off = [!s.writeBack && "writing to spreadsheets", !s.createDrafts && "saving Gmail drafts"].filter(Boolean);
    box.append(dismissibleBanner(`Turned off: ${off.join(" and ")}. The dashboard is read-only for those until you switch them on in Settings.`));
  }
  const last = state?.lastSync;
  if (last?.errors?.length) {
    box.append(el("div", { class: "banner error" }, "Last sync had errors:", el("ul", {}, last.errors.map((e) => el("li", {}, e)))));
  }
}

function renderSyncStatus() {
  const last = state.lastSync;
  const node = $("#sync-status");
  if (!last) return (node.textContent = "Not synced yet");
  const bits = [`Synced ${relTime(last.at)}`, `${last.apiCalls} API call${last.apiCalls === 1 ? "" : "s"}`];
  const changed = (last.sheetRowsChanged || 0) + (last.gmailLeadsChanged || 0);
  bits.push(changed ? `${changed} change${changed === 1 ? "" : "s"}` : "no changes");
  if (last.cellsWritten) bits.push(`${last.cellsWritten} cell${last.cellsWritten === 1 ? "" : "s"} written`);
  if (last.writesHeld) bits.push(`${last.writesHeld} cell update${last.writesHeld === 1 ? "" : "s"} held`);
  node.textContent = bits.join(" · ");
}

// --- Filters & sorting ----------------------------------------------------

function filters() {
  return {
    q: $("#search").value.trim().toLowerCase(),
    status: $("#filter-status").value,
    priority: $("#filter-priority").value,
    turn: $("#filter-turn").value,
    showClosed: $("#show-closed").checked,
  };
}

function matches(lead, f) {
  if (!f.showClosed && isClosed(lead.followUpStatus) && !isClosed(f.status)) return false;
  if (f.q && !`${lead.businessName} ${lead.emails.join(" ")}`.toLowerCase().includes(f.q)) return false;
  if (f.status && lead.followUpStatus.toLowerCase() !== f.status.toLowerCase()) return false;
  if (f.priority === "none" && lead.priority != null) return false;
  if (f.priority && f.priority !== "none" && String(lead.priority) !== f.priority) return false;
  if (f.turn === "none" && lead.lastEmailAt) return false;
  if ((f.turn === "sent" || f.turn === "received") && lead.lastEmailDir !== f.turn) return false;
  return true;
}

// What each row needs from you next, most pressing first.
const ACTIONS = [
  { key: "reply", label: "Reply", title: "They replied and you haven't drafted an answer" },
  { key: "send", label: "Send draft", title: "A Gmail draft is waiting to be sent" },
  { key: "nudge", label: "Follow up", title: "Waiting on them and overdue (priority 3, or past the Overdue days in Settings)" },
  { key: "first", label: "First email", title: "Never emailed" },
  { key: "wait", label: "Waiting", title: "You sent last; waiting on their reply" },
  { key: "none", label: "No action", title: "Closed, confirmed or priority 0" },
];

// Days since the last email, by Settings → Follow-up timing.
const daysSince = (ms) => (Date.now() - ms) / DAY;
const timingOf = (ms) => {
  const days = daysSince(ms);
  return days > state.settings.overdueDays ? "overdue" : days > state.settings.dueSoonDays ? "due" : "recent";
};

function nextAction(l) {
  const none = isClosed(l.followUpStatus) || /^confirmed$/i.test(l.followUpStatus.trim()) || l.priority === 0;
  // What's left after reply / draft / never-emailed is "you sent last".
  const nudge = l.priority === 3 || (state.settings.followUpBy === "timing" && l.lastEmailAt && timingOf(l.lastEmailAt) === "overdue");
  const i = none ? 5 : l.lastEmailDir === "received" && !l.draftId ? 0 : l.draftId ? 1 : !l.lastEmailAt ? 3 : nudge ? 2 : 4;
  return { rank: i, ...ACTIONS[i] };
}

// Settings → Sort rows by. Every order falls back to sheet row order.
const byAction = (a, b) => nextAction(a).rank - nextAction(b).rank;
const byPriority = (a, b) => (b.priority ?? -1) - (a.priority ?? -1);
const SORTS = {
  // By next action, then priority (3 first, blank last).
  action: [byAction, byPriority],
  priority: [byPriority, byAction],
  // Oldest last email first; never emailed last.
  lastEmail: [(a, b) => (a.lastEmailAt ?? Infinity) - (b.lastEmailAt ?? Infinity)],
  name: [(a, b) => (a.businessName || a.email).localeCompare(b.businessName || b.email, undefined, { sensitivity: "base" })],
};

function compareLeads(a, b) {
  for (const cmp of SORTS[state.settings.defaultSort] || SORTS.action) {
    const d = cmp(a, b);
    if (d) return d;
  }
  return a.row - b.row;
}

// --- Rendering ------------------------------------------------------------

function render() {
  renderBanners();
  renderSyncStatus();

  const statusFilter = $("#filter-status");
  const current = statusFilter.value;
  const all = new Map();
  for (const s of state.sources) for (const st of s.statuses) all.set(st.toLowerCase(), st);
  statusFilter.replaceChildren(el("option", { value: "" }, "All statuses"), el("option", { value: "__none" }, "No status"));
  for (const st of all.values()) statusFilter.append(el("option", { value: st }, st));
  statusFilter.value = [...statusFilter.options].some((o) => o.value === current) ? current : "";

  const main = $("#sections");
  main.replaceChildren();
  if (!state.sources.length) {
    main.append(el("p", { class: "muted" }, "No sections yet. Use “Add section” to connect a spreadsheet."));
  }
  const f = filters();
  for (const source of state.sources) main.append(renderSource(source, f));
  renderStarred(f);
  renderNewContacts();
  renderActionBar();
}

// --- Starred ----------------------------------------------------------------

// Stars are the dashboard's own marks (config/stars.json); the sheet never
// sees them. In "move" mode a starred row leaves its own section, but only
// while Starred is shown, so it can't end up hidden everywhere.
const movesStarred = () => state.settings.showStarred && state.settings.starMode === "move";

function renderStarred(f) {
  const box = $("#starred");
  box.replaceChildren();
  if (!state.settings.showStarred) return;
  const entries = state.sources.flatMap((source) => source.leads.filter((l) => l.starred).map((lead) => ({ source, lead })));
  const counts = el("span", { class: "counts" });
  const head = el(
    "header",
    { class: "source-head", title: "Click to open or close" },
    el("button", { class: "collapse icon", "aria-label": "Open or close Starred" }, "▾"),
    el("h2", { class: "source-name" }, "★ Starred"),
    el("span", { class: "source-meta muted" }, `${entries.length} row${entries.length === 1 ? "" : "s"} · kept in the dashboard, not the spreadsheet`),
    el("span", { class: "spacer" }),
    counts
  );
  const body = el("div", { class: "tabs" });
  const color = state.settings.starredColor;
  const node = el("section", { class: `source starred${color && color !== "default" ? ` c-${color}` : ""}` }, head, body);
  renderCounts(counts, entries.map((e) => e.lead));
  makeCollapsible(node, head, "__starred");

  if (!entries.length) {
    body.append(
      el(
        "p",
        { class: "empty muted" },
        state.settings.allowStarring ? "Nothing starred yet. Click ☆ next to a business to pin it here." : "Nothing starred yet. Turn on Allow starring in Settings to star rows."
      )
    );
  } else if (state.settings.starredLayout === "labels") {
    body.append(leadSubsection("", "", entries, f, { flat: true, label: true }));
  } else {
    // One subsection per sheet tab, in section order, then tab order.
    for (const source of state.sources) {
      const tabs = [...source.tabs];
      for (const e of entries) if (e.source === source && !tabs.includes(e.lead.tab)) tabs.push(e.lead.tab);
      for (const tab of tabs) {
        const group = entries.filter((e) => e.source === source && e.lead.tab === tab);
        if (group.length) body.append(leadSubsection(`__starred\u0000${source.id}\u0000${tab}`, `${source.name} · ${tab}`, group, f, { meta: `${group.length} row${group.length === 1 ? "" : "s"}` }));
      }
    }
  }
  box.append(node);
}

async function toggleStar(lead, btn) {
  const starred = !lead.starred;
  btn.disabled = true;
  try {
    await api("PUT", `/api/leads/${lead.id}/star`, { starred });
    lead.starred = starred;
    transientBanner = null;
    if (movesStarred()) {
      const name = lead.businessName || lead.email;
      toast(starred ? `Moved ${name} to Starred` : `Moved ${name} back to ${lead.tab}`, { kind: "done" });
    }
  } catch (err) {
    showBanner(err.message, true);
  }
  render();
}

// --- People not in any sheet ----------------------------------------------

function renderNewContacts() {
  const box = $("#new-contacts");
  box.replaceChildren();
  const list = state.newContacts || [];
  if (!list.length) return;
  const node = el(
    "section",
    { class: "source new-contacts" },
    el(
      "header",
      { class: "source-head", title: "Click to open or close" },
      el("button", { class: "collapse icon", "aria-label": "Open or close list" }, "▾"),
      el("h2", { class: "source-name" }, "Not in a sheet"),
      el("span", { class: "source-meta muted" }, "People you emailed, or who emailed you, who aren't in any tab yet"),
      el("span", { class: "spacer" }),
      el("span", { class: "pill turn" }, `${list.length} to review`)
    ),
    el(
      "div",
      { class: "tabs" },
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, ["Business / person", "Last email", "Add to tab", ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, list.map(renderContactRow))
        )
      )
    )
  );
  makeCollapsible(node, $(".source-head", node), "__new-contacts");
  box.append(node);
}

function renderContactRow(c) {
  const writable = state.settings.writeBack;
  const inbox = state.accounts.find((a) => a.alias === c.account)?.email || c.account;
  const name = el("input", { value: c.name || c.email.split("@")[1], "aria-label": `Business name for ${c.email}` });
  const target = el(
    "select",
    { "aria-label": `Tab for ${c.email}` },
    state.sources
      .filter((s) => s.account === c.account)
      .flatMap((s) => s.tabs.map((t) => el("option", { value: JSON.stringify([s.id, t]) }, `${s.name} · ${t}`)))
  );
  const add = el("button", { class: "primary", disabled: !writable || !target.options.length, title: writable ? undefined : "Writing to spreadsheets is turned off in Settings" }, "Add");
  const dismiss = el("button", { title: "Hide this person from the list" }, "Dismiss");
  add.addEventListener("click", async () => {
    const [sourceId, tab] = JSON.parse(target.value);
    add.disabled = dismiss.disabled = true;
    try {
      await withSyncToast(() => api("POST", "/api/contacts/add", { email: c.email, sourceId, tab, businessName: name.value }));
      transientBanner = null;
    } catch (err) {
      showBanner(err.message, true);
    }
    await load();
  });
  dismiss.addEventListener("click", async () => {
    try {
      await api("POST", "/api/contacts/dismiss", { account: c.account, email: c.email });
    } catch (err) {
      showBanner(err.message, true);
    }
    await load();
  });
  return el(
    "tr",
    {},
    el("td", {}, name, el("div", { class: "sub" }, `${c.email} · ${c.count} email${c.count === 1 ? "" : "s"} · in ${inbox}'s inbox`)),
    el("td", { class: "when" }, fmtDate(c.lastAt), el("span", { class: `dir ${c.lastDir}` }, c.lastDir === "received" ? "they emailed" : "you sent")),
    el("td", {}, target),
    el("td", { class: "row-actions" }, add, dismiss)
  );
}

// --- History ----------------------------------------------------------------

const CHANGED_BY = { sync: "Sync", dashboard: "You, in the dashboard", "add-contact": "Added row", undo: "Undo" };

function fmtDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadHistory() {
  const box = $("#history-list");
  try {
    const entries = await api("GET", "/api/changes");
    box.replaceChildren(renderHistory(entries));
  } catch (err) {
    box.replaceChildren(el("p", { class: "error" }, err.message));
  }
}

function openHistory() {
  $("#history-list").replaceChildren(el("p", { class: "muted" }, "Loading…"));
  $("#history-dialog").showModal();
  loadHistory();
}

function renderHistory(entries) {
  if (!entries.length) return el("p", { class: "muted" }, "Nothing has been written to a spreadsheet yet.");
  const sourceName = (id) => state.sources.find((s) => s.id === id)?.name || id;
  const cell = (v) => (v ? el("code", {}, v) : el("span", { class: "muted" }, "(blank)"));
  const rows = entries.map((e) => {
    const status = e.failed
      ? el("span", { class: "error", title: typeof e.failed === "string" ? e.failed : "" }, "Write failed")
      : el("span", { class: "muted" }, e.undone ? "Undone" : "");
    const actions = el("td", { class: "row-actions" }, status);
    if (!e.undone && !e.failed && e.by !== "undo" && e.by !== "add-contact") {
      const undo = el("button", { disabled: !state.settings.writeBack }, "Undo");
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        status.textContent = "";
        try {
          await api("POST", `/api/changes/${encodeURIComponent(e.id)}/undo`);
          await loadHistory();
          await load();
        } catch (err) {
          status.replaceChildren(el("span", { class: "error" }, err.message));
          undo.disabled = false;
        }
      });
      actions.prepend(undo);
    }
    return el(
      "tr",
      {},
      el("td", { class: "when" }, fmtDateTime(e.at)),
      el("td", {}, CHANGED_BY[e.by] || e.by),
      el("td", {}, `${sourceName(e.source)} · ${e.tab} · row ${e.row}`, el("div", { class: "sub" }, e.email)),
      el("td", {}, e.column),
      el("td", {}, cell(e.old)),
      el("td", {}, cell(e.new)),
      actions
    );
  });
  return el(
    "div",
    { class: "table-wrap" },
    el("table", { class: "history" }, el("thead", {}, el("tr", {}, ["When", "By", "Where", "Column", "Old", "New", ""].map((h) => el("th", {}, h)))), el("tbody", {}, rows))
  );
}

// --- Google sign-ins ----------------------------------------------------------

function signinStatus(s) {
  if (s.status === "expired") return el("span", { class: "error" }, "Expired");
  if (s.status === "soon") return el("span", { class: "error" }, `Ends in about ${Math.max(s.hoursLeft, 1)} h`);
  if (s.status === "unknown") return el("span", { class: "muted" }, `Couldn't check: ${s.problem}`);
  const days = s.hoursLeft == null ? null : Math.floor(s.hoursLeft / 24);
  return el("span", { class: "muted" }, days == null ? "Signed in" : `Signed in · about ${days} day${days === 1 ? "" : "s"} left`);
}

// Flags the header button when an account needs signing in again.
function renderSigninsButton(signins) {
  const btn = $("#signins-btn");
  const due = signins.filter((s) => s.status === "expired" || s.status === "soon").length;
  btn.textContent = due ? `Google sign-ins · ${due} to renew` : "Google sign-ins";
  btn.classList.toggle("alert", due > 0);
}

async function checkSignins() {
  const signins = await api("GET", "/api/signins");
  renderSigninsButton(signins);
  return signins;
}

async function loadSignins() {
  const box = $("#signins-list");
  try {
    box.replaceChildren(...renderSignins(await checkSignins()));
  } catch (err) {
    box.replaceChildren(el("p", { class: "error" }, err.message));
  }
}

function openSignins() {
  $("#signins-list").replaceChildren(el("p", { class: "muted" }, "Checking each account with Google…"));
  $("#signins-dialog").showModal();
  loadSignins();
}

function renderSignins(signins) {
  if (!signins.length) return [el("p", { class: "muted" }, "No Google accounts are connected. Run setup.sh in google-mcp-accounts to connect one.")];
  return signins.map((s) => {
    const note = el("div", { class: "sub" });
    const due = s.status === "expired" || s.status === "soon";
    const btn = el("button", { class: due ? "primary" : "" }, "Sign in again");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.replaceChildren(el("span", { class: "spinner" }), " Waiting for browser");
      note.replaceChildren(`Finish signing in as ${s.email} in the browser tab that just opened.`);
      try {
        const r = await api("POST", `/api/signins/${encodeURIComponent(s.alias)}/refresh`);
        toast(`Signed in as ${r.email}`, {
          detail: r.switchedFrom ? `"${r.alias}" was ${r.switchedFrom}; it now uses ${r.email}.` : "The next sync uses the new sign-in.",
          kind: r.switchedFrom ? "error" : "done",
        });
        await loadSignins();
      } catch (err) {
        note.replaceChildren(el("span", { class: "error" }, err.message));
        btn.disabled = false;
        btn.textContent = "Sign in again";
      }
    });
    return el(
      "div",
      { class: "signin" },
      el("div", { class: "signin-who" }, el("strong", {}, s.alias), ` ${s.email}`, el("div", { class: "sub" }, signinStatus(s)), note),
      btn
    );
  });
}

// --- Settings -----------------------------------------------------------------

const settingInputs = () => [...$("#settings-dialog").querySelectorAll("[data-setting]")];
const columnBoxes = () => [...$("#column-picker").querySelectorAll("[data-column]")];

// The other Starred settings only matter while the section is shown.
const STARRED_SUBSETTINGS = ["allowStarring", "starMode", "starredLayout", "starredColor"];

function settingValue(input) {
  return input.type === "checkbox" ? input.checked : input.value;
}

function renderSettings() {
  const s = state.settings;
  for (const input of settingInputs()) {
    const value = s[input.dataset.setting] ?? "";
    if (input.type === "checkbox") input.checked = s[input.dataset.setting];
    else {
      // Keep a value set by hand in settings.json visible even when it isn't one of the options.
      if (input.tagName === "SELECT" && ![...input.options].some((o) => o.value === String(value))) {
        input.append(el("option", { value }, value));
      }
      input.value = value;
    }
    if (STARRED_SUBSETTINGS.includes(input.dataset.setting)) {
      input.disabled = !s.showStarred;
      const row = input.closest(".setting");
      row.classList.toggle("disabled", !s.showStarred);
      row.title = s.showStarred ? "" : "Turn on Show Starred section to change this";
    }
  }
  for (const wrap of colorSettings()) {
    const key = wrap.dataset.colorSetting;
    $(".swatch", wrap).style.background = s[key] || defaultColor(key);
    $(".color-name", wrap).textContent = s[key] || "Default";
  }
  for (const box of columnBoxes()) box.checked = !s.hiddenColumns.includes(box.dataset.column);
  $("#port-note").textContent = s.port === s.runningPort
    ? "A new port applies after you restart the dashboard."
    : `Running on ${s.runningPort}; restart the dashboard to move to ${s.port}.`;
}

// The light-mode color a color setting replaces, read with that custom color
// switched off.
const COLOR_TOKENS = {
  accentColor: ["accent", "--accent", "#5b5fc7"],
  overdueColor: ["overdue", "--u3", "#e5484d"],
  dueSoonColor: ["dueSoon", "--u2", "#e59a12"],
};
function defaultColor(key) {
  const [flag, token, fallback] = COLOR_TOKENS[key];
  const root = document.documentElement;
  const { theme } = root.dataset;
  const custom = root.dataset[flag];
  delete root.dataset[flag];
  root.dataset.theme = "light";
  const color = getComputedStyle(root).getPropertyValue(token).trim();
  if (custom) root.dataset[flag] = custom;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

// --- Color pickers (Settings → Colors) ---------------------------------------
// An in-page picker rather than <input type="color">: the browser's own one
// (the macOS Colors panel in Chrome) floats, doesn't close itself, and can
// report a color you never picked.

const colorSettings = () => [...$("#settings-dialog").querySelectorAll("[data-color-setting]")];
const PRESET_COLORS = ["#5b5fc7", "#1f6fa8", "#0f8a8a", "#2f7d4a", "#6a8f1f", "#c27c0e", "#e59a12", "#d9480f", "#e5484d", "#b83b62", "#8e44ad", "#3f3f4a"];
const HEX = /^#?([0-9a-f]{6})$/i;
let openPicker = null;

function closeColorPicker() {
  if (!openPicker) return;
  openPicker.pop.remove();
  openPicker.btn.setAttribute("aria-expanded", "false");
  openPicker = null;
  applyAppearance(state.settings); // drop any preview
}

function openColorPicker(wrap) {
  const key = wrap.dataset.colorSetting;
  const btn = $(".color-btn", wrap);
  const current = state.settings[key] || defaultColor(key);
  const preview = (color) => applyAppearance({ ...state.settings, [key]: color });
  const hex = el("input", { type: "text", class: "color-hex", value: current, maxlength: "7", spellcheck: "false", "aria-label": "Hex color" });
  const apply = el("button", { type: "button", class: "primary" }, "Apply");
  const error = el("span", { class: "error color-error" });
  const pick = (color) => saveColor(key, color);
  const swatches = PRESET_COLORS.map((c) => {
    const b = el("button", { type: "button", class: `color-choice${c === current ? " on" : ""}`, title: c, "aria-label": c });
    b.style.background = c;
    b.addEventListener("click", () => pick(c));
    b.addEventListener("mouseenter", () => preview(c));
    b.addEventListener("focus", () => preview(c));
    return b;
  });
  const fromHex = () => {
    const m = hex.value.trim().match(HEX);
    if (!m) return (error.textContent = "Use a hex color like #1f6fa8"), null;
    error.textContent = "";
    return `#${m[1].toLowerCase()}`;
  };
  hex.addEventListener("input", () => HEX.test(hex.value.trim()) && preview(fromHex()));
  hex.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const c = fromHex();
    if (c) pick(c);
  });
  apply.addEventListener("click", () => {
    const c = fromHex();
    if (c) pick(c);
  });
  const pop = el(
    "div",
    { class: "color-pop", role: "dialog", "aria-label": "Pick a color" },
    el("div", { class: "color-grid" }, swatches),
    el("div", { class: "color-custom" }, hex, apply),
    error,
    state.settings[key] ? el("button", { type: "button", class: "color-default", onclick: () => pick("") }, "Use default") : null
  );
  pop.addEventListener("mouseleave", () => preview(state.settings[key] || ""));
  wrap.append(pop);
  btn.setAttribute("aria-expanded", "true");
  openPicker = { wrap, btn, pop };
  (swatches.find((b) => b.classList.contains("on")) || hex).focus();
}

async function saveColor(key, color) {
  closeColorPicker();
  // Picking the color the default already is doesn't make it custom.
  const value = color && color === defaultColor(key) ? "" : color;
  if (value === (state.settings[key] || "")) return;
  settingsError("");
  try {
    state.settings = await api("PATCH", "/api/settings", { [key]: value });
  } catch (err) {
    settingsError(err.message);
  }
  applyAppearance(state.settings);
  renderSettings();
  render();
}

function settingsError(message) {
  const node = $("#settings-error");
  node.textContent = message;
  node.hidden = !message;
}

// --- Custom email bodies (Settings → Drafting) -------------------------------
// Each card saves with its own button, so half-typed edits in one card aren't
// sent (or lost) when another is saved or deleted. A saved card shows as a
// summary; Edit reopens the form.

function renderTemplates() {
  $("#template-list").replaceChildren(...(state.settings.draftTemplates || []).map((t) => templateCard(t)));
}

function templateCard(t = null) {
  const name = el("input", { value: t?.name || "", placeholder: "Name, e.g. Second nudge", maxlength: "60", "aria-label": "Custom email body name" });
  const body = el("textarea", { rows: "6", maxlength: "5000", placeholder: "The body of the email, without a greeting or sign-off.", "aria-label": "Custom email body" });
  body.value = t?.body || "";
  const save = el("button", { type: "button", class: "primary" }, "Save");
  const cancel = el("button", { type: "button" }, "Discard");
  const form = el("div", { class: "template-form" }, name, body, el("div", { class: "dialog-actions" }, cancel, el("span", { class: "spacer" }), save));

  const title = el("strong", { class: "template-name" });
  const preview = el("p", { class: "template-preview muted" });
  const edit = el("button", { type: "button" }, "Edit");
  const remove = el("button", { type: "button", class: "danger" }, "Delete");
  const summary = el(
    "div",
    { class: "template-summary" },
    el("div", { class: "template-head" }, title, el("span", { class: "template-badge" }, "✓ Saved")),
    preview,
    el("p", { class: "template-hint muted" }, "Pick it under Email body when drafting."),
    el("div", { class: "dialog-actions" }, remove, el("span", { class: "spacer" }), edit)
  );
  const card = el("div", { class: "template-card" }, summary, form);

  let saved = t;
  const dirty = () => !saved || name.value !== saved.name || body.value !== saved.body;
  const refresh = () => {
    save.disabled = !dirty() || !name.value.trim() || !body.value.trim();
  };
  const show = (editing) => {
    form.hidden = !editing;
    summary.hidden = editing;
    if (saved) {
      title.textContent = saved.name;
      preview.textContent = saved.body;
      cancel.textContent = "Cancel";
    }
    refresh();
  };
  name.addEventListener("input", refresh);
  body.addEventListener("input", refresh);
  show(!saved);

  const others = () => (state.settings.draftTemplates || []).filter((x) => x.id !== saved?.id);
  save.addEventListener("click", async () => {
    const list = state.settings.draftTemplates || [];
    const entry = { id: saved?.id, name: name.value, body: body.value };
    const next = saved ? list.map((x) => (x.id === saved.id ? entry : x)) : [...list, entry];
    const before = new Set(list.map((x) => x.id));
    if (await saveTemplates(next, save)) {
      saved = saved ? state.settings.draftTemplates.find((x) => x.id === saved.id) : state.settings.draftTemplates.find((x) => !before.has(x.id));
      name.value = saved.name;
      body.value = saved.body;
      show(false);
    } else refresh();
  });
  edit.addEventListener("click", () => {
    show(true);
    name.focus();
  });
  cancel.addEventListener("click", () => {
    if (!saved) return card.remove();
    name.value = saved.name;
    body.value = saved.body;
    show(false);
  });
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete the custom email body “${saved.name}”?`)) return;
    if (await saveTemplates(others(), remove)) card.remove();
  });
  return card;
}

async function saveTemplates(list, button) {
  settingsError("");
  button.disabled = true;
  try {
    state.settings = await api("PATCH", "/api/settings", { draftTemplates: list });
    return true;
  } catch (err) {
    settingsError(err.message);
    return false;
  } finally {
    button.disabled = false;
  }
}

function openSettings() {
  settingsError("");
  renderSettings();
  renderTemplates();
  $("#settings-dialog").showModal();
}

// Each control saves on its own as soon as it changes.
async function saveSetting(input, value = settingValue(input), key = input.dataset.setting) {
  settingsError("");
  input.disabled = true;
  input.classList.add("saving");
  try {
    state.settings = await api("PATCH", "/api/settings", { [key]: value });
    applyAppearance(state.settings);
    if (key === "autoSync") startAutoSync();
    if (key === "writeBack" || key === "createDrafts") {
      toast(`${input.closest(".setting").querySelector("strong").textContent}: ${input.checked ? "on" : "off"}`, { kind: "done" });
    }
  } catch (err) {
    settingsError(err.message);
  } finally {
    input.disabled = false;
    input.classList.remove("saving");
  }
  renderSettings();
  render();
}

function renderCounts(box, leads) {
  const open = leads.filter((l) => !isClosed(l.followUpStatus));
  box.append(el("span", { class: "pill" }, `${open.length} open`));
  const overdue = open.filter((l) => l.priority === 3).length;
  if (overdue) box.append(el("span", { class: "pill urgent" }, `${overdue} overdue`));
  const yourTurn = open.filter((l) => l.lastEmailDir === "received").length;
  if (yourTurn) box.append(el("span", { class: "pill turn" }, `${yourTurn} your turn`));
}

// Clicking anywhere on a header opens/closes it, except its other buttons.
// The open/closed state is remembered under `key`.
// Keys seen this page load, so "Sections on open" applies once per section.
const seenSections = new Set();

function makeCollapsible(node, head, key) {
  if (!seenSections.has(key)) {
    seenSections.add(key);
    if (state.settings.sectionsStart === "collapsed") collapsed.add(key);
    if (state.settings.sectionsStart === "expanded") collapsed.delete(key);
  }
  const chevron = $(".collapse", head);
  const apply = () => chevron.setAttribute("aria-expanded", String(!collapsed.has(key)));
  if (collapsed.has(key)) node.classList.add("collapsed");
  apply();
  head.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn && btn !== chevron) return;
    node.classList.toggle("collapsed");
    if (node.classList.contains("collapsed")) collapsed.add(key);
    else collapsed.delete(key);
    safeSet("collapsed", JSON.stringify([...collapsed]));
    apply();
  });
}

function renderSource(source, f) {
  const node = $("#section-tpl").content.firstElementChild.cloneNode(true);
  node.dataset.id = source.id;
  const head = $(".source-head", node);
  makeCollapsible(node, head, source.id);
  $(".source-name", node).textContent = source.name;
  const account = state.accounts.find((a) => a.alias === source.account);
  const tabCount = source.tabs.length;
  $(".source-meta", node).textContent = `${account?.email || source.account} · ${tabCount} tab${tabCount === 1 ? "" : "s"}`;
  $(".edit-source", node).addEventListener("click", () => openSourceDialog(source));
  wireReorder(node, head);
  // In move mode, starred rows show only in Starred.
  const leads = movesStarred() ? source.leads.filter((l) => !l.starred) : source.leads;
  renderCounts($(".counts", node), leads);

  // One subsection per tab, in the order the tabs sit in the spreadsheet
  // (source.tabs is saved in sheet order). Any cached rows from a tab that's
  // no longer listed go last so they're never silently hidden.
  const tabs = [...source.tabs];
  for (const l of source.leads) if (!tabs.includes(l.tab)) tabs.push(l.tab);
  const box = $(".tabs", node);
  for (const tab of tabs) box.append(renderTab(source, tab, f, leads));
  return node;
}

function renderTab(source, tab, f, sourceLeads) {
  const all = sourceLeads.filter((l) => l.tab === tab);
  const moved = source.leads.filter((l) => l.tab === tab).length - all.length;
  const ts = source.tabState.find((t) => t.tab === tab);
  const meta = ts?.ok ? `${all.length} row${all.length === 1 ? "" : "s"}${moved ? ` · ${moved} in Starred` : ""}` : "";
  const node = leadSubsection(`${source.id}\u0000${tab}`, tab, all.map((lead) => ({ source, lead })), f, { meta });

  const problems = $(".tab-problems", node);
  if (ts && !ts.ok) {
    const fix = /^Missing columns/.test(ts.problem || "")
      ? " Add the column header(s) to the header row of this tab, then sync."
      : " Rename the tab back in Sheets, or click Edit to pick its new name, then sync.";
    problems.append(el("div", { class: "banner" }, `Skipped. ${ts.problem}${/[.!?]$/.test(ts.problem || "") ? "" : "."}${fix}`));
  }
  else if (ts?.problem) problems.append(dismissibleBanner(`${ts.problem}.`));

  const empty = $(".empty", node);
  if (ts && !ts.ok) empty.hidden = true;
  if (!all.length) empty.textContent = moved ? "Every row in this tab is starred." : ts ? "No rows with an email yet." : "Not synced yet. Click Sync.";
  return node;
}

// One table of rows: a sheet tab in a section, or a group in Starred.
// entries: [{ source, lead }]. `flat` drops the header (Starred's single
// list); `label` tags each row with its section and tab.
function leadSubsection(key, title, entries, f, { meta = "", flat = false, label = false } = {}) {
  const node = $("#tab-tpl").content.firstElementChild.cloneNode(true);
  if (flat) node.classList.add("flat");
  else makeCollapsible(node, $(".tab-head", node), key);
  $(".tab-name", node).textContent = title;
  $(".tab-meta", node).textContent = meta;
  renderCounts($(".counts", node), entries.map((e) => e.lead));
  // A "Section · Tab" column left of Business, for Starred's single list.
  if (label) $("thead th:nth-child(3)", node).before(el("th", {}, "Section · Tab"));

  const shown = entries
    .filter(({ lead: l }) => (f.status === "__none" ? !l.followUpStatus && matches(l, { ...f, status: "" }) : matches(l, f)))
    .sort((a, b) => compareLeads(a.lead, b.lead));
  const tbody = $("tbody", node);
  for (const e of shown) tbody.append(renderRow(e.source, e.lead, { label }));
  $(".table-wrap", node).hidden = shown.length === 0;
  $(".empty", node).hidden = shown.length > 0;

  const selectAll = $(".select-all", node);
  widenHitArea(selectAll);
  selectAll.checked = shown.length > 0 && shown.every((e) => selected.has(e.lead.id));
  selectAll.addEventListener("change", () => {
    for (const { lead } of shown) selectAll.checked ? selected.add(lead.id) : selected.delete(lead.id);
    render();
  });
  return node;
}

// --- Reordering sections --------------------------------------------------

let dragging = null;

function wireReorder(node, head) {
  head.addEventListener("dragstart", (e) => {
    dragging = node;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.dataset.id);
    e.dataTransfer.setDragImage(node, 24, 20);
    requestAnimationFrame(() => node.classList.add("dragging"));
  });
  head.addEventListener("dragend", () => {
    node.classList.remove("dragging");
    dragging = null;
    saveOrder();
  });
  // Keyboard: focus the grip and press Alt+Up / Alt+Down.
  const grip = $(".grip", head);
  grip.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const sibling = e.key === "ArrowUp" ? node.previousElementSibling : node.nextElementSibling;
    if (!sibling?.classList.contains("source")) return;
    e.key === "ArrowUp" ? sibling.before(node) : sibling.after(node);
    grip.focus();
    saveOrder();
  });
}

$("#sections").addEventListener("dragover", (e) => {
  if (!dragging) return;
  e.preventDefault();
  const target = e.target.closest(".source");
  if (!target || target === dragging) return;
  const { top, height } = target.getBoundingClientRect();
  if (e.clientY < top + height / 2) target.before(dragging);
  else target.after(dragging);
});
$("#sections").addEventListener("drop", (e) => dragging && e.preventDefault());

async function saveOrder() {
  const ids = [...$("#sections").querySelectorAll(":scope > .source")].map((n) => n.dataset.id);
  if (ids.join("\n") === state.sources.map((s) => s.id).join("\n")) return;
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  state.sources = ids.map((id) => byId.get(id));
  try {
    await api("PUT", "/api/sources/order", { ids });
  } catch (err) {
    showBanner(err.message, true);
    await load();
  }
}

function ageClass(lead) {
  if (!lead.lastEmailAt || isClosed(lead.followUpStatus) || lead.priority === 0) return "";
  return { overdue: "very-stale", due: "stale", recent: "" }[timingOf(lead.lastEmailAt)];
}

// A date the way Settings → Dates asks for.
function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const showDate = (ms) => ({ relative: ago, absolute: isoDate }[state.settings.dateFormat] || fmtDate)(ms);

function renderRow(source, lead, { label = false } = {}) {
  const writable = state.settings.writeBack;
  const offTitle = writable ? undefined : "Writing to spreadsheets is turned off in Settings";

  const both = state.settings.dateFormat !== "relative" && state.settings.dateFormat !== "absolute";
  const dir = () => el("span", { class: `dir ${lead.lastEmailDir}` }, lead.lastEmailDir === "received" ? "they replied" : "you sent");
  const lastCell = lead.lastEmailAt
    ? both
      ? el(
          "td",
          { class: "when col-lastEmail" },
          el("div", {}, fmtDate(lead.lastEmailAt), dir()),
          el("div", { class: `sub age ${ageClass(lead)}` }, ago(lead.lastEmailAt))
        )
      : el("td", { class: "when col-lastEmail" }, el("div", {}, el("span", { class: `age ${ageClass(lead)}` }, showDate(lead.lastEmailAt)), dir()))
    : el("td", { class: "when muted col-lastEmail" }, lead.gmailChecked ? "No emails yet" : "Not checked yet");

  const priority = el(
    "select",
    { class: `priority${lead.priority != null ? ` p${lead.priority}` : ""}`, "aria-label": "Priority", disabled: !writable, title: offTitle || state.priorityLabels[lead.priority] },
    el("option", { value: "" }, "–"),
    [3, 2, 1, 0].map((p) => el("option", { value: String(p), selected: lead.priority === p, title: state.priorityLabels[p] }, `${p} · ${SHORT_PRIORITY[p]}`))
  );
  priority.addEventListener("change", () => saveField(lead, "priority", priority.value, priority));

  const status = el(
    "select",
    { class: "status", "aria-label": "Follow-up status", disabled: !writable, title: offTitle },
    el("option", { value: "" }, "–"),
    source.statuses.map((s) => el("option", { value: s, selected: s.toLowerCase() === lead.followUpStatus.toLowerCase() }, s)),
    el("option", { value: "__add" }, "+ Add custom status…")
  );
  status.addEventListener("change", async () => {
    if (status.value !== "__add") return saveField(lead, "followUpStatus", status.value, status);
    const name = prompt(`New status for ${source.name}:`);
    if (!name?.trim()) return render();
    try {
      await api("POST", `/api/sources/${encodeURIComponent(source.id)}/statuses`, { name: name.trim() });
      await saveField(lead, "followUpStatus", name.trim(), status, { reload: true });
    } catch (err) {
      showBanner(err.message, true);
      render();
    }
  });

  const cb = el("input", { type: "checkbox", "aria-label": `Select ${lead.businessName || lead.email}`, checked: selected.has(lead.id) });
  cb.addEventListener("change", () => {
    cb.checked ? selected.add(lead.id) : selected.delete(lead.id);
    // A row copied into Starred has a second checkbox to keep in step.
    if (lead.starred && state.settings.showStarred && !movesStarred()) render();
    else renderActionBar();
  });

  const name = lead.businessName || lead.email;
  let star = null;
  if (state.settings.allowStarring) {
    star = el(
      "button",
      { class: `star${lead.starred ? " on" : ""}`, type: "button", "aria-pressed": String(Boolean(lead.starred)), "aria-label": `${lead.starred ? "Unstar" : "Star"} ${name}`, title: lead.starred ? "Unstar" : "Star: pin to the Starred section" },
      lead.starred ? "★" : "☆"
    );
    star.addEventListener("click", () => toggleStar(lead, star));
  }

  const action = nextAction(lead);

  return el(
    "tr",
    { class: [isClosed(lead.followUpStatus) && "closed", lead.priority != null && `urg-${lead.priority}`].filter(Boolean).join(" ") },
    widenHitArea(cb, el("td", { class: "cb" }, cb)),
    el("td", { class: "col-action" }, el("span", { class: `action a-${action.key}`, title: action.title }, action.label)),
    label ? el("td", { class: "where-cell" }, el("span", { class: "where", title: `${source.name} · ${lead.tab}` }, el("span", { class: "where-source" }, source.name), el("span", { class: "where-tab" }, lead.tab))) : null,
    el(
      "td",
      {},
      el("div", { class: "biz-line" }, star, el("div", { class: "biz" }, name, lead.draftId ? el("span", { class: "draft-flag", title: `Gmail draft ${lead.draftId}` }, "draft") : null)),
      el("div", { class: "sub col-details" }, label ? lead.emails.join(", ") : `${lead.emails.join(", ")} · ${lead.tab}`)
    ),
    lastCell,
    el("td", { class: "when col-lastFollowedUp" }, lead.lastFollowedUpAt ? showDate(lead.lastFollowedUpAt) : el("span", { class: "muted" }, "–")),
    el("td", { class: "col-priority" }, priority),
    el("td", { class: "col-status" }, status)
  );
}

// Let a click anywhere in the checkbox's cell toggle it, not just the box itself.
function widenHitArea(cb, cell = cb.closest("td, th")) {
  cell.addEventListener("click", (e) => {
    if (e.target !== cb) cb.click();
  });
  return cell;
}

// A lead field's current value, as the PATCH endpoint takes it.
const fieldValue = (lead, field) => (field === "priority" ? (lead.priority == null ? "" : String(lead.priority)) : lead.followUpStatus);
const setLocal = (lead, field, value) => {
  if (field === "priority") lead.priority = value === "" ? null : Number(value);
  if (field === "followUpStatus") lead.followUpStatus = value;
};
const describeEdit = (field, value) =>
  field === "priority" ? (value === "" ? "Cleared priority" : `Priority ${value}`) : value === "" ? "Cleared status" : `Status "${value}"`;

// Offers Undo for `undoSeconds` (Settings → Safety). edits: [{ lead, field, old }].
function offerUndo(title, edits) {
  const seconds = state.settings.undoSeconds;
  if (!seconds || !edits.length) return false;
  toast(title, { kind: "done", seconds, action: { label: "Undo", run: () => undoEdits(edits) } });
  return true;
}

async function undoEdits(edits) {
  toast(`Undoing ${edits.length === 1 ? "the change" : `${edits.length} changes`}…`, { kind: "busy", sticky: true });
  const failed = [];
  for (const { lead, field, old } of edits) {
    try {
      await api("PATCH", `/api/leads/${lead.id}`, { field, value: old });
      setLocal(lead, field, old);
    } catch (err) {
      failed.push(`${lead.businessName || lead.email}: ${err.message}`);
    }
  }
  if (failed.length) {
    toast(`Couldn't undo ${failed.length} change${failed.length === 1 ? "" : "s"}`, { kind: "error", detail: failed.slice(0, 3).join(" · "), sticky: true });
    await load();
  } else {
    toast("Undone", { kind: "done" });
    render();
  }
}

async function saveField(lead, field, value, control, { reload = false } = {}) {
  control.classList.add("saving");
  control.disabled = true;
  const old = fieldValue(lead, field);
  try {
    await api("PATCH", `/api/leads/${lead.id}`, { field, value });
    transientBanner = null;
    setLocal(lead, field, value);
    offerUndo(`${lead.businessName || lead.email}: ${describeEdit(field, value).toLowerCase()}`, [{ lead, field, old }]);
  } catch (err) {
    showBanner(err.message, true);
    reload = true;
  } finally {
    control.classList.remove("saving");
    control.disabled = false;
  }
  if (reload) await load();
  else render();
}

function renderActionBar() {
  // Drop selections for rows that no longer exist.
  const ids = new Set(state.sources.flatMap((s) => s.leads.map((l) => l.id)));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  $("#actionbar").hidden = selected.size === 0;
  $("#selected-count").textContent = `${selected.size} selected`;
  renderBulkControls();
}

// --- Bulk edits from the selection bar ------------------------------------

function selectedLeads() {
  return state.sources.flatMap((s) => s.leads.filter((l) => selected.has(l.id)).map((lead) => ({ source: s, lead })));
}

function renderBulkControls() {
  const writable = state.settings.writeBack;
  const offTitle = writable ? undefined : "Writing to spreadsheets is turned off in Settings";
  const picked = selectedLeads();

  const priority = $("#bulk-priority");
  priority.disabled = !writable || bulkBusy;
  priority.title = offTitle || "";
  priority.replaceChildren(
    el("option", { value: "__", selected: true, disabled: true }, "Set priority…"),
    ...[3, 2, 1, 0].map((p) => el("option", { value: String(p), title: state.priorityLabels[p] }, `${p} · ${SHORT_PRIORITY[p]}`)),
    el("option", { value: "" }, "– Clear priority")
  );

  // Statuses are per source, so only offer ones every selected lead's
  // source knows about.
  const sources = [...new Set(picked.map((p) => p.source))];
  let common = sources[0]?.statuses ?? [];
  for (const s of sources.slice(1)) {
    const names = new Set(s.statuses.map((st) => st.toLowerCase()));
    common = common.filter((st) => names.has(st.toLowerCase()));
  }
  const status = $("#bulk-status");
  status.disabled = !writable || bulkBusy;
  status.title = offTitle || (sources.length > 1 ? "Showing statuses shared by all selected sheets" : "");
  status.replaceChildren(
    el("option", { value: "__", selected: true, disabled: true }, "Set status…"),
    ...common.map((s) => el("option", { value: s }, s)),
    el("option", { value: "" }, "– Clear status")
  );
}


async function bulkSet(field, value) {
  const picked = selectedLeads();
  if (!picked.length) return;
  const label = describeEdit(field, value);
  const n = `${picked.length} lead${picked.length === 1 ? "" : "s"}`;
  if (state.settings.confirmBulk && !confirm(`${label} on ${n}? This writes to the spreadsheet.`)) {
    renderBulkControls();
    return;
  }
  bulkBusy = true;
  renderBulkControls();
  toast(`Updating ${picked.length} lead${picked.length === 1 ? "" : "s"}…`, { kind: "busy", sticky: true });
  const failed = [];
  const done = [];
  for (const { lead } of picked) {
    const old = fieldValue(lead, field);
    try {
      await api("PATCH", `/api/leads/${lead.id}`, { field, value });
      setLocal(lead, field, value);
      done.push({ lead, field, old });
    } catch (err) {
      failed.push(`${lead.businessName || lead.email}: ${err.message}`);
    }
  }
  bulkBusy = false;
  transientBanner = null;
  if (failed.length) {
    toast(`${label}: ${done.length} updated, ${failed.length} failed`, { kind: "error", detail: failed.slice(0, 3).join(" · ") + (failed.length > 3 ? ` · +${failed.length - 3} more` : ""), sticky: true });
    await load();
  } else {
    const title = `${label} set on ${done.length} lead${done.length === 1 ? "" : "s"}`;
    if (!offerUndo(title, done)) toast(title, { kind: "done" });
    render();
  }
}

// --- Drafting -------------------------------------------------------------

function openDraftDialog() {
  const dialog = $("#draft-dialog");
  $("#draft-setup").hidden = false;
  $("#draft-results").replaceChildren();
  $("#draft-enable-error").hidden = true;
  renderTemplatePicker();
  renderDraftSavingWarning();
  dialog.showModal();
}

// "Email body": Claude writes each email, or a saved email goes in as written
// after a greeting Claude writes. Keeps the last pick while it still exists.
function renderTemplatePicker() {
  const templates = state.settings.draftTemplates || [];
  const select = $("#draft-template");
  const keep = select.value;
  select.replaceChildren(
    el("option", { value: "" }, "Claude writes each email"),
    ...templates.map((t) => el("option", { value: t.id }, t.name))
  );
  select.value = templates.some((t) => t.id === keep) ? keep : "";
  $("#draft-template-field").hidden = !templates.length;
  renderTemplateNote();
}

function renderTemplateNote() {
  const t = (state.settings.draftTemplates || []).find((x) => x.id === $("#draft-template").value);
  const n = selected.size;
  const leads = `${n} lead${n === 1 ? "" : "s"}`;
  const note = $("#draft-template-note");
  note.hidden = !t;
  $("#draft-instructions").placeholder = t ? "e.g. use first names only" : "e.g. mention we're flexible on dates, keep it to 3 sentences";
  if (!t) {
    $("#draft-summary").textContent = `Claude will read each lead's latest thread and notes, then write a follow-up for ${leads}. You'll review every draft before anything is saved to Gmail.`;
    return;
  }
  $("#draft-summary").textContent = `Claude will read each lead's latest thread and notes to write a “Dear…” or “To…” greeting for ${leads}. You'll review every draft before anything is saved to Gmail.`;
  note.textContent = state.settings.draftSignOff?.trim()
    ? `Each draft: the greeting, then “${t.name}” exactly as saved, then your sign-off.`
    : `Each draft: the greeting, then “${t.name}” exactly as saved. No sign-off is set in Settings → Drafting.`;
}

// With Save Gmail drafts off there's no point calling Claude: warn, offer to
// turn it on, and swap Write drafts for Close.
function renderDraftSavingWarning() {
  const off = !state.settings.createDrafts;
  $("#draft-off").hidden = !off;
  $("#draft-generate").hidden = off;
  $("#draft-close").hidden = !off;
}

async function enableDraftSaving() {
  const btn = $("#draft-enable-saving");
  const error = $("#draft-enable-error");
  btn.disabled = true;
  error.hidden = true;
  try {
    state.settings = await api("PATCH", "/api/settings", { createDrafts: true });
    toast("Save Gmail drafts: on", { kind: "done" });
    render();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    btn.disabled = false;
  }
  renderDraftSavingWarning();
}

async function generate() {
  const btn = $("#draft-generate");
  if (!state.settings.createDrafts) return;
  const ids = [...selected];
  btn.disabled = true;
  btn.replaceChildren(el("span", { class: "spinner" }), " Writing…");
  const results = $("#draft-results");
  results.replaceChildren(el("p", { class: "muted" }, `Claude is drafting ${ids.length} email${ids.length === 1 ? "" : "s"}. This can take up to a minute.`));
  try {
    const drafts = await api("POST", "/api/drafts/generate", { leadIds: ids, instructions: $("#draft-instructions").value, templateId: $("#draft-template").value || undefined });
    $("#draft-setup").hidden = true;
    results.replaceChildren(renderDraftList(drafts));
  } catch (err) {
    results.replaceChildren(el("p", { class: "error" }, err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = "Write drafts";
  }
}

function renderDraftList(drafts) {
  const canSave = state.settings.createDrafts;
  const cards = drafts.map((d) => {
    const subject = el("input", { value: d.subject, "aria-label": "Subject", placeholder: "Subject", hidden: d.inThread });
    const body = el("textarea", { "aria-label": "Body" });
    body.value = d.body;
    const status = el("span", { class: "muted" });
    const save = el("button", { class: "primary", disabled: !canSave || Boolean(d.error), title: canSave ? undefined : "Saving Gmail drafts is turned off in Settings" }, d.replacesDraft ? "Replace Gmail draft" : "Save to Gmail drafts");
    const card = el(
      "article",
      { class: "draft-card" },
      el("header", {}, el("strong", {}, d.businessName || d.email), el("span", { class: "muted" }, `to ${d.email}`), el("span", { class: "muted" }, d.inThread ? "· reply in existing thread" : "· new email")),
      d.error ? el("p", { class: "error" }, d.error) : null,
      subject,
      body,
      el("div", { class: "dialog-actions" }, status, save)
    );
    // Resolves true once this draft is in Gmail (now or earlier), false if
    // it failed or can't be saved.
    card.save = async () => {
      if (card.classList.contains("saved")) return true;
      if (save.disabled) return false;
      save.disabled = true;
      status.replaceChildren(el("span", { class: "spinner" }), " Saving");
      try {
        const r = await api("POST", "/api/drafts/save", { leadId: d.leadId, subject: subject.value, body: body.value });
        card.classList.add("saved");
        status.textContent = r.replaced ? "Draft replaced in Gmail" : "Saved to Gmail drafts";
        save.textContent = "Saved";
        return true;
      } catch (err) {
        status.replaceChildren(el("span", { class: "error" }, err.message));
        save.disabled = false;
        return false;
      }
    };
    save.addEventListener("click", card.save);
    return card;
  });
  const saveAll = el("button", { class: "primary", disabled: !canSave }, "Save all to Gmail drafts");
  saveAll.addEventListener("click", async () => {
    if (state.settings.confirmBulk && !confirm(`Save ${cards.length} draft${cards.length === 1 ? "" : "s"} to Gmail? Nothing is sent.`)) return;
    saveAll.disabled = true;
    let saved = 0;
    for (const c of cards) if (await c.save()) saved++;
    const failed = cards.length - saved;
    if (failed === 0) {
      $("#draft-dialog").close();
      toast(`Saved ${saved} draft${saved === 1 ? "" : "s"} to Gmail`, { kind: "done" });
    } else {
      // Keep the dialog open so the failed cards (and their errors) stay visible.
      saveAll.disabled = false;
      toast(`${saved} saved, ${failed} not saved`, { kind: "error", detail: "Check the drafts still open in the dialog.", sticky: true });
    }
    await load();
  });
  return el(
    "div",
    {},
    el("p", { class: "muted" }, "Edit anything before saving. Saving creates Gmail drafts only; nothing is sent."),
    cards,
    el("div", { class: "dialog-actions" }, saveAll)
  );
}

// --- Sources dialog -------------------------------------------------------

let editing = null;

function openSourceDialog(source = null) {
  editing = source;
  $("#source-dialog-title").textContent = source ? `Edit ${source.name}` : "Add section";
  $("#src-name").value = source?.name || "";
  $("#src-url").value = source ? `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit` : "";
  $("#src-url").disabled = Boolean(source);
  const acct = $("#src-account");
  acct.replaceChildren(...state.accounts.map((a) => el("option", { value: a.alias, selected: a.alias === source?.account }, `${a.alias} (${a.email})`)));
  acct.disabled = Boolean(source);
  $("#src-tabs").hidden = true;
  $("#src-tab-list").replaceChildren();
  $("#src-error").hidden = true;
  $("#src-save").disabled = true;
  $("#src-delete").hidden = !source;
  $("#src-statuses").hidden = !source;
  if (source) renderStatusChips(source);
  $("#source-dialog").showModal();
  if (source) loadTabs();
}

function renderStatusChips(source) {
  $("#src-status-list").replaceChildren(
    ...(source.customStatuses.length ? source.customStatuses : []).map((s) =>
      el("span", { class: "chip" }, s, el("button", { "aria-label": `Remove ${s}`, onclick: () => removeStatus(source, s) }, "✕"))
    )
  );
  if (!source.customStatuses.length) $("#src-status-list").append(el("span", { class: "muted" }, "None yet. Built-in: " + state.builtInStatuses.join(", ")));
}

async function removeStatus(source, name) {
  try {
    const updated = await api("DELETE", `/api/sources/${encodeURIComponent(source.id)}/statuses/${encodeURIComponent(name)}`);
    source.customStatuses = updated.customStatuses;
    renderStatusChips(source);
    await load();
  } catch (err) {
    srcError(err.message);
  }
}

function srcError(message) {
  const node = $("#src-error");
  node.textContent = message;
  node.hidden = !message;
}

async function loadTabs() {
  srcError("");
  const btn = $("#src-load");
  btn.disabled = true;
  try {
    const info = await api("POST", "/api/sources/inspect", { url: $("#src-url").value, account: $("#src-account").value });
    if (!editing && !$("#src-name").value.trim()) $("#src-name").value = info.title || "";
    const chosen = new Set(editing?.tabs || []);
    $("#src-tab-list").replaceChildren(
      ...info.tabs.map((t) =>
        el("label", { class: "check" }, el("input", { type: "checkbox", value: t.title, checked: chosen.has(t.title), onchange: updateSaveEnabled }), t.title, t.hidden ? el("span", { class: "muted" }, " (hidden)") : null)
      )
    );
    // A tab that's in the config but gone from the sheet stays listed so it can be unticked.
    for (const t of chosen) {
      if (!info.tabs.some((x) => x.title === t)) {
        $("#src-tab-list").append(el("label", { class: "check" }, el("input", { type: "checkbox", value: t, checked: true, onchange: updateSaveEnabled }), t, el("span", { class: "error" }, " (not found)")));
      }
    }
    $("#src-tabs").hidden = false;
    updateSaveEnabled();
  } catch (err) {
    srcError(err.message);
  } finally {
    btn.disabled = false;
  }
}

function chosenTabs() {
  return [...$("#src-tab-list").querySelectorAll("input:checked")].map((i) => i.value);
}

function updateSaveEnabled() {
  $("#src-save").disabled = chosenTabs().length === 0;
}

async function saveSource() {
  srcError("");
  try {
    if (editing) {
      await api("PATCH", `/api/sources/${encodeURIComponent(editing.id)}`, { name: $("#src-name").value, tabs: chosenTabs() });
    } else {
      await api("POST", "/api/sources", { name: $("#src-name").value, url: $("#src-url").value, account: $("#src-account").value, tabs: chosenTabs() });
    }
    $("#source-dialog").close();
    await sync();
  } catch (err) {
    srcError(err.message);
  }
}

async function deleteSource() {
  if (!editing || !confirm(`Remove “${editing.name}” from the dashboard? The spreadsheet itself isn't changed.`)) return;
  try {
    await api("DELETE", `/api/sources/${encodeURIComponent(editing.id)}`);
    $("#source-dialog").close();
    await load();
  } catch (err) {
    srcError(err.message);
  }
}

// --- Wiring ---------------------------------------------------------------

$("#sync-btn").addEventListener("click", sync);
for (const id of ["#search", "#filter-status", "#filter-priority", "#filter-turn", "#show-closed"]) {
  $(id).addEventListener("input", render);
}
$("#clear-selection").addEventListener("click", () => {
  selected.clear();
  render();
});
$("#bulk-priority").addEventListener("change", (e) => bulkSet("priority", e.target.value));
$("#bulk-status").addEventListener("change", (e) => bulkSet("followUpStatus", e.target.value));
$("#draft-btn").addEventListener("click", openDraftDialog);
$("#draft-generate").addEventListener("click", generate);
$("#draft-enable-saving").addEventListener("click", enableDraftSaving);
$("#draft-close").addEventListener("click", () => $("#draft-dialog").close());
$("#draft-template").addEventListener("change", renderTemplateNote);
$("#template-add").addEventListener("click", () => {
  const card = templateCard();
  $("#template-list").append(card);
  $("input", card).focus();
});
$("#add-source-btn").addEventListener("click", () => openSourceDialog());
$("#history-btn").addEventListener("click", openHistory);
$("#signins-btn").addEventListener("click", openSignins);
$("#settings-btn").addEventListener("click", openSettings);
for (const input of settingInputs()) input.addEventListener("change", () => saveSetting(input));
for (const wrap of colorSettings()) {
  $(".color-btn", wrap).addEventListener("click", () => {
    const wasOpen = openPicker?.wrap === wrap;
    closeColorPicker();
    if (!wasOpen) openColorPicker(wrap);
  });
}
// A click outside the picker, or Esc, closes it without saving. Esc would
// otherwise close the whole Settings dialog.
$("#settings-dialog").addEventListener("mousedown", (e) => openPicker && !openPicker.wrap.contains(e.target) && closeColorPicker());
$("#settings-dialog").addEventListener("cancel", (e) => {
  if (!openPicker) return;
  e.preventDefault();
  const { btn } = openPicker;
  closeColorPicker();
  btn.focus();
});
$("#settings-dialog").addEventListener("close", closeColorPicker);
// Columns: the ticked boxes are the ones shown; the setting lists the hidden ones.
for (const box of columnBoxes()) {
  box.addEventListener("change", () =>
    saveSetting(box, columnBoxes().filter((b) => !b.checked).map((b) => b.dataset.column), "hiddenColumns")
  );
}
$("#src-load").addEventListener("click", loadTabs);
$("#src-save").addEventListener("click", saveSource);
$("#src-delete").addEventListener("click", deleteSource);
$("#src-add-status").addEventListener("click", async () => {
  const input = $("#src-new-status");
  if (!editing || !input.value.trim()) return;
  try {
    const updated = await api("POST", `/api/sources/${encodeURIComponent(editing.id)}/statuses`, { name: input.value.trim() });
    editing.customStatuses = updated.customStatuses;
    input.value = "";
    renderStatusChips(editing);
    await load();
  } catch (err) {
    srcError(err.message);
  }
});
$("#draft-dialog").addEventListener("close", () => load());

// Keep "synced N min ago" current.
setInterval(() => state && renderSyncStatus(), 30_000);

load().catch((err) => showBanner(err.message, true));
checkSignins().catch(() => {
  /* the dialog shows the reason when opened */
});
