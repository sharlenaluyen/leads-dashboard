import { buildRawMessage, extractPlainTextBody, fromAddressFor, headerValue } from "multi-gmail-mcp/src/gmail.js";
import { getSource, loadSettings } from "./config.js";
import { getDb } from "./db.js";
import { audit, explainingGoogleErrors, getAccountInfo, gmailClientFor, withRetry } from "./google.js";
import { draftEmails } from "./drafter/index.js";
import { setLeadFieldNow } from "./edits.js";
import { automatedKind, mapLimit } from "./gmailSync.js";
import { withSheetLock } from "./lock.js";
import { UserError } from "./errors.js";

const THREAD_MESSAGES = 6;
// Gmail thread reads at once while gathering leads to draft.
const THREAD_CONCURRENCY = 4;

function getLead(id) {
  const lead = getDb().prepare("SELECT * FROM leads WHERE id = ?").get(id);
  if (!lead) throw new UserError(`Lead ${id} not found. Sync and try again.`);
  return lead;
}

// The last few real messages of the lead's newest thread, oldest first.
// Bounces and automatic replies are left out: the lead didn't write them.
async function loadThread(gmail, lead) {
  if (!lead.thread_id) return [];
  const { data } = await withRetry(() => gmail.users.threads.get({ userId: "me", id: lead.thread_id, format: "full" }));
  return (data.messages || [])
    .filter((m) => !(m.labelIds || []).includes("DRAFT") && !automatedKind(m))
    .slice(-THREAD_MESSAGES)
    .map((m) => ({
      dir: (m.labelIds || []).includes("SENT") ? "sent" : "received",
      from: headerValue(m.payload?.headers, "From"),
      date: new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " "),
      text: extractPlainTextBody(m.payload).trim(),
    }));
}

/**
 * Drafts text for the given leads. Nothing is saved anywhere. templateId
 * picks a saved email (Settings → Drafting) to send with a written greeting.
 */
export async function generateDrafts(leadIds, instructions, templateId = null) {
  let template = null;
  if (templateId) {
    template = (loadSettings().draftTemplates || []).find((t) => t.id === templateId);
    if (!template) throw new UserError("That saved email no longer exists. Pick another, or reload the page.");
  }
  const leads = leadIds.map(getLead);
  const items = await mapLimit(leads, THREAD_CONCURRENCY, async (lead) => {
    const source = getSource(lead.source_id);
    const thread = await explainingGoogleErrors(source.account, () => loadThread(gmailClientFor(source.account), lead));
    return { key: String(lead.id), businessName: lead.business_name, email: lead.email, notes: lead.notes, thread };
  });
  const drafts = await draftEmails(items, instructions, template);
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  return leads.map((lead) => {
    const d = byKey.get(String(lead.id));
    return {
      leadId: lead.id,
      businessName: lead.business_name,
      email: (lead.all_emails ? lead.all_emails.split(",") : [lead.email]).join(", "),
      inThread: Boolean(lead.thread_id),
      replacesDraft: Boolean(lead.gmail_draft_id || lead.draft_id),
      subject: d?.subject || "",
      body: d?.body || "",
      error: d?.error || (d ? null : "Claude didn't return a draft for this lead"),
    };
  });
}

async function draftExists(gmail, draftId) {
  if (!draftId) return false;
  try {
    await gmail.users.drafts.get({ userId: "me", id: draftId, format: "minimal" });
    return true;
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return false;
    throw err;
  }
}

/**
 * Saves one reviewed draft to Gmail: a reply in the lead's thread when there
 * is one, else a new message. Replaces the lead's previous dashboard draft if
 * it still exists. Only ever calls drafts.create / drafts.update - there's
 * no sending code in this dashboard. Holds the sheet lock: it waits for a
 * running sync, and a second save for the same lead (a double click) waits
 * for the first and then replaces its draft instead of making another.
 */
export function saveDraft(leadId, draft) {
  return withSheetLock(() => saveDraftNow(leadId, draft));
}

async function saveDraftNow(leadId, { subject, body }) {
  if (!loadSettings().createDrafts) {
    throw new UserError("Saving Gmail drafts is turned off (Settings → Save Gmail drafts).");
  }
  if (!body?.trim()) throw new UserError("The draft is empty");
  const lead = getLead(leadId);
  const source = getSource(lead.source_id);
  const gmail = gmailClientFor(source.account);
  const info = getAccountInfo(source.account);
  const from = fromAddressFor(info);

  let threadId;
  let inReplyTo;
  let references;
  let finalSubject = subject?.trim() || "Following up";
  if (lead.thread_id && lead.last_message_id) {
    const { data: last } = await explainingGoogleErrors(source.account, () =>
      withRetry(() =>
        gmail.users.messages.get({
          userId: "me",
          id: lead.last_message_id,
          format: "metadata",
          metadataHeaders: ["Subject", "Message-Id", "References"],
        })
      )
    );
    const headers = last.payload?.headers;
    const originalSubject = headerValue(headers, "Subject");
    inReplyTo = headerValue(headers, "Message-Id") || undefined;
    references = [headerValue(headers, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
    finalSubject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    threadId = last.threadId;
  }

  // Always addressed to the lead, even when the newest message is the
  // user's own (a nudge after no reply).
  // Everyone in the row's email cell: the lead plus colleagues who joined.
  const to = (lead.all_emails ? lead.all_emails.split(",") : [lead.email]).join(", ");
  const raw = buildRawMessage({ to, from, subject: finalSubject, body, inReplyTo, references });
  const message = { raw, ...(threadId ? { threadId } : {}) };

  // Gmail's view of the lead's draft wins over the sheet's copy of the id.
  const existingId = lead.gmail_draft_id || lead.draft_id;
  const { replacing, data } = await explainingGoogleErrors(source.account, async () => {
    const replacing = await draftExists(gmail, existingId);
    const { data } = replacing
      ? await withRetry(() => gmail.users.drafts.update({ userId: "me", id: existingId, requestBody: { message } }))
      : await withRetry(() => gmail.users.drafts.create({ userId: "me", requestBody: { message } }));
    return { replacing, data };
  });

  audit({
    action: replacing ? "update_draft" : "draft_reply_to_message",
    account: source.account,
    email: info.email,
    outcome: replacing ? "updated" : "drafted",
    detail: { to, subject: finalSubject, draft_id: data.id, thread_id: threadId },
  });

  getDb().prepare("UPDATE leads SET gmail_draft_id = ? WHERE id = ?").run(data.id, lead.id);
  let sheetUpdated = false;
  if (data.id !== lead.draft_id) {
    if (loadSettings().writeBack) {
      await setLeadFieldNow(lead.id, "draftId", data.id);
      sheetUpdated = true;
    } else {
      getDb().prepare("UPDATE leads SET draft_id = ? WHERE id = ?").run(data.id, lead.id);
    }
  }
  return { draftId: data.id, replaced: replacing, threadId, subject: finalSubject, sheetUpdated };
}
