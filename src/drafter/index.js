import { loadSettings } from "../config.js";
import * as claudeCode from "./claudeCode.js";
import * as api from "./api.js";
import { SYSTEM_PROMPT, buildPrompt, parseDrafts } from "./prompt.js";
import { mapLimit } from "../gmailSync.js";

const BACKENDS = { "claude-code": claudeCode, api };

// Claude calls at once. Each `claude -p` is its own process, so keep it small.
const DRAFT_CONCURRENCY = 2;
// A batch whose call fails or whose reply can't be read is tried once more,
// but both tries share one time budget, so a stuck batch shows its error
// within BATCH_BUDGET_MS. A retry starts only with at least MIN_ATTEMPT_MS left.
const ATTEMPTS = 2;
const BATCH_BUDGET_MS = 2 * 60_000;
const MIN_ATTEMPT_MS = 20_000;

/**
 * items: [{ key, businessName, email, notes, thread: [{ dir, from, date, text }] }]
 * Returns [{ key, subject, body }], in batches of settings.draftBatchSize.
 * A batch that still fails after a retry, or runs out of its 2 minutes,
 * doesn't sink the others: its leads
 * come back as { key, error } instead. Only when every batch fails is the
 * error thrown.
 */
export async function draftEmails(items, instructions) {
  const settings = loadSettings();
  const backend = BACKENDS[settings.drafter];
  if (!backend) throw new Error(`Unknown drafter "${settings.drafter}" in settings.json (use "claude-code" or "api")`);
  const size = Math.max(1, settings.draftBatchSize || 8);
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const results = await mapLimit(batches, DRAFT_CONCURRENCY, async (batch) => {
    let lastErr;
    const deadline = Date.now() + BATCH_BUDGET_MS;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const timeoutMs = deadline - Date.now();
      if (attempt > 0 && timeoutMs < MIN_ATTEMPT_MS) break;
      try {
        const text = await backend.complete({
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(batch, instructions),
          model: settings.drafterModel || undefined,
          timeoutMs,
        });
        return { drafts: parseDrafts(text) };
      } catch (err) {
        lastErr = err;
      }
    }
    return { error: lastErr, keys: batch.map((item) => item.key) };
  });
  const failed = results.filter((r) => r.error);
  if (failed.length === results.length && failed.length) throw failed[0].error;
  return results.flatMap((r) =>
    r.error ? r.keys.map((key) => ({ key, error: `Drafting failed for this batch: ${r.error.message || r.error}` })) : r.drafts
  );
}
