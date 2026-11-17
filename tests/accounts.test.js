import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The accounts package reads its folder when it loads, so set it first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-accounts-"));
process.env.GOOGLE_MCP_DIR = dir;
const accountsFile = path.join(dir, "accounts.json");
// How auth.js saves: write-then-rename.
function saveAccounts(accounts) {
  fs.writeFileSync(`${accountsFile}.tmp`, JSON.stringify(accounts));
  fs.renameSync(`${accountsFile}.tmp`, accountsFile);
}
saveAccounts({ work: { email: "me@work.com", refresh_token: "r1", nicknames: ["job"], scopes: [] } });

const { getAccountInfo, getConnectedAliases, accountsVersion } = await import("../src/google.js");
const { UserError } = await import("../src/errors.js");

function readsOfAccounts(fn) {
  const real = fs.readFileSync;
  let n = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === accountsFile) n++;
    return real.call(fs, p, ...rest);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = real;
  }
  return n;
}

test("lookups by alias or nickname, with accounts.json read once", () => {
  const reads = readsOfAccounts(() => {
    for (let i = 0; i < 50; i++) {
      assert.equal(getAccountInfo("work").email, "me@work.com");
      assert.deepEqual(getConnectedAliases(), ["work"]);
    }
  });
  assert.equal(reads, 2, "once for the lookup, once for the alias list");
  assert.equal(getAccountInfo("job").alias, "work");
});

test("a new sign-in (accounts.json rewritten) is seen on the next lookup", () => {
  saveAccounts({
    work: { email: "me@work.com", refresh_token: "r2", nicknames: ["job"], scopes: [] },
    home: { email: "me@home.com", refresh_token: "h1", scopes: [] },
  });
  assert.equal(getAccountInfo("work").refresh_token, "r2");
  assert.equal(getAccountInfo("home").email, "me@home.com");
  assert.deepEqual(getConnectedAliases().sort(), ["home", "work"]);
});

test("an unknown alias is a UserError and isn't remembered", () => {
  assert.throws(() => getAccountInfo("later"), (err) => err instanceof UserError && /Unknown account alias "later"/.test(err.message));
  saveAccounts({ ...JSON.parse(fs.readFileSync(accountsFile, "utf8")), later: { email: "me@later.com", refresh_token: "l1", scopes: [] } });
  assert.equal(getAccountInfo("later").email, "me@later.com");
});

test("a removed account stops resolving", () => {
  saveAccounts({ work: { email: "me@work.com", refresh_token: "r3", scopes: [] } });
  assert.throws(() => getAccountInfo("home"), UserError);
  assert.deepEqual(getConnectedAliases(), ["work"]);
});

test("changing a returned lookup doesn't change the next one", () => {
  const info = getAccountInfo("work");
  info.email = "changed@x.com";
  getConnectedAliases().push("ghost");
  assert.equal(getAccountInfo("work").email, "me@work.com");
  assert.deepEqual(getConnectedAliases(), ["work"]);
});

test("accountsVersion changes when accounts.json does", () => {
  const v = accountsVersion();
  getAccountInfo("work");
  assert.equal(accountsVersion(), v);
  saveAccounts({ work: { email: "me@work.com", refresh_token: "r4", scopes: [] } });
  assert.notEqual(accountsVersion(), v);
});
