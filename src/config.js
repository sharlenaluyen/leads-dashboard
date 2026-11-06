import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_PATH = path.join(ROOT, "config", "settings.json");
const SOURCES_PATH = path.join(ROOT, "config", "sources.json");
const STARS_PATH = path.join(ROOT, "config", "stars.json");
// Written by a running server (npm start / npm run dev), so npm run rebuild
// can refuse to delete the database out from under it.
export const SERVER_PID_PATH = path.join(ROOT, "data", "server.pid");

// The headers every included tab must have (matched case-insensitively).
// `notes` is optional: when present it's handed to Claude as drafting context.
export const HEADERS = {
  businessName: "business name",
  email: "email",
  priority: "priority",
  followUpStatus: "follow-up status",
  lastEmail: "last email",
  lastEmailDir: "last email dir",
  lastFollowedUp: "last followed up",
  draftId: "draft id",
};
export const OPTIONAL_HEADERS = { notes: "notes" };

export const BUILT_IN_STATUSES = [
  "Open",
  "Pending action",
  "Awaiting Reply",
  "Contacted elsewhere",
  "Closed - interested",
  "Closed - declined forever",
  "Closed - declined for now",
  "Closed - Other",
  "Confirmed",
];

// 3 is the most urgent.
export const PRIORITY_LABELS = {
  3: "Overdue, no recent movement",
  2: "Due soon",
  1: "Too recent to chase yet",
  0: "Closed out, no action needed",
};

const DEFAULT_SETTINGS = {
  port: 3000,
  // "claude-code" runs the local `claude -p`; "api" calls the Anthropic API
  // with ANTHROPIC_API_KEY (see src/drafter/api.js).
  drafter: "claude-code",
  drafterModel: null,
  // How many leads one Claude call drafts at once.
  draftBatchSize: 8,
  // The Starred section at the top of the dashboard (see loadStars).
  showStarred: true,
  allowStarring: true,
  // "duplicate": a starred row shows in Starred and its own section;
  // "move": only in Starred.
  starMode: "duplicate",
  // "tabs": Starred groups rows into one subsection per sheet tab;
  // "labels": one list, each row labelled with its section and tab.
  starredLayout: "tabs",
  // Header color of the Starred section; "default" matches the other sections.
  starredColor: "default",
};

// A file that won't parse (cut off by a crash, or a bad hand edit) falls
// back to the .bak copy writeJsonAtomic keeps, rather than taking the
// dashboard down.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const bak = `${file}.bak`;
    if (!fs.existsSync(bak)) throw new Error(`${path.relative(ROOT, file)} isn't valid JSON (${err.message}) and there's no .bak copy to fall back to.`);
    console.warn(`${path.relative(ROOT, file)} isn't valid JSON (${err.message}); using ${path.relative(ROOT, bak)}.`);
    return JSON.parse(fs.readFileSync(bak, "utf8"));
  }
}

function fsyncPath(p) {
  const fd = fs.openSync(p, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Write-then-rename, fsynced, so a crash or power loss leaves either the old
// file or the new one, never an empty or half-written one. The previous
// version is kept as <file>.bak.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
    fsyncPath(`${file}.bak`);
  }
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) };
}

export const DRAFTERS = ["claude-code", "api"];
export const STAR_MODES = ["duplicate", "move"];
export const STARRED_LAYOUTS = ["tabs", "labels"];
export const STARRED_COLORS = ["default", "amber", "green", "rose", "slate"];

const onOff = (key) => (v) => {
  if (typeof v !== "boolean") throw new Error(`${key} must be on or off`);
  return v;
};
const oneOf = (key, options) => (v) => {
  if (!options.includes(v)) throw new Error(`${key} must be one of: ${options.join(", ")}`);
  return v;
};

// Checks each setting the dashboard can change, returning the cleaned value.
const SETTING_RULES = {
  writeBack: (v) => {
    if (typeof v !== "boolean") throw new Error("writeBack must be on or off");
    return v;
  },
  createDrafts: (v) => {
    if (typeof v !== "boolean") throw new Error("createDrafts must be on or off");
    return v;
  },
  drafter: (v) => {
    if (!DRAFTERS.includes(v)) throw new Error(`drafter must be one of: ${DRAFTERS.join(", ")}`);
    return v;
  },
  drafterModel: (v) => {
    const model = String(v ?? "").trim();
    if (model.length > 100 || /\s/.test(model)) throw new Error("That doesn't look like a model name");
    return model || null;
  },
  draftBatchSize: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 40) throw new Error("Leads per Claude call must be a whole number from 1 to 40");
    return n;
  },
  port: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("Port must be a whole number from 1024 to 65535");
    return n;
  },
  showStarred: onOff("showStarred"),
  allowStarring: onOff("allowStarring"),
  starMode: oneOf("starMode", STAR_MODES),
  starredLayout: oneOf("starredLayout", STARRED_LAYOUTS),
  starredColor: oneOf("starredColor", STARRED_COLORS),
};

// Applies `change` on top of what's in the file now (not the defaults), so
// keys you never set stay unset.
export function saveSettings(change) {
  const clean = {};
  for (const [key, value] of Object.entries(change || {})) {
    if (!SETTING_RULES[key]) throw new Error(`"${key}" isn't a setting the dashboard can change`);
    clean[key] = SETTING_RULES[key](value);
  }
  writeJsonAtomic(SETTINGS_PATH, { ...readJson(SETTINGS_PATH, {}), ...clean });
  return loadSettings();
}

// Sources are configuration, not data, so they live in a JSON file rather
// than SQLite: deleting the database (a rebuildable cache) never loses them.
// Shape: [{ id, name, spreadsheetId, account, tabs: [title], customStatuses: [] }]
export function loadSources() {
  return readJson(SOURCES_PATH, []);
}

export function saveSources(sources) {
  writeJsonAtomic(SOURCES_PATH, sources);
}

export function getSource(id) {
  const source = loadSources().find((s) => s.id === id);
  if (!source) throw new Error(`Unknown source "${id}"`);
  return source;
}

export function updateSource(id, change) {
  const sources = loadSources();
  const i = sources.findIndex((s) => s.id === id);
  if (i === -1) throw new Error(`Unknown source "${id}"`);
  sources[i] = { ...sources[i], ...change, id };
  saveSources(sources);
  return sources[i];
}

// `ids` must name every source exactly once; the file is saved in that order,
// which is the order sections appear on the page.
export function reorderSources(ids) {
  const sources = loadSources();
  const byId = new Map(sources.map((s) => [s.id, s]));
  if (!Array.isArray(ids) || ids.length !== sources.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    throw new Error("Section list is out of date. Reload the page and try again.");
  }
  const ordered = ids.map((id) => byId.get(id));
  saveSources(ordered);
  return ordered;
}

// Adds statuses to a source's custom list, re-reading the file first so a
// status added in the dashboard meanwhile isn't lost. Ones already known
// (any letter case) are skipped.
export function addCustomStatuses(id, names) {
  const sources = loadSources();
  const source = sources.find((s) => s.id === id);
  if (!source) return null;
  const known = new Set(statusesFor(source).map((s) => s.toLowerCase()));
  const fresh = names.filter((n) => !known.has(n.toLowerCase()) && known.add(n.toLowerCase()));
  if (!fresh.length) return source;
  return updateSource(id, { customStatuses: [...(source.customStatuses || []), ...fresh] });
}

export function statusesFor(source) {
  return [...BUILT_IN_STATUSES, ...(source.customStatuses || [])];
}

// Stars are the dashboard's own marks, never written to a spreadsheet. They
// live in config/ rather than SQLite so a rebuild doesn't lose them, and are
// keyed the way a row is identified (section, tab, first email), not by the
// cache's row id, which changes on a rebuild.
// Shape: [{ source, tab, email }]
export function loadStars() {
  return readJson(STARS_PATH, []);
}

export const starKey = (source, tab, email) => JSON.stringify([source, tab, String(email).toLowerCase()]);

export function setStar({ source, tab, email }, starred) {
  const key = starKey(source, tab, email);
  const others = loadStars().filter((s) => starKey(s.source, s.tab, s.email) !== key);
  writeJsonAtomic(STARS_PATH, starred ? [...others, { source, tab, email: String(email).toLowerCase() }] : others);
}

// Drops every star in a section, when the section is removed.
export function dropStarsFor(sourceId) {
  const stars = loadStars();
  const kept = stars.filter((s) => s.source !== sourceId);
  if (kept.length !== stars.length) writeJsonAtomic(STARS_PATH, kept);
}
