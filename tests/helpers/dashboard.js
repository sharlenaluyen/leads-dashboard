// Loads the real public/index.html and public/app.js into jsdom, backed by a
// fake server, so front-end tests can drive the page like a person would.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8").replace(/<script type="module"[^>]*><\/script>/, "");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");

export const STATUSES = ["Open", "Pending action", "Awaiting Reply", "Closed - interested"];

let nextId = 1;
export function lead(overrides = {}) {
  const id = nextId++;
  return {
    id,
    tab: "Leads",
    row: id + 1,
    email: `lead${id}@example.com`,
    emails: [`lead${id}@example.com`],
    businessName: `Business ${id}`,
    priority: null,
    followUpStatus: "",
    notes: "",
    draftId: null,
    lastEmailAt: null,
    lastEmailDir: null,
    lastFollowedUpAt: null,
    gmailChecked: true,
    ...overrides,
  };
}

export function source(id, leads, overrides = {}) {
  return {
    id,
    name: `Sheet ${id}`,
    account: "work",
    spreadsheetId: `ss-${id}`,
    tabs: ["Leads"],
    statuses: STATUSES,
    customStatuses: [],
    tabState: [{ tab: "Leads", ok: 1, problem: null, rowCount: leads.length }],
    leads,
    ...overrides,
  };
}

export function appState({ sources = [], settings = {} } = {}) {
  return {
    sources,
    builtInStatuses: STATUSES,
    priorityLabels: { 3: "Overdue", 2: "Due soon", 1: "Too recent", 0: "Closed out" },
    accounts: [{ alias: "work", email: "me@example.com" }],
    newContacts: [],
    lastSync: null,
    settings: { writeBack: true, createDrafts: true, drafter: "api", drafterModel: "", draftBatchSize: 5, palette: "periwinkle", accentColor: "",
      dueSoonDays: 7, overdueDays: 14, followUpBy: "priority", autoSync: "off",
      draftTone: "", draftSignOff: "", draftAboutMe: "",
      density: "comfortable", dateFormat: "both", fontSize: "normal", hiddenColumns: [], overdueColor: "", dueSoonColor: "",
      defaultSort: "action", showClosedDefault: false, sectionsStart: "remember", toastSeconds: 6, doneToasts: true,
      confirmBulk: false, undoSeconds: 10,
      ...settings },
  };
}

/**
 * Boots the dashboard. `routes` maps "METHOD /path" to a handler
 * (body, match) => response body, or throws { status, error } to fail.
 * Every request is recorded in `requests`.
 */
export async function boot(state, routes = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost:3000/" });
  const { window } = dom;
  const requests = [];

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLDialogElement.prototype.showModal ??= function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close ??= function () {
    this.open = false;
  };
  window.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ method, url, body });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && new RegExp(`^${p.replace(/:\w+/g, "([^/]+)")}$`).test(url);
    });
    let status = 200;
    let data;
    if (method === "GET" && url === "/api/state") data = structuredClone(state);
    else if (method === "GET" && url === "/api/signins") data = [];
    else if (key) {
      const [, p] = key.split(" ");
      const match = url.match(new RegExp(`^${p.replace(/:\w+/g, "([^/]+)")}$`)).slice(1);
      try {
        data = await routes[key](body, match);
      } catch (err) {
        status = err.status || 500;
        data = { error: err.error || err.message };
      }
    } else {
      status = 404;
      data = { error: `No fake route for ${method} ${url}` };
    }
    return { ok: status < 400, status, json: async () => data };
  };

  window.eval(appJs);
  await settle(window);
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  return { window, document: window.document, $, $$, requests, settle: () => settle(window), close: () => window.close() };
}

// Lets pending fetches and the renders after them finish.
export async function settle(window, rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => window.setTimeout(r, 0));
}

export function check(page, businessName) {
  const cb = row(page, businessName)?.querySelector("td.cb input");
  if (!cb) throw new Error(`No row for ${businessName}`);
  cb.checked = !cb.checked;
  cb.dispatchEvent(new page.window.Event("change", { bubbles: true }));
}

export function choose(page, select, value) {
  select.value = value;
  select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
}

export function row(page, businessName) {
  // Match the name cell exactly: a row's full text includes its dropdowns'
  // option labels, so a loose match finds the wrong row.
  return page.$$("tbody tr").find((tr) => tr.querySelector(".biz")?.firstChild.textContent === businessName);
}
