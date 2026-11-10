import crypto from "crypto";
import fs from "fs";

// The page's own inline <script> blocks (the theme script in index.html that
// runs before first paint), as CSP hashes. Read from the file at startup, so
// editing that script never needs a hash updated by hand.
export function inlineScriptHashes(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    ([, body]) => `'sha256-${crypto.createHash("sha256").update(body, "utf8").digest("base64")}'`
  );
}

// Everything the dashboard loads comes from this server. frame-ancestors
// 'none' stops another site loading the dashboard in a hidden frame and
// tricking you into clicking its buttons (Hard reset, Save draft, ...).
export function contentSecurityPolicy(html) {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(" ")}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Express middleware setting the headers on every response.
export function securityHeaders(indexHtmlPath) {
  const csp = contentSecurityPolicy(fs.readFileSync(indexHtmlPath, "utf8"));
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    // For browsers that predate frame-ancestors.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
}
