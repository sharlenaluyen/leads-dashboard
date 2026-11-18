import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The accounts package reads its folder when it loads, so set it first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-signins-"));
process.env.GOOGLE_MCP_DIR = dir;
const accountsFile = path.join(dir, "accounts.json");
const credentialsFile = path.join(dir, "credentials.json");
const G = "https://www.googleapis.com/auth/";
const ALL = [`${G}gmail.modify`, `${G}spreadsheets`];

const readAccounts = () => JSON.parse(fs.readFileSync(accountsFile, "utf8"));
const saveAccounts = (accounts) => fs.writeFileSync(accountsFile, JSON.stringify(accounts));

const { addSignin, cancelSignin, refreshSignin } = await import("../src/signins.js");
const { UserError } = await import("../src/errors.js");

// Stands in for auth.js: records how it was called and saves what a real
// sign-in would.
function fakeAuth(save) {
  const calls = [];
  const run = async (args, messages) => {
    calls.push({ args, messages });
    save?.(args);
  };
  return { run, calls };
}
const userError = (pattern) => (err) => err instanceof UserError && pattern.test(err.message);

beforeEach(() => {
  fs.writeFileSync(credentialsFile, JSON.stringify({ installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] } }));
  saveAccounts({ work: { email: "me@work.com", refresh_token: "r1", nicknames: ["job"], scopes: ALL } });
});

test("adding an account runs auth.js with just the new name and reports who signed in", async () => {
  const auth = fakeAuth(([alias]) => saveAccounts({ ...readAccounts(), [alias]: { email: "me@home.com", refresh_token: "h1", scopes: ALL } }));
  const added = await addSignin("  home ", { run: auth.run });
  assert.deepEqual(auth.calls.map((c) => c.args), [["home"]], "no --expect: any account may sign in");
  assert.deepEqual(added, { alias: "home", email: "me@home.com", alreadyConnectedAs: null, missing: [] });
});

test("a name that's missing, malformed or already in use never opens the browser", async () => {
  const auth = fakeAuth();
  await assert.rejects(addSignin("", { run: auth.run }), userError(/Type a name/));
  await assert.rejects(addSignin(undefined, { run: auth.run }), userError(/Type a name/));
  await assert.rejects(addSignin("my account", { run: auth.run }), userError(/letters, numbers/));
  await assert.rejects(addSignin("--list", { run: auth.run }), userError(/letters, numbers/), "can't be read as an auth.js option");
  await assert.rejects(addSignin("x".repeat(41), { run: auth.run }), userError(/up to 40/));
  // auth.js would hand this alias's sign-in to whoever signs in.
  await assert.rejects(addSignin("work", { run: auth.run }), userError(/"work" is already the name of me@work\.com/));
  await assert.rejects(addSignin("job", { run: auth.run }), userError(/"job" is already a nickname of me@work\.com/));
  assert.equal(auth.calls.length, 0);
});

test("without the Google OAuth client file, adding fails before the browser opens", async () => {
  fs.unlinkSync(credentialsFile);
  const auth = fakeAuth();
  await assert.rejects(addSignin("home", { run: auth.run }), userError(/credentials/i));
  assert.equal(auth.calls.length, 0);
});

test("signing in to an account that's already connected reports its existing name", async () => {
  // What auth.js does then: renews that entry and keeps the new name as a nickname.
  const auth = fakeAuth(([alias]) => {
    const accounts = readAccounts();
    accounts.work = { ...accounts.work, refresh_token: "r2", nicknames: [...accounts.work.nicknames, alias] };
    saveAccounts(accounts);
  });
  const added = await addSignin("office", { run: auth.run });
  assert.deepEqual(added, { alias: "work", email: "me@work.com", alreadyConnectedAs: "work", missing: [] });
});

test("permissions left unticked on Google's screen are reported", async () => {
  const auth = fakeAuth(([alias]) => saveAccounts({ ...readAccounts(), [alias]: { email: "me@home.com", refresh_token: "h1", scopes: [`${G}gmail.modify`] } }));
  assert.deepEqual((await addSignin("home", { run: auth.run })).missing, ["Google Sheets"]);
});

test("a sign-in that fails or saves nothing is an error, and nothing is added", async () => {
  const failing = async () => {
    throw new UserError(`"home" wasn't added: OAuth error: access_denied`);
  };
  await assert.rejects(addSignin("home", { run: failing }), userError(/access_denied/));
  await assert.rejects(addSignin("home", { run: fakeAuth().run }), userError(/no account was saved/));
  assert.deepEqual(Object.keys(readAccounts()), ["work"]);
});

test("signing in again still only accepts the same account", async () => {
  const auth = fakeAuth();
  const again = await refreshSignin("work", { run: auth.run });
  assert.deepEqual(auth.calls[0].args, ["work", "--expect", "me@work.com"]);
  assert.deepEqual(again, { alias: "work", email: "me@work.com", switchedFrom: null });
  await assert.rejects(refreshSignin("nobody", { run: auth.run }), userError(/No connected Google account called "nobody"/));
});

test("cancelling with no sign-in waiting does nothing", async () => {
  assert.deepEqual(await cancelSignin(), { cancelled: false });
});
