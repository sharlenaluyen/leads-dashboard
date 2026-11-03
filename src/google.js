import { google } from "googleapis";
import {
  createAuthClient,
  createAuditLogger,
  getAccountInfo,
  getConnectedAliases,
  withRetry,
  REQUIRED_SCOPES,
} from "google-mcp-accounts";

export { getAccountInfo, getConnectedAliases, withRetry };

// Same shared ~/.google-mcp/audit.log the MCP servers write to.
export const audit = createAuditLogger("leads-dashboard");

const clientCache = new Map();

// Cached per account *and* refresh token: accounts.json is re-read on every
// call, so after ./refresh-tokens.sh the next request uses the new sign-in
// without restarting the dashboard.
function clientFor(product, alias, build) {
  const info = getAccountInfo(alias);
  const key = `${product}:${info.alias}:${info.refresh_token}`;
  if (!clientCache.has(key)) {
    const auth = createAuthClient(info.alias, { OAuth2: google.auth.OAuth2, requiredScopes: REQUIRED_SCOPES[product] });
    clientCache.set(key, build(auth));
  }
  return clientCache.get(key);
}

export function sheetsClientFor(alias) {
  return clientFor("sheets", alias, (auth) => google.sheets({ version: "v4", auth }));
}

export function gmailClientFor(alias) {
  return clientFor("gmail", alias, (auth) => google.gmail({ version: "v1", auth }));
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

// Google returns invalid_grant when a refresh token has expired (every 7 days
// while the OAuth app is in Testing mode). Turn it into an actionable message.
export function explainGoogleError(err, alias) {
  const msg = String(err?.response?.data?.error || err?.message || err);
  if (/invalid_grant/i.test(msg)) {
    return `Google sign-in for "${alias}" has expired. Run ./refresh-tokens.sh in google-mcp-accounts (or node auth.js ${alias}), then sync again.`;
  }
  return err?.response?.data?.error?.message || err?.message || String(err);
}

export function isAuthExpired(err) {
  return /invalid_grant/i.test(String(err?.response?.data?.error || err?.message || err));
}
