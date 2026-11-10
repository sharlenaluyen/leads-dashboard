import { google } from "googleapis";
import {
  createAuthClient,
  createAuditLogger,
  getAccountInfo as lookupAccount,
  getConnectedAliases,
  withRetry,
  REQUIRED_SCOPES,
} from "google-mcp-accounts";
import { UserError } from "./errors.js";

export { getConnectedAliases, withRetry };

// The accounts package throws plain errors for setup problems (an unknown
// account, a missing scope, no credentials file). Their messages already
// say what to do, so they're UserErrors here: no stack trace in the log.
function setupProblem(fn) {
  try {
    return fn();
  } catch (err) {
    throw err instanceof UserError ? err : new UserError(err?.message || String(err), { cause: err });
  }
}

export function getAccountInfo(alias) {
  return setupProblem(() => lookupAccount(alias));
}

// Same shared ~/.google-mcp/audit.log the MCP servers write to.
export const audit = createAuditLogger("leads-dashboard");

const clientCache = new Map();

// googleapis has no request timeout by default, so one call that never
// answers would hold the sheet lock (lock.js) and freeze every later write.
// Applies to each attempt, including the OAuth token refresh; a timed-out
// call fails rather than being retried.
export const REQUEST_TIMEOUT_MS = 30_000;

// Cached per account *and* refresh token: accounts.json is re-read on every
// call, so after a sign-in (the dashboard's Google sign-ins button, or
// ./refresh-tokens.sh) the next request uses the new sign-in
// without restarting the dashboard.
function clientFor(product, alias, build) {
  const info = getAccountInfo(alias);
  const key = `${product}:${info.alias}:${info.refresh_token}`;
  if (!clientCache.has(key)) {
    const auth = setupProblem(() => createAuthClient(info.alias, { OAuth2: google.auth.OAuth2, requiredScopes: REQUIRED_SCOPES[product] }));
    auth.transporter.defaults = { ...auth.transporter.defaults, timeout: REQUEST_TIMEOUT_MS };
    clientCache.set(key, build(auth));
  }
  return clientCache.get(key);
}

export function sheetsClientFor(alias) {
  return clientFor("sheets", alias, (auth) => google.sheets({ version: "v4", auth, timeout: REQUEST_TIMEOUT_MS }));
}

export function gmailClientFor(alias) {
  return clientFor("gmail", alias, (auth) => google.gmail({ version: "v1", auth, timeout: REQUEST_TIMEOUT_MS }));
}

// Counts Google API calls made during one sync, so the UI can show what a
// sync actually cost.
export class CallCounter {
  constructor() {
    this.count = 0;
  }
  run(fn) {
    this.count++;
    return withRetry(fn);
  }
}

// Errors from fetch/undici that mean Google couldn't be reached at all.
const OFFLINE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

function networkCode(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) if (OFFLINE_CODES.has(e.code)) return e.code;
  return null;
}

// Turns a Google API failure into a message that says what to do.
// Google returns invalid_grant when a refresh token has expired (every 7 days
// while the OAuth app is in Testing mode).
export function explainGoogleError(err, alias) {
  const msg = String(err?.response?.data?.error || err?.message || err);
  if (/invalid_grant/i.test(msg)) {
    return `Google sign-in for "${alias}" has expired. Click "Google sign-ins" at the top of the dashboard to sign in again, then sync again.`;
  }
  if (err?.code === "TimeoutError" || err?.name === "TimeoutError") {
    return `Google didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again in a moment.`;
  }
  if (networkCode(err)) {
    return `Couldn't reach Google (${networkCode(err)}). Check your internet connection, then try again.`;
  }
  return err?.response?.data?.error?.message || err?.message || String(err);
}

// Gaxios errors (every googleapis failure, including the token refresh)
// carry the request's config.
const isGoogleError = (err) => Boolean(err && typeof err === "object" && err.config && !(err instanceof UserError));

// The error to throw for a failure in a Google call: Google failures get
// explainGoogleError's message (an expired sign-in is a UserError, since
// the fix is yours), keeping the original as `cause` for the log. Anything
// else is returned unchanged.
export function googleFailure(err, alias) {
  if (!isGoogleError(err)) return err;
  const message = explainGoogleError(err, alias);
  return isAuthExpired(err) ? new UserError(message, { cause: err }) : new Error(message, { cause: err });
}

// Runs fn, rethrowing any Google failure through googleFailure.
export async function explainingGoogleErrors(alias, fn) {
  try {
    return await fn();
  } catch (err) {
    throw googleFailure(err, alias);
  }
}

export function isAuthExpired(err) {
  return /invalid_grant/i.test(String(err?.response?.data?.error || err?.message || err));
}
