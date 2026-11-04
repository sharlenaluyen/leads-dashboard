import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { DRIVE_READONLY_SCOPE, loadAccounts, loadCredentials } from "google-mcp-accounts";

// The same checks and sign-in as google-mcp-accounts' ./refresh-tokens.sh,
// for the dashboard's "Google sign-ins" button. auth.js stays the only
// program that writes tokens; google.js picks up its new ones on the next call.

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

// Opens Google sign-in for one account in the browser and resolves once it's
// done. Keeps the account's drive.readonly access if it had it.
export async function refreshSignin(alias) {
  const acct = loadAccounts()[alias];
  if (!acct) throw new Error(`No connected Google account called "${alias}"`);
  if (pending) {
    pending.cancelled = true;
    pending.child.kill();
    await pending.done;
  }

  const args = ["auth.js", alias, ...((acct.scopes || []).includes(DRIVE_READONLY_SCOPE) ? ["--with-drive-readonly"] : [])];
  const child = spawn(process.execPath, args, { cwd: ACCOUNTS_DIR, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, cancelled: false, timedOut: false };
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

  if (run.cancelled) throw new Error(`Sign-in for "${alias}" was replaced by a newer one. Its old sign-in is unchanged.`);
  if (run.timedOut) throw new Error(`Sign-in for "${alias}" wasn't finished within 5 minutes. Its old sign-in is unchanged.`);
  if (code !== 0) {
    // auth.js prints a one-line reason last (state mismatch, no refresh token, ...).
    const reason = error || output.trim().split("\n").pop() || `auth.js exited with code ${code}`;
    throw new Error(`"${alias}" wasn't signed in again: ${reason}`);
  }

  const after = loadAccounts()[alias]?.email;
  return {
    alias,
    email: after,
    // Signing in as a different Google account takes the alias over.
    switchedFrom: after && after !== acct.email ? acct.email : null,
  };
}
