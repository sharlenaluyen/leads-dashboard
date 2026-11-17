import { test } from "node:test";
import assert from "node:assert/strict";
import { UserError, during } from "../src/errors.js";
import { StaleRowError } from "../src/edits.js";
import { explainGoogleError, explainingGoogleErrors, getAccountInfo, googleFailure } from "../src/google.js";

// Shaped like the gaxios errors googleapis throws.
const gaxios = (props) => Object.assign(new Error(props.message || "request failed"), { config: { url: "https://sheets.googleapis.com/" } }, props);

test("an expired sign-in names the account and is a UserError", () => {
  const err = googleFailure(gaxios({ message: "invalid_grant", response: { data: { error: "invalid_grant" } } }), "work");
  assert.ok(err instanceof UserError);
  assert.match(err.message, /sign-in for "work" has expired/);
  assert.equal(err.cause.message, "invalid_grant");
});

test("a timed-out Google call says so and suggests trying again", () => {
  const err = googleFailure(gaxios({ message: "The operation was aborted due to timeout", code: "TimeoutError" }), "work");
  assert.ok(!(err instanceof UserError));
  assert.match(err.message, /didn't answer within 30 seconds/);
});

test("being offline says to check the connection, even when the code is on a nested cause", () => {
  const offline = gaxios({ message: "request to https://x failed, reason: getaddrinfo ENOTFOUND", cause: Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }) });
  assert.match(explainGoogleError(offline, "work"), /Couldn't reach Google \(ENOTFOUND\)/);
});

test("Google's own message is kept for other API errors", () => {
  const err = googleFailure(gaxios({ code: 403, response: { status: 403, data: { error: { message: "The caller does not have permission" } } } }), "work");
  assert.equal(err.message, "The caller does not have permission");
});

test("a failed call says which step failed, and the innermost step wins", async () => {
  const forbidden = gaxios({ code: 403, response: { status: 403, data: { error: { message: "The caller does not have permission" } } } });
  const thrown = await during("Syncing Gmail", () => during("Listing Gmail drafts", async () => { throw forbidden; })).catch((e) => e);
  assert.equal(thrown, forbidden);
  assert.equal(explainGoogleError(thrown, "work"), "Listing Gmail drafts failed: The caller does not have permission (403)");
});

test("a 404 names what was asked for and the account, since Google's text names neither", async () => {
  const missing = gaxios({ code: 404, response: { status: 404, data: { error: { message: "Requested entity was not found." } } } });
  assert.equal(
    explainGoogleError(missing, "travels"),
    `Google can't find it, or the "travels" account isn't allowed to see it (404: Requested entity was not found.)`
  );
  const thrown = await during("Reading Gmail message 18c (Gmail draft r-1)", async () => { throw missing; }).catch((e) => e);
  assert.equal(
    explainGoogleError(thrown, "travels"),
    `Reading Gmail message 18c (Gmail draft r-1) failed: Google can't find it, or the "travels" account isn't allowed to see it (404: Requested entity was not found.)`
  );
});

test("a timeout says which call hung", async () => {
  const slow = gaxios({ message: "The operation was aborted due to timeout", code: "TimeoutError" });
  const thrown = await during("Listing Gmail drafts", async () => { throw slow; }).catch((e) => e);
  assert.match(explainGoogleError(thrown, "work"), /didn't answer within 30 seconds \(listing Gmail drafts\)/);
});

test("non-Google errors and UserErrors pass through unchanged", async () => {
  const bug = new TypeError("x is undefined");
  assert.equal(googleFailure(bug, "work"), bug);
  const user = new UserError("Tab is missing columns");
  await assert.rejects(explainingGoogleErrors("work", async () => { throw user; }), (e) => e === user);
});

test("setup problems from the accounts package are UserErrors", () => {
  assert.throws(() => getAccountInfo("no-such-account-xyz"), (e) => e instanceof UserError);
});

test("a row that moved since the last sync is a UserError", () => {
  assert.ok(new StaleRowError("moved") instanceof UserError);
});
