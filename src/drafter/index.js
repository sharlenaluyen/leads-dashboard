import { loadSettings } from "../config.js";
import * as claudeCode from "./claudeCode.js";
import * as api from "./api.js";
import { GREETING_SYSTEM_PROMPT, SYSTEM_PROMPT, assembleSaved, buildGreetingPrompt, buildPrompt, parseDrafts, parseGreetings } from "./prompt.js";
import { mapLimit } from "../gmailSync.js";
import { UserError } from "../errors.js";

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
 * template: a saved email ({ name, body }) or null. With one, Claude writes
 * only each greeting, and the body is greeting + saved body + sign-off.
 * Returns [{ key, subject, body }], in batches of settings.draftBatchSize.
 * A batch that still fails after a retry, or runs out of its 2 minutes,
 * doesn't sink the others: its leads
 * come back as { key, error } instead. Only when every batch fails is the
 * error thrown.
 */
export async function draftEmails(items, instructions, template = null) {
  const settings = loadSettings();
  const mode = template
    ? {
        system: GREETING_SYSTEM_PROMPT,
        prompt: (batch) => buildGreetingPrompt(batch, instructions, template),
        parse: (text) =>
          parseGreetings(text).map((g) => ({ key: g.key, subject: g.subject, body: assembleSaved(g.greeting, template.body, settings.draftSignOff) })),
      }
    : {
        system: SYSTEM_PROMPT,
        prompt: (batch) => buildPrompt(batch, instructions, { tone: settings.draftTone, signOff: settings.draftSignOff, aboutMe: settings.draftAboutMe }),
        parse: parseDrafts,
      };
  const backend = BACKENDS[settings.drafter];
  if (!backend) throw new UserError(`Unknown drafter "${settings.drafter}" in settings.json (use "claude-code" or "api")`);
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
          system: mode.system,
          prompt: mode.prompt(batch),
          model: settings.drafterModel || undefined,
          timeoutMs,
        });
        return { drafts: mode.parse(text) };
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
