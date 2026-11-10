import { extractEmailAddress, headerValue, splitAddressList, threadReplyState } from "multi-gmail-mcp/src/gmail.js";

// Labels that mean a message isn't real correspondence for follow-up purposes.
const IGNORED_LABELS = ["DRAFT", "SPAM", "TRASH", "CHAT"];
// A message gaining one of these counts as deleted.
const GONE_LABELS = ["TRASH", "SPAM"];
// Gmail search queries get unreliable past a few hundred characters, so
// address lists are split into chunks this size.
const ADDRESSES_PER_QUERY = 15;
const BACKFILL_CONCURRENCY = 4;
// How many of a lead's messages a first lookup scans to learn its threads.
// It's the same single list call either way; this only sets the page size.
const THREADS_PER_LEAD = 100;

// Gmail's own tabs for bulk mail. Messages there never introduce a new
// contact (a lead's message there still counts for that lead).
const BULK_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];
const AUTOMATED_ADDRESS = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)([._+-]|@)/i;

// Bounces. Gmail's come from "Mail Delivery Subsystem <mailer-daemon@googlemail.com>";
// other servers use postmaster@ or a name like "Mail Delivery System".
const BOUNCE_ADDRESS = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_TEXT = /mail delivery (subsystem|system|service)/i;
// Subjects only count alongside an Auto-Submitted header, so a person
// writing "undeliverable" isn't taken for a bounce.
const BOUNCE_SUBJECT =
  /^\s*(delivery status notification|undeliverable|undelivered mail|mail delivery failed|returned mail|delivery failure|failure notice|message not delivered|non-?delivery)/i;
// "Still trying" notices: not a bounce yet, and not a reply either.
const DELAY_TEXT = /\(delay\)|\bdelayed\b|delivery incomplete|temporary (problem|failure)/i;
const AUTO_REPLY_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office|ooo\b|on vacation|vacation reply|away from)/i;

// Headers needed to tell people from machines (beyond From/To/Cc).
const AUTOMATION_HEADERS = ["Subject", "Auto-Submitted", "X-Failed-Recipients", "Content-Type", "X-Autoreply", "X-Autorespond"];

/**
 * What kind of machine sent a received message, if any:
 *   "bounce": a delivery failure for something you sent
 *   "auto":   an out-of-office, vacation or other automatic reply, or a
 *             delivery-delay notice; treated as if it never arrived
 *   null:     a person (or anything not recognized as automatic)
 */
export function automatedKind(msg) {
  if ((msg.labelIds || []).includes("SENT")) return null;
  const headers = msg.payload?.headers;
  const h = (name) => headerValue(headers, name) || "";
  const from = h("From");
  const subject = h("Subject");
  const snippet = msg.snippet || "";
  const autoSubmitted = /^\s*auto-/i.test(h("Auto-Submitted"));
  const bounce =
    Boolean(h("X-Failed-Recipients")) ||
    /report-type="?delivery-status/i.test(h("Content-Type")) ||
    BOUNCE_ADDRESS.test(extractEmailAddress(from)) ||
    BOUNCE_TEXT.test(from) ||
    BOUNCE_TEXT.test(snippet) ||
    (autoSubmitted && BOUNCE_SUBJECT.test(subject));
  if (bounce) return DELAY_TEXT.test(`${subject} ${snippet}`) ? "auto" : "bounce";
  if (autoSubmitted || h("X-Autoreply") || h("X-Autorespond") || /auto_reply/i.test(h("Precedence")) || AUTO_REPLY_SUBJECT.test(subject)) {
    return "auto";
  }
  return null;
}

const isIgnored = (labelIds) => (labelIds || []).some((l) => IGNORED_LABELS.includes(l));

// Whether a new message could introduce someone not in any sheet: anything
// you sent, or mail to your inbox outside Gmail's bulk categories.
const mayIntroduce = (labelIds = []) =>
  labelIds.includes("SENT") || (labelIds.includes("INBOX") && !labelIds.some((l) => BULK_CATEGORIES.includes(l)));

// "Jane Doe <jane@x.com>" -> "Jane Doe"
function displayName(addr) {
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(addr || "");
  return m ? m[1].trim() : "";
}

// The people a message introduces: whoever you sent it to, or whoever sent
// it to you, unless it looks automated or bulk.
export function contactsIn(msg, selfAddresses) {
  const headers = msg.payload?.headers;
  const bulk =
    headerValue(headers, "List-Unsubscribe") ||
    /bulk|list|junk/i.test(headerValue(headers, "Precedence") || "") ||
    /^auto-/i.test(headerValue(headers, "Auto-Submitted") || "");
  const sent = (msg.labelIds || []).includes("SENT");
  if (!sent && bulk) return [];
  const list = sent ? splitAddressList(headerValue(headers, "To")) : splitAddressList(headerValue(headers, "From"));
  return list
    .map((a) => ({ email: extractEmailAddress(a), name: displayName(a) }))
    .filter((c) => c.email.includes("@") && !selfAddresses.has(c.email) && !AUTOMATED_ADDRESS.test(c.email));
}

function addressQuery(emails, { sentOnly = false } = {}) {
  const terms = emails.flatMap((e) => (sentOnly ? [`to:${e}`, `cc:${e}`] : [`from:${e}`, `to:${e}`, `cc:${e}`]));
  return `{${terms.join(" ")}}${sentOnly ? " in:sent" : ""} -in:draft`;
}

// Every address a lead's email cell holds (see emailsIn), first one first.
export const addressesOf = (lead) => (lead.all_emails ? lead.all_emails.split(",").filter(Boolean) : [lead.email]);

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Runs fn over items with at most `limit` running at once; results keep
// the items' order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// A message's metadata reduced to what follow-up tracking needs.
//   dir:  "sent" | "received" | "bounced"
//   skip: an automatic reply (out of office and the like) that counts as
//         if it never arrived
export function summarizeMessage(msg) {
  const headers = msg.payload?.headers;
  const fromYou = threadReplyState([msg]).last_message_from_you;
  const kind = fromYou ? null : automatedKind(msg);
  const addresses = [
    ...splitAddressList(headerValue(headers, "From")),
    ...splitAddressList(headerValue(headers, "To")),
    ...splitAddressList(headerValue(headers, "Cc")),
    // The address that failed, so a bounce outside the lead's thread still
    // finds its lead.
    ...(kind === "bounce" ? splitAddressList(headerValue(headers, "X-Failed-Recipients")) : []),
  ].map(extractEmailAddress);
  return {
    id: msg.id,
    threadId: msg.threadId,
    at: Number(msg.internalDate),
    dir: fromYou ? "sent" : kind === "bounce" ? "bounced" : "received",
    skip: kind === "auto",
    addresses: new Set(addresses),
  };
}

async function getMeta(gmail, id, counter) {
  const { data } = await counter.run(() =>
    gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Date", "List-Unsubscribe", "Precedence", ...AUTOMATION_HEADERS],
    })
  );
  return data;
}

// [{ id, threadId }], newest first.
async function listIds(gmail, q, counter, { max = 500 } = {}) {
  const found = [];
  let pageToken;
  do {
    const { data } = await counter.run(() =>
      gmail.users.messages.list({ userId: "me", q, maxResults: Math.min(max - found.length, 500), pageToken })
    );
    for (const m of data.messages || []) found.push({ id: m.id, threadId: m.threadId });
    pageToken = data.nextPageToken;
  } while (pageToken && found.length < max);
  return found;
}

// Every draft in the mailbox: [{ id, message: { id, threadId } }].
async function listDrafts(gmail, counter) {
  const drafts = [];
  let pageToken;
  do {
    const { data } = await counter.run(() => gmail.users.drafts.list({ userId: "me", maxResults: 500, pageToken }));
    drafts.push(...(data.drafts || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return drafts;
}

// Applies one message to a lead's Gmail fields. Returns the new fields if
// anything changed, else null.
export function applyMessage(lead, m) {
  const change = {};
  if (lead.last_email_at == null || m.at > lead.last_email_at) {
    change.last_email_at = m.at;
    change.last_email_dir = m.dir;
    change.last_message_id = m.id;
    change.thread_id = m.threadId;
  }
  if (m.dir === "sent" && (lead.last_followed_up_at == null || m.at > lead.last_followed_up_at)) {
    change.last_followed_up_at = m.at;
    change.last_sent_id = m.id;
  }
  return Object.keys(change).length ? change : null;
}

// A full look at one lead, from scratch: its threads, its newest message
// either way, and its newest sent one. Three calls, plus one for each
// automatic reply passed over (up to AUTO_REPLY_SCAN).
const AUTO_REPLY_SCAN = 5;
async function backfillLead(gmail, lead, counter) {
  const found = await listIds(gmail, addressQuery(addressesOf(lead)), counter, { max: THREADS_PER_LEAD });
  const change = {
    gmail_checked: 1,
    last_email_at: null,
    last_email_dir: null,
    last_message_id: null,
    thread_id: null,
    last_followed_up_at: null,
    last_sent_id: null,
    threads: new Set(found.map((m) => m.threadId)),
    replaceThreads: true,
  };
  if (!found.length) return change;
  let newest = null;
  for (const { id } of found.slice(0, AUTO_REPLY_SCAN)) {
    const m = summarizeMessage(await getMeta(gmail, id, counter));
    if (!m.skip) {
      newest = m;
      break;
    }
  }
  if (newest) Object.assign(change, applyMessage({}, newest));
  if (newest?.dir !== "sent") {
    const [sent] = await listIds(gmail, addressQuery(addressesOf(lead), { sentOnly: true }), counter, { max: 1 });
    if (sent) Object.assign(change, applyMessage(change, summarizeMessage(await getMeta(gmail, sent.id, counter))));
  }
  return change;
}

// What changed in the mailbox since `historyId`. Returns null when the
// bookmark is too old for Gmail to answer.
//   added:         [{ id, threadId, labelIds }] real messages that arrived or were restored
//   gone:          ids deleted, trashed or marked spam
//   draftsTouched: whether any draft was created, edited, sent or discarded
async function historySince(gmail, historyId, counter) {
  const added = new Map();
  const gone = new Set();
  let draftsTouched = false;
  let pageToken;
  let latest = historyId;
  try {
    do {
      const { data } = await counter.run(() =>
        gmail.users.history.list({
          userId: "me",
          startHistoryId: historyId,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
          maxResults: 500,
          pageToken,
        })
      );
      for (const h of data.history || []) {
        for (const { message } of h.messagesAdded || []) {
          if ((message.labelIds || []).includes("DRAFT")) draftsTouched = true;
          else if (!isIgnored(message.labelIds)) added.set(message.id, { threadId: message.threadId, labelIds: message.labelIds || [] });
        }
        // Gmail replaces a draft's message on every save and on send, so a
        // deletion usually means a draft changed.
        for (const { message } of h.messagesDeleted || []) {
          gone.add(message.id);
          draftsTouched = true;
        }
        for (const { message, labelIds } of h.labelsAdded || []) {
          if (labelIds?.includes("DRAFT")) draftsTouched = true;
          if (labelIds?.some((l) => GONE_LABELS.includes(l))) gone.add(message.id);
        }
        for (const { message, labelIds } of h.labelsRemoved || []) {
          if (labelIds?.includes("DRAFT")) draftsTouched = true;
          if (labelIds?.some((l) => GONE_LABELS.includes(l))) {
            gone.delete(message.id);
            added.set(message.id, { threadId: message.threadId, labelIds: [] });
          }
        }
      }
      latest = data.historyId || latest;
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
  for (const id of gone) added.delete(id);
  return { added: [...added].map(([id, m]) => ({ id, ...m })), gone, draftsTouched, historyId: latest };
}

/**
 * Brings every lead for one Gmail account up to date.
 *
 *   leads:     rows from the leads table for this account (all sources)
 *   threads:   Map(leadId -> Set(threadId)) already known for those leads
 *   cursor:    { history_id, synced_at } or undefined on the first run
 *   draftMeta: Map(messageId -> { threadId, at, addresses }) from last time
 *   self:      this account's own addresses, never treated as contacts
 *
 * Returns {
 *   changes:   Map(leadId -> fields, plus `threads` to add and `replaceThreads`)
 *   cursor:    { history_id, synced_at }
 *   draftMeta: the new Map when drafts were rechecked, else undefined
 *   contacts:  Map(email -> { email, name, firstAt, lastAt, lastDir, threadId, messageId, count, viaLead })
 *              people in new mail who aren't among `leads`. `viaLead` is the
 *              lead whose thread they replied in, if any.
 *   replies:   Set(leadId) of leads with a new reply this sync (not from a
 *              first or reset lookup, which only reflects old mail)
 * }
 *
 * Cost: when nothing happened since the last sync this is one history.list
 * call. A new or reset lead costs up to three calls, once. Drafts cost one
 * list call, plus one per new draft, and only when a draft changed. Finding
 * new contacts costs one call per new message you sent or got in your
 * inbox's Primary tab. Gmail's bulk categories never introduce a contact,
 * though a lead's own mail there still counts for that lead.
 */
export async function syncAccount(gmail, { leads, threads = new Map(), cursor, draftMeta = new Map(), self = new Set() }, counter) {
  const changes = new Map();
  const contacts = new Map();
  const replies = new Set();
  const startedAt = Date.now();
  const merged = (lead) => ({ ...lead, ...changes.get(lead.id) });
  const record = (lead, change) => {
    if (!change) return;
    const prev = changes.get(lead.id) || {};
    const next = { ...prev, ...change };
    if (prev.threads && change.threads && !change.replaceThreads) next.threads = new Set([...prev.threads, ...change.threads]);
    changes.set(lead.id, next);
  };
  const threadsOf = (lead) => {
    const c = changes.get(lead.id);
    if (c?.replaceThreads) return c.threads;
    return new Set([...(threads.get(lead.id) || []), ...(c?.threads || [])]);
  };

  let h = null;
  let nextHistoryId;
  let fallbackAfter = null;
  if (!cursor) {
    // Take the bookmark before searching, so anything arriving mid-backfill
    // is picked up next time.
    const { data } = await counter.run(() => gmail.users.getProfile({ userId: "me" }));
    nextHistoryId = data.historyId;
  } else {
    h = await historySince(gmail, cursor.history_id, counter);
    if (h) {
      nextHistoryId = h.historyId;
    } else {
      // Bookmark expired (Gmail keeps about a week of history): fall back to
      // a date search from the last sync, with an hour of overlap.
      const { data } = await counter.run(() => gmail.users.getProfile({ userId: "me" }));
      nextHistoryId = data.historyId;
      fallbackAfter = Math.floor((cursor.synced_at - 3600_000) / 1000);
    }
  }

  // New leads, and leads whose newest email was deleted, are looked up from
  // scratch so their dates reflect what's in the mailbox now.
  const gone = h?.gone || new Set();
  const redo = leads.filter((l) => !l.gmail_checked || gone.has(l.last_message_id) || gone.has(l.last_sent_id));
  await mapLimit(redo, BACKFILL_CONCURRENCY, async (lead) => record(lead, await backfillLead(gmail, lead, counter)));

  if (cursor && (leads.length || h?.added.length)) {
    const byEmail = new Map();
    const byThread = new Map();
    const add = (map, key, lead) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(lead);
    };
    for (const lead of leads) {
      for (const e of addressesOf(lead)) add(byEmail, e, lead);
      for (const t of threadsOf(lead)) add(byThread, t, lead);
    }

    let candidateIds = [];
    // Only these may introduce a new contact; others are fetched just to
    // check them against leads.
    const introIds = new Set();
    if (fallbackAfter != null) {
      for (const emails of chunk([...byEmail.keys()], ADDRESSES_PER_QUERY)) {
        candidateIds.push(...(await listIds(gmail, `${addressQuery(emails)} after:${fallbackAfter}`, counter)).map((m) => m.id));
      }
    } else if (h.added.length) {
      // Anything in a lead's thread counts, whoever it's from: it's checked
      // directly. For the rest, fetching every new message's headers costs
      // one call each; a search limited to the leads' addresses costs one
      // call per chunk of addresses plus one per match. Take whichever is
      // fewer calls.
      // Mail that could introduce a new contact is fetched too, to find out.
      const direct = h.added.filter((m) => byThread.has(m.threadId) || mayIntroduce(m.labelIds));
      const directSet = new Set(direct);
      const other = h.added.filter((m) => !directSet.has(m));
      candidateIds.push(...direct.map((m) => m.id));
      // A reply in a lead's thread can introduce someone whatever Gmail tab
      // it landed in; anything else has to look like personal mail.
      for (const m of direct) {
        const sent = (m.labelIds || []).includes("SENT");
        if (mayIntroduce(m.labelIds) || (!sent && byThread.has(m.threadId))) introIds.add(m.id);
      }
      const searchCalls = Math.ceil(byEmail.size / ADDRESSES_PER_QUERY);
      if (other.length <= searchCalls) {
        candidateIds.push(...other.map((m) => m.id));
      } else {
        const after = Math.floor((cursor.synced_at - 3600_000) / 1000);
        const wanted = new Set(other.map((m) => m.id));
        for (const emails of chunk([...byEmail.keys()], ADDRESSES_PER_QUERY)) {
          const found = await listIds(gmail, `${addressQuery(emails)} after:${after}`, counter);
          candidateIds.push(...found.filter((m) => wanted.has(m.id)).map((m) => m.id));
        }
      }
    }

    const metas = await mapLimit([...new Set(candidateIds)], BACKFILL_CONCURRENCY, (id) => getMeta(gmail, id, counter));
    const leadEmails = new Set(byEmail.keys());
    for (const msg of metas) {
      if (isIgnored(msg.labelIds)) continue;
      const m = summarizeMessage(msg);
      if (m.skip) continue;
      const threadLead = m.dir === "received" ? (byThread.get(m.threadId) || [])[0] : null;
      for (const c of introIds.has(msg.id) ? contactsIn(msg, self) : []) {
        if (leadEmails.has(c.email)) continue;
        const prev = contacts.get(c.email);
        const newer = !prev || m.at > prev.lastAt;
        contacts.set(c.email, {
          email: c.email,
          name: prev?.name || c.name,
          firstAt: Math.min(prev?.firstAt ?? m.at, m.at),
          lastAt: newer ? m.at : prev.lastAt,
          lastDir: newer ? m.dir : prev.lastDir,
          threadId: newer ? m.threadId : prev.threadId,
          messageId: newer ? m.id : prev.messageId,
          count: (prev?.count || 0) + 1,
          viaLead: prev?.viaLead ?? threadLead?.id ?? null,
        });
      }
      const targets = new Set(byThread.get(m.threadId) || []);
      for (const email of m.addresses) for (const lead of byEmail.get(email) || []) targets.add(lead);
      for (const lead of targets) {
        const change = applyMessage(merged(lead), m);
        if (change?.last_email_dir === "received") replies.add(lead.id);
        record(lead, change);
        if (!threadsOf(lead).has(m.threadId)) record(lead, { threads: new Set([m.threadId]) });
      }
    }
  }

  // Drafts: rechecked whenever one changed, and on first or reset lookups.
  // A lead's draft is its newest draft that the sheet links to, that's in
  // one of its threads, or that's addressed to it.
  let nextDraftMeta;
  if (!h || h.draftsTouched || redo.length) {
    const drafts = await listDrafts(gmail, counter);
    nextDraftMeta = new Map();
    const unseen = drafts.filter((d) => !draftMeta.has(d.message.id));
    const fetched = await mapLimit(unseen, BACKFILL_CONCURRENCY, (d) => getMeta(gmail, d.message.id, counter));
    const fresh = new Map(fetched.map((msg) => [msg.id, msg]));
    const current = drafts.map((d) => {
      let meta = draftMeta.get(d.message.id);
      if (!meta) {
        const m = summarizeMessage(fresh.get(d.message.id));
        meta = { threadId: m.threadId, at: m.at, addresses: [...m.addresses] };
      }
      nextDraftMeta.set(d.message.id, meta);
      return { id: d.id, messageId: d.message.id, ...meta };
    });
    for (const lead of leads) {
      const mine = threadsOf(lead);
      // A draft the sheet already points to stays linked while it exists,
      // even with no recipient yet (by draft id, or by message id as other
      // tools record it).
      const linked = (d) => lead.draft_id && (d.id === lead.draft_id || d.messageId === lead.draft_id);
      const best = current
        .filter((d) => linked(d) || mine.has(d.threadId) || addressesOf(lead).some((e) => d.addresses.includes(e)))
        .sort((a, b) => b.at - a.at)[0];
      const want = best?.id ?? null;
      if ((merged(lead).gmail_draft_id ?? null) !== want) record(lead, { gmail_draft_id: want });
    }
  }

  return { changes, cursor: { history_id: String(nextHistoryId), synced_at: startedAt }, draftMeta: nextDraftMeta, contacts, replies };
}
