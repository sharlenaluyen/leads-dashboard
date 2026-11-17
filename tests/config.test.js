import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Config paths are read when config.js loads, so point them at a temp folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-config-"));
process.env.LEADS_CONFIG_DIR = dir;
const config = await import("../src/config.js");
const { loadSettings, saveSettings, loadSources, saveSources, getSource, updateSource, reorderSources, addCustomStatuses, loadStars, setStar, dropStarsFor, configVersion } = config;

const file = (name) => path.join(dir, name);
const readFile = (name) => JSON.parse(fs.readFileSync(file(name), "utf8"));
// A hand edit or another process: write-then-rename, so the file is new on disk.
function editByHand(name, value) {
  fs.writeFileSync(`${file(name)}.hand`, JSON.stringify(value));
  fs.renameSync(`${file(name)}.hand`, file(name));
}

// Counts reads of the config folder's files during fn.
function readsDuring(fn) {
  const real = fs.readFileSync;
  let n = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p).startsWith(dir)) n++;
    return real.call(fs, p, ...rest);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = real;
  }
  return n;
}

const source = (id, over = {}) => ({ id, name: `Sheet ${id}`, spreadsheetId: `ss-${id}`, account: "work", tabs: ["Leads"], customStatuses: [], ...over });

test("with no files, the defaults and empty lists come back", () => {
  assert.equal(loadSettings().port, 3000);
  assert.deepEqual(loadSources(), []);
  assert.deepEqual(loadStars(), []);
});

test("repeated loads read each file once until it changes", () => {
  saveSettings({ density: "compact" });
  saveSources([source("a")]);
  setStar({ source: "a", tab: "Leads", email: "x@y.com" }, true);
  const reads = readsDuring(() => {
    for (let i = 0; i < 50; i++) {
      loadSettings();
      loadSources();
      loadStars();
      getSource("a");
    }
  });
  assert.equal(reads, 0, "this process's own writes are already in memory");
  editByHand("settings.json", { density: "comfortable" });
  assert.equal(readsDuring(() => [loadSettings(), loadSettings(), loadSettings()]), 1);
});

test("saved settings read back and reach the file", () => {
  const s = saveSettings({ fontSize: "large", dueSoonDays: "5" });
  assert.equal(s.fontSize, "large");
  assert.equal(s.dueSoonDays, 5);
  assert.equal(loadSettings().fontSize, "large");
  assert.equal(readFile("settings.json").fontSize, "large");
  assert.equal(readFile("settings.json").port, undefined, "defaults aren't written to the file");
});

test("a hand edit to a config file is picked up without a restart", () => {
  editByHand("settings.json", { ...readFile("settings.json"), toastSeconds: 42 });
  assert.equal(loadSettings().toastSeconds, 42);
  editByHand("sources.json", [source("a", { name: "Renamed by hand" })]);
  assert.equal(getSource("a").name, "Renamed by hand");
  editByHand("stars.json", []);
  assert.deepEqual(loadStars(), []);
});

test("changing what a load returned doesn't change the next load", () => {
  saveSettings({ hiddenColumns: ["priority"] });
  const s = loadSettings();
  s.hiddenColumns.push("status");
  s.fontSize = "small";
  assert.deepEqual(loadSettings().hiddenColumns, ["priority"]);
  assert.equal(loadSettings().fontSize, "large");

  const list = loadSources();
  list[0].name = "changed in memory";
  list[0].tabs.push("Other");
  list.push(source("ghost"));
  assert.equal(getSource("a").name, "Renamed by hand");
  assert.deepEqual(getSource("a").tabs, ["Leads"]);
  assert.equal(loadSources().length, 1);

  loadStars().push({ source: "a", tab: "Leads", email: "ghost@x.com" });
  assert.deepEqual(loadStars(), []);
});

test("a settings save that fails validation leaves the cache and file alone", () => {
  const before = fs.readFileSync(file("settings.json"), "utf8");
  assert.throws(() => saveSettings({ overdueDays: 3, dueSoonDays: 5 }), /Overdue must be more days/);
  assert.throws(() => saveSettings({ nope: 1 }), /isn't a setting/);
  assert.equal(fs.readFileSync(file("settings.json"), "utf8"), before);
  assert.equal(loadSettings().dueSoonDays, 5);
});

test("sources: update, reorder and custom statuses go through the cache to the file", () => {
  saveSources([source("a"), source("b"), source("c")]);
  updateSource("b", { name: "Bee" });
  assert.equal(getSource("b").name, "Bee");
  assert.deepEqual(reorderSources(["c", "a", "b"]).map((s) => s.id), ["c", "a", "b"]);
  assert.deepEqual(loadSources().map((s) => s.id), ["c", "a", "b"]);
  assert.deepEqual(readFile("sources.json").map((s) => s.id), ["c", "a", "b"]);
  assert.throws(() => reorderSources(["a", "b"]), /out of date/);

  addCustomStatuses("a", ["Waiting on legal", "open"]);
  assert.deepEqual(getSource("a").customStatuses, ["Waiting on legal"], "built-in 'Open' is skipped in any case");
  // A status added by hand meanwhile isn't lost by the next add.
  editByHand("sources.json", readFile("sources.json").map((s) => (s.id === "a" ? { ...s, customStatuses: [...s.customStatuses, "By hand"] } : s)));
  addCustomStatuses("a", ["Third"]);
  assert.deepEqual(readFile("sources.json").find((s) => s.id === "a").customStatuses, ["Waiting on legal", "By hand", "Third"]);
});

test("stars: set, unset and drop by section", () => {
  setStar({ source: "a", tab: "Leads", email: "One@X.com" }, true);
  setStar({ source: "a", tab: "Leads", email: "two@x.com" }, true);
  setStar({ source: "b", tab: "Leads", email: "three@x.com" }, true);
  setStar({ source: "a", tab: "Leads", email: "one@x.com" }, true); // again: no duplicate
  assert.deepEqual(loadStars().map((s) => s.email).sort(), ["one@x.com", "three@x.com", "two@x.com"], "lowercased, no duplicate");
  setStar({ source: "a", tab: "Leads", email: "two@x.com" }, false);
  dropStarsFor("b");
  assert.deepEqual(loadStars(), [{ source: "a", tab: "Leads", email: "one@x.com" }]);
  assert.deepEqual(readFile("stars.json"), loadStars());
});

test("a config file that won't parse falls back to its .bak copy", () => {
  saveSources([source("good")]);
  saveSources([source("good"), source("newer")]); // .bak now holds [good]
  fs.writeFileSync(file("sources.json"), '[{"id": "cut off');
  assert.deepEqual(loadSources().map((s) => s.id), ["good"]);
  // Fixing the file is picked up.
  editByHand("sources.json", [source("fixed")]);
  assert.deepEqual(loadSources().map((s) => s.id), ["fixed"]);
});

test("configVersion changes whenever a config file does", () => {
  const v1 = configVersion();
  assert.equal(configVersion(), v1);
  loadSettings();
  assert.equal(configVersion(), v1, "reading doesn't change it");
  setStar({ source: "a", tab: "Leads", email: "v@x.com" }, true);
  const v2 = configVersion();
  assert.notEqual(v2, v1);
  editByHand("settings.json", readFile("settings.json"));
  assert.notEqual(configVersion(), v2, "even a rewrite with the same content");
});
