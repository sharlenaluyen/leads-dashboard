import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { DRIVE_READONLY_SCOPE, REQUIRED_SCOPES, loadAccounts, loadCredentials, resolveAlias } from "google-mcp-accounts";
import { UserError } from "./errors.js";

// The same checks and sign-in as google-mcp-accounts' ./refresh-tokens.sh,
// and the same "connect an account" as its ./setup.sh, for the dashboard's
// "Google sign-ins" button. auth.js stays the only program that writes
// tokens; google.js picks up its new ones on the next call.

const ACCOUNTS_DIR = path.dirname(fileURLToPath(import.meta.resolve("google-mcp-accounts")));
const TOKEN_DAYS = 7; // how long Google keeps a Testing-mode sign-in
const SOON_HOURS = 24;
const SIGNIN_TIMEOUT_MS = 5 * 60_000;

// One row per account. Only asks Google for a short-lived access token;
// nothing is written.
export async function checkSignins() {
  const { clientId, clientSecret, redirectUri } = loadCredentials();
  return Promise.all(
    Object.entries(loadAccounts()).map(async ([alias, acct]) => {
      const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      client.setCredentials({ refresh_token: acct.refresh_token });
      let status = "ok";
      let problem = null;
      try {
        await client.getAccessToken();
      } catch (err) {
        const code = String(err.response?.data?.error || err.message);
        if (/invalid_grant|unauthorized_client|invalid_client/.test(code)) status = "expired";
        else [status, problem] = ["unknown", code];
      }
      let hoursLeft = acct.authorized_at
        ? Math.floor(TOKEN_DAYS * 24 - (Date.now() - Date.parse(acct.authorized_at)) / 3_600_000)
        : null;
      // Still working past 7 days: the app isn't in Testing mode, so no expiry to show.
      if (status === "ok" && hoursLeft != null && hoursLeft < 0) hoursLeft = null;
      if (status === "ok" && hoursLeft != null && hoursLeft < SOON_HOURS) status = "soon";
      return {
        alias,
        email: acct.email,
        status,
        problem,
        hoursLeft,
        authorizedAt: acct.authorized_at || null,
        driveReadonly: (acct.scopes || []).includes(DRIVE_READONLY_SCOPE),
      };
    })
  );
}

// auth.js listens on one fixed port for Google's redirect, so only one
// sign-in can be open at a time. Starting another (say, after closing the
// browser tab without finishing) cancels the one waiting.
let pending = null;

// Stops whichever sign-in is waiting and waits for its auth.js to exit.
// `why` is "replaced" (another one is starting) or "stopped" (Cancel).
async function stopPending(why) {
  if (!pending) return false;
  pending.cancelled = why;
  pending.child.kill();
  await pending.done;
  return true;
}

// Runs auth.js with `args`, which opens Google sign-in in the browser, and
// resolves once it has saved the account. `label` names the sign-in and
// `unchanged` says what a failure left as it was, for the error messages.
async function runAuth(args, { label, unchanged, failed }) {
  await stopPending("replaced");

  const child = spawn(process.execPath, ["auth.js", ...args], { cwd: ACCOUNTS_DIR, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, cancelled: null, timedOut: false };
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const timer = setTimeout(() => {
    run.timedOut = true;
    child.kill();
  }, SIGNIN_TIMEOUT_MS);
  run.done = new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: 1, error: err.message }));
    child.on("exit", (code) => resolve({ code }));
  });
  pending = run;

  const { code, error } = await run.done;
  clearTimeout(timer);
  if (pending === run) pending = null;

  if (run.cancelled === "stopped") throw new UserError(`${label} was cancelled. ${unchanged}`);
  if (run.cancelled) throw new UserError(`${label} was replaced by a newer one. ${unchanged}`);
  if (run.timedOut) throw new UserError(`${label} wasn't finished within 5 minutes. ${unchanged}`);
  if (code !== 0) {
    // auth.js prints a one-line reason last (state mismatch, no refresh token, ...).
    const reason = error || output.trim().split("\n").pop() || `auth.js exited with code ${code}`;
    throw new UserError(`${failed}: ${reason}`);
  }
}

// For the dialog's Cancel button: gives up on the sign-in that's waiting for
// the browser, if any. The request that started it then fails with "cancelled".
export async function cancelSignin() {
  return { cancelled: await stopPending("stopped") };
}

// Opens Google sign-in for one account in the browser and resolves once it's
// done. Keeps the account's drive.readonly access if it had it, and only
// accepts the same Google account (auth.js --expect refuses any other).
export async function refreshSignin(alias, { run = runAuth } = {}) {
  const acct = loadAccounts()[alias];
  if (!acct) throw new UserError(`No connected Google account called "${alias}"`);

  await run([alias, "--expect", acct.email, ...((acct.scopes || []).includes(DRIVE_READONLY_SCOPE) ? ["--with-drive-readonly"] : [])], {
    label: `Sign-in for "${alias}"`,
    unchanged: "Its old sign-in is unchanged.",
    failed: `"${alias}" wasn't signed in again`,
  });

  const after = loadAccounts()[alias]?.email;
  return {
    alias,
    email: after,
    // Only possible with an auth.js older than --expect, which ignores it.
    switchedFrom: after && after !== acct.email ? acct.email : null,
  };
}

// auth.js's own rule, checked here so a bad name is refused before the
// browser opens. Stricter in one way: no leading "-", which auth.js would
// read as one of its options (--remove, --list) instead of a name.
const ALIAS_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/i;
const MAX_ALIAS_LENGTH = 40;

// What the dashboard itself calls Google for.
const NEEDED = { Gmail: REQUIRED_SCOPES.gmail, "Google Sheets": REQUIRED_SCOPES.sheets };

// Connects a Google account that isn't connected yet, under a new alias:
// opens Google sign-in in the browser and resolves once auth.js has saved it.
// A name already in use is refused up front, because auth.js would give that
// alias's sign-in to whichever account signs in.
export async function addSignin(name, { run = runAuth } = {}) {
  const alias = String(name ?? "").trim();
  if (!alias) throw new UserError("Type a name for the account, like work or personal");
  if (!ALIAS_PATTERN.test(alias) || alias.length > MAX_ALIAS_LENGTH) {
    throw new UserError(`An account name can only have letters, numbers, - and _ (up to ${MAX_ALIAS_LENGTH} characters), and can't start with -`);
  }
  const before = loadAccounts();
  const taken = resolveAlias(before, alias);
  if (taken) {
    throw new UserError(`"${alias}" is already ${taken === alias ? "the name" : `a nickname`} of ${before[taken].email}. Pick another name, or use Sign in again for that account.`);
  }
  try {
    loadCredentials();
  } catch (err) {
    throw new UserError(err.message, { cause: err });
  }

  await run([alias], {
    label: `Adding "${alias}"`,
    unchanged: "No account was added.",
    failed: `"${alias}" wasn't added`,
  });

  const accounts = loadAccounts();
  const owner = resolveAlias(accounts, alias);
  if (!owner) throw new UserError(`"${alias}" wasn't added: the sign-in finished but no account was saved. Try again.`);
  const granted = accounts[owner].scopes || [];
  return {
    alias: owner,
    email: accounts[owner].email,
    // The Google account was connected already, so auth.js renewed that
    // sign-in and kept the new name as a nickname for it.
    alreadyConnectedAs: owner === alias ? null : owner,
    // Permissions unticked on Google's consent screen that the dashboard needs.
    missing: Object.keys(NEEDED).filter((product) => !NEEDED[product].every((s) => granted.includes(s))),
  };
}
