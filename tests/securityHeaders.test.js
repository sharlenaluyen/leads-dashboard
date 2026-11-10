import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { contentSecurityPolicy, inlineScriptHashes, securityHeaders } from "../src/securityHeaders.js";

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");
const html = fs.readFileSync(INDEX, "utf8");

test("inlineScriptHashes hashes inline scripts only, exactly as written", () => {
  const page = '<script>\n  a();\n</script><script type="module" src="app.js"></script>';
  const want = `'sha256-${crypto.createHash("sha256").update("\n  a();\n").digest("base64")}'`;
  assert.deepEqual(inlineScriptHashes(page), [want]);
});

test("the policy allows index.html's inline theme script and forbids framing", () => {
  const csp = contentSecurityPolicy(html);
  const hashes = inlineScriptHashes(html);
  assert.equal(hashes.length, 1);
  assert.match(csp, new RegExp(`script-src 'self' ${hashes[0].replace(/[+/]/g, "\\$&")}`));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

// The policy has no 'unsafe-inline', so these would be silently blocked.
test("index.html has no inline style attributes or event handlers", () => {
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("securityHeaders sets CSP, X-Frame-Options and nosniff", () => {
  const set = {};
  let called = false;
  securityHeaders(INDEX)({}, { setHeader: (k, v) => (set[k] = v) }, () => (called = true));
  assert.ok(called);
  assert.match(set["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(set["X-Frame-Options"], "DENY");
  assert.equal(set["X-Content-Type-Options"], "nosniff");
});
