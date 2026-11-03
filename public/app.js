const $ = (sel, root = document) => root.querySelector(sel);
const DAY = 86_400_000;
const SHORT_PRIORITY = { 3: "Overdue", 2: "Due soon", 1: "Too recent", 0: "No action" };
const isClosed = (status) => /^closed\b/i.test(String(status || "").trim());

let state = null;
const selected = new Set();
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

async function load() {
  state = await api("GET", "/api/state");
  render();
}

// --- Toast ----------------------------------------------------------------

let toastTimer;
const TOAST_ICONS = {
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 4v5"/><path d="M8 12h.01"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 7v5"/><path d="M8 4h.01"/></svg>',
};

// title: the short headline; detail: an optional second line.
function toast(title, { detail = "", kind = "", sticky = false } = {}) {
  const node = $("#toast");
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
  node.replaceChildren(
    icon,
    el("div", { class: "toast-body" }, el("div", { class: "toast-title" }, title), detail ? el("div", { class: "toast-detail" }, detail) : ""),
    close
  );
  // Re-run the entrance animation for each new toast.
  node.hidden = true;
  void node.offsetWidth;
  node.hidden = false;
  if (!sticky) toastTimer = setTimeout(() => (node.hidden = true), 6000);
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

async function sync() {
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
  }
  await load();
}

let transientBanner = null;
function showBanner(message, isError) {
  transientBanner = { message, isError };
  renderBanners();
}

function renderBanners() {
  const box = $("#banners");
  box.replaceChildren();
  if (transientBanner) {
    box.append(el("div", { class: `banner${transientBanner.isError ? " error" : ""}` }, transientBanner.message));
  }
  const s = state?.settings;
  if (s && (!s.writeBack || !s.createDrafts)) {
    const off = [!s.writeBack && "writing to spreadsheets", !s.createDrafts && "creating Gmail drafts"].filter(Boolean);
    box.append(el("div", { class: "banner" }, `Turned off in config/settings.json: ${off.join(" and ")}. The dashboard is read-only for those until they're switched on.`));
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
  { key: "nudge", label: "Follow up", title: "Waiting on them and marked overdue (priority 3)" },
  { key: "first", label: "First email", title: "Never emailed" },
  { key: "wait", label: "Waiting", title: "You sent last; waiting on their reply" },
  { key: "none", label: "No action", title: "Closed, confirmed or priority 0" },
];

function nextAction(l) {
  const none = isClosed(l.followUpStatus) || /^confirmed$/i.test(l.followUpStatus.trim()) || l.priority === 0;
  const i = none ? 5 : l.lastEmailDir === "received" && !l.draftId ? 0 : l.draftId ? 1 : !l.lastEmailAt ? 3 : l.priority === 3 ? 2 : 4;
  return { rank: i, ...ACTIONS[i] };
}

// By next action, then priority (3 first, blank last), then sheet row order.
function compareLeads(a, b) {
  const ra = nextAction(a).rank;
  const rb = nextAction(b).rank;
  if (ra !== rb) return ra - rb;
  const pa = a.priority ?? -1;
  const pb = b.priority ?? -1;
  if (pa !== pb) return pb - pa;
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
  renderNewContacts();
  renderActionBar();
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
  const name = el("input", { value: c.name || c.email.split("@")[1], "aria-label": `Business name for ${c.email}` });
  const target = el(
    "select",
    { "aria-label": `Tab for ${c.email}` },
    state.sources
      .filter((s) => s.account === c.account)
      .flatMap((s) => s.tabs.map((t) => el("option", { value: JSON.stringify([s.id, t]) }, `${s.name} · ${t}`)))
  );
  const add = el("button", { class: "primary", disabled: !writable || !target.options.length, title: writable ? undefined : "Writing to spreadsheets is turned off in settings.json" }, "Add");
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
    el("td", {}, name, el("div", { class: "sub" }, `${c.email} · ${c.count} email${c.count === 1 ? "" : "s"}`)),
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
function makeCollapsible(node, head, key) {
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
  renderCounts($(".counts", node), source.leads);

  // One subsection per tab, in the order the tabs sit in the spreadsheet
  // (source.tabs is saved in sheet order). Any cached rows from a tab that's
  // no longer listed go last so they're never silently hidden.
  const tabs = [...source.tabs];
  for (const l of source.leads) if (!tabs.includes(l.tab)) tabs.push(l.tab);
  const box = $(".tabs", node);
  for (const tab of tabs) box.append(renderTab(source, tab, f));
  return node;
}

function renderTab(source, tab, f) {
  const node = $("#tab-tpl").content.firstElementChild.cloneNode(true);
  makeCollapsible(node, $(".tab-head", node), `${source.id}\u0000${tab}`);
  $(".tab-name", node).textContent = tab;
  const all = source.leads.filter((l) => l.tab === tab);
  const ts = source.tabState.find((t) => t.tab === tab);
  $(".tab-meta", node).textContent = ts?.ok ? `${all.length} row${all.length === 1 ? "" : "s"}` : "";
  renderCounts($(".counts", node), all);

  const problems = $(".tab-problems", node);
  if (ts && !ts.ok) {
    const fix = /^Missing columns/.test(ts.problem || "")
      ? " Add the column header(s) to the header row of this tab, then sync."
      : " Rename the tab back in Sheets, or click Edit to pick its new name, then sync.";
    problems.append(el("div", { class: "banner" }, `Skipped. ${ts.problem}${/[.!?]$/.test(ts.problem || "") ? "" : "."}${fix}`));
  }
  else if (ts?.problem) problems.append(el("div", { class: "banner" }, `${ts.problem}.`));

  const leads = all
    .filter((l) => (f.status === "__none" ? !l.followUpStatus && matches(l, { ...f, status: "" }) : matches(l, f)))
    .sort(compareLeads);
  const tbody = $("tbody", node);
  for (const lead of leads) tbody.append(renderRow(source, lead));
  $(".table-wrap", node).hidden = leads.length === 0;
  const empty = $(".empty", node);
  empty.hidden = leads.length > 0 || (ts && !ts.ok);
  if (!all.length) empty.textContent = ts ? "No rows with an email yet." : "Not synced yet. Click Sync.";

  const selectAll = $(".select-all", node);
  selectAll.checked = leads.length > 0 && leads.every((l) => selected.has(l.id));
  selectAll.addEventListener("change", () => {
    for (const l of leads) selectAll.checked ? selected.add(l.id) : selected.delete(l.id);
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
  const days = (Date.now() - lead.lastEmailAt) / DAY;
  if (days > 14) return "very-stale";
  if (days > 7) return "stale";
  return "";
}

function renderRow(source, lead) {
  const writable = state.settings.writeBack;
  const offTitle = writable ? undefined : "Writing to spreadsheets is turned off in settings.json";

  const lastCell = lead.lastEmailAt
    ? el(
        "td",
        { class: "when" },
        el("div", {}, fmtDate(lead.lastEmailAt), el("span", { class: `dir ${lead.lastEmailDir}` }, lead.lastEmailDir === "received" ? "they replied" : "you sent")),
        el("div", { class: `sub age ${ageClass(lead)}` }, ago(lead.lastEmailAt))
      )
    : el("td", { class: "when muted" }, lead.gmailChecked ? "No emails yet" : "Not checked yet");

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
    renderActionBar();
  });

  const action = nextAction(lead);

  return el(
    "tr",
    { class: [isClosed(lead.followUpStatus) && "closed", lead.priority != null && `urg-${lead.priority}`].filter(Boolean).join(" ") },
    el("td", { class: "cb" }, cb),
    el("td", {}, el("span", { class: `action a-${action.key}`, title: action.title }, action.label)),
    el(
      "td",
      {},
      el("div", { class: "biz" }, lead.businessName || lead.email, lead.draftId ? el("span", { class: "draft-flag", title: `Gmail draft ${lead.draftId}` }, "draft") : null),
      el("div", { class: "sub" }, `${lead.emails.join(", ")} · ${lead.tab}`)
    ),
    lastCell,
    el("td", { class: "when" }, lead.lastFollowedUpAt ? fmtDate(lead.lastFollowedUpAt) : el("span", { class: "muted" }, "–")),
    el("td", {}, priority),
    el("td", {}, status)
  );
}

async function saveField(lead, field, value, control, { reload = false } = {}) {
  control.classList.add("saving");
  control.disabled = true;
  try {
    await api("PATCH", `/api/leads/${lead.id}`, { field, value });
    transientBanner = null;
    if (field === "priority") lead.priority = value === "" ? null : Number(value);
    if (field === "followUpStatus") lead.followUpStatus = value;
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
}

// --- Drafting -------------------------------------------------------------

function openDraftDialog() {
  const dialog = $("#draft-dialog");
  $("#draft-setup").hidden = false;
  $("#draft-results").replaceChildren();
  $("#draft-summary").textContent = `Claude will read each lead's latest thread and notes, then write a follow-up for ${selected.size} lead${selected.size === 1 ? "" : "s"}. You'll review every draft before anything is saved to Gmail.`;
  dialog.showModal();
}

async function generate() {
  const btn = $("#draft-generate");
  const ids = [...selected];
  btn.disabled = true;
  btn.replaceChildren(el("span", { class: "spinner" }), " Writing…");
  const results = $("#draft-results");
  results.replaceChildren(el("p", { class: "muted" }, `Claude is drafting ${ids.length} email${ids.length === 1 ? "" : "s"}. This can take up to a minute.`));
  try {
    const drafts = await api("POST", "/api/drafts/generate", { leadIds: ids, instructions: $("#draft-instructions").value });
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
    const save = el("button", { class: "primary", disabled: !canSave || Boolean(d.error), title: canSave ? undefined : "Creating Gmail drafts is turned off in settings.json" }, d.replacesDraft ? "Replace Gmail draft" : "Save to Gmail drafts");
    const card = el(
      "article",
      { class: "draft-card" },
      el("header", {}, el("strong", {}, d.businessName || d.email), el("span", { class: "muted" }, `to ${d.email}`), el("span", { class: "muted" }, d.inThread ? "· reply in existing thread" : "· new email")),
      d.error ? el("p", { class: "error" }, d.error) : null,
      subject,
      body,
      el("div", { class: "dialog-actions" }, status, save)
    );
    card.save = async () => {
      if (card.classList.contains("saved") || save.disabled) return;
      save.disabled = true;
      status.replaceChildren(el("span", { class: "spinner" }), " Saving");
      try {
        const r = await api("POST", "/api/drafts/save", { leadId: d.leadId, subject: subject.value, body: body.value });
        card.classList.add("saved");
        status.textContent = r.replaced ? "Draft replaced in Gmail" : "Saved to Gmail drafts";
        save.textContent = "Saved";
      } catch (err) {
        status.replaceChildren(el("span", { class: "error" }, err.message));
        save.disabled = false;
      }
    };
    save.addEventListener("click", card.save);
    return card;
  });
  const saveAll = el("button", { class: "primary", disabled: !canSave }, "Save all to Gmail drafts");
  saveAll.addEventListener("click", async () => {
    saveAll.disabled = true;
    for (const c of cards) await c.save();
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
$("#draft-btn").addEventListener("click", openDraftDialog);
$("#draft-generate").addEventListener("click", generate);
$("#add-source-btn").addEventListener("click", () => openSourceDialog());
$("#history-btn").addEventListener("click", openHistory);
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
