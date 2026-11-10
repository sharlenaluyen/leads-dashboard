import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMessage, automatedKind, contactsIn, summarizeMessage, syncAccount } from "../src/gmailSync.js";
import { addressWrites, autoStatus, confirmRows, pendingWrites } from "../src/sync.js";
import { formatDate } from "../src/sheets.js";

class Counter {
  count = 0;
  run(fn) {
    this.count++;
    return fn();
  }
}

function msg(id, { at, from, to, sent = false, labels = [], thread }) {
  return {
    id,
    threadId: thread || `t-${id}`,
    internalDate: String(at),
    labelIds: [...(sent ? ["SENT"] : ["INBOX"]), ...labels],
    payload: { headers: [{ name: "From", value: from }, { name: "To", value: to }] },
  };
}

// A fake Gmail client over a fixed mailbox. `q` matching is simplified:
// a message matches if any address in the query appears in its headers,
// and "in:sent" limits to SENT.
function fakeGmail(messages, { history = null, historyGone = false } = {}) {
  const calls = [];
  const addrsOf = (m) => m.payload.headers.map((h) => h.value.toLowerCase()).join(" ");
  return {
    calls,
    users: {
      getProfile: async () => (calls.push("getProfile"), { data: { historyId: "900" } }),
      history: {
        list: async () => {
          calls.push("history.list");
          if (historyGone) throw Object.assign(new Error("gone"), { code: 404 });
          return { data: { historyId: "950", history } };
        },
      },
      messages: {
        list: async ({ q, maxResults }) => {
          calls.push(`list ${q}`);
          const emails = [...q.matchAll(/(?:from|to|cc):([^\s}]+)/g)].map((m) => m[1]);
          const after = /after:(\d+)/.exec(q)?.[1];
          const found = messages
            .filter((m) => !m.labelIds.includes("DRAFT"))
            .filter((m) => emails.some((e) => addrsOf(m).includes(e)))
            .filter((m) => !q.includes("in:sent") || m.labelIds.includes("SENT"))
            .filter((m) => !after || Number(m.internalDate) / 1000 > Number(after))
            .sort((a, b) => b.internalDate - a.internalDate)
            .slice(0, maxResults);
          return { data: { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) } };
        },
        get: async ({ id }) => (calls.push(`get ${id}`), { data: messages.find((m) => m.id === id) }),
      },
      drafts: {
        list: async () => {
          calls.push("drafts.list");
          const drafts = messages.filter((m) => m.labelIds.includes("DRAFT"));
          return { data: { drafts: drafts.map((m) => ({ id: `draft-${m.id}`, message: { id: m.id, threadId: m.threadId } })) } };
        },
      },
    },
  };
}

test("summarizeMessage reads direction from the SENT label and collects addresses", () => {
  const m = summarizeMessage(msg("1", { at: 5, from: "Me <me@x.com>", to: "Lead <Lead@Biz.com>", sent: true }));
  assert.equal(m.dir, "sent");
  assert.ok(m.addresses.has("lead@biz.com"));
});

test("applyMessage only moves dates forward", () => {
  const lead = { last_email_at: 100, last_followed_up_at: 100 };
  assert.equal(applyMessage(lead, { at: 50, dir: "sent", id: "a", threadId: "t" }), null);
  assert.deepEqual(applyMessage(lead, { at: 200, dir: "received", id: "b", threadId: "t" }), {
    last_email_at: 200,
    last_email_dir: "received",
    last_message_id: "b",
    thread_id: "t",
  });
  assert.equal(applyMessage(lead, { at: 300, dir: "sent", id: "c", threadId: "t" }).last_followed_up_at, 300);
});

test("first sync backfills each lead: newest either way plus newest sent", async () => {
  const mailbox = [
    msg("s1", { at: 1000, from: "me@x.com", to: "a@biz.com", sent: true }),
    msg("r1", { at: 2000, from: "a@biz.com", to: "me@x.com" }),
    msg("d1", { at: 3000, from: "me@x.com", to: "a@biz.com", sent: true, labels: ["DRAFT"] }),
  ];
  const gmail = fakeGmail(mailbox);
  const { changes, cursor } = await syncAccount(gmail, { leads: [{ id: 1, email: "a@biz.com", gmail_checked: 0 }] }, new Counter());
  const c = changes.get(1);
  assert.equal(c.last_email_at, 2000, "drafts don't count as emails");
  assert.equal(c.gmail_draft_id, "draft-d1", "but they're tracked as the lead's draft");
  assert.deepEqual([...c.threads].sort(), ["t-r1", "t-s1"]);
  assert.equal(c.last_email_dir, "received");
  assert.equal(c.last_followed_up_at, 1000);
  assert.equal(c.gmail_checked, 1);
  assert.equal(cursor.history_id, "900");
});

test("a lead with no email history is marked checked with no dates", async () => {
  const { changes } = await syncAccount(fakeGmail([]), { leads: [{ id: 1, email: "new@biz.com", gmail_checked: 0 }] }, new Counter());
  const c = changes.get(1);
  assert.equal(c.gmail_checked, 1);
  assert.equal(c.last_email_at, null);
  assert.equal(c.threads.size, 0);
  assert.equal(c.gmail_draft_id, undefined, "no draft, and none before, so no change");
});

test("a sync with nothing new costs one history call", async () => {
  const gmail = fakeGmail([], { history: [] });
  const counter = new Counter();
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10 };
  const { changes, cursor } = await syncAccount(gmail, { leads: [lead], cursor: { history_id: "900", synced_at: Date.now() } }, counter);
  assert.equal(counter.count, 1);
  assert.equal(changes.size, 0);
  assert.equal(cursor.history_id, "950");
});

test("new messages from history update matching leads; drafts and strangers are ignored", async () => {
  const mailbox = [
    msg("n1", { at: 5000, from: "a@biz.com", to: "me@x.com" }),
    msg("n2", { at: 5100, from: "stranger@else.com", to: "me@x.com" }),
  ];
  const history = [
    { messagesAdded: [{ message: { id: "n1", threadId: "t-n1", labelIds: ["INBOX"] } }] },
    { messagesAdded: [{ message: { id: "n2", threadId: "t-n2", labelIds: ["INBOX"] } }] },
  ];
  const leads = [
    { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10 },
    { id: 2, email: "b@biz.com", gmail_checked: 1, last_email_at: 10 },
  ];
  // Many leads relative to new messages -> fetch each new message directly.
  const gmail = fakeGmail(mailbox, { history });
  const { changes } = await syncAccount(gmail, { leads, cursor: { history_id: "900", synced_at: 0 } }, new Counter());
  assert.equal(changes.get(1).last_email_at, 5000);
  assert.equal(changes.get(1).last_email_dir, "received");
  assert.deepEqual([...changes.get(1).threads], ["t-n1"], "the new thread is learned");
  assert.equal(changes.has(2), false);
  assert.ok(!gmail.calls.includes("drafts.list"), "no draft changed, so drafts aren't listed");
});

test("an expired history bookmark falls back to a date search", async () => {
  const now = Date.now();
  const mailbox = [msg("x1", { at: now, from: "me@x.com", to: "a@biz.com", sent: true })];
  const gmail = fakeGmail(mailbox, { historyGone: true });
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10 };
  const { changes, cursor } = await syncAccount(gmail, { leads: [lead], cursor: { history_id: "1", synced_at: now - 10 * 86_400_000 } }, new Counter());
  assert.ok(gmail.calls.some((c) => c.startsWith("list ") && c.includes("after:")));
  assert.equal(changes.get(1).last_followed_up_at, now);
  assert.equal(cursor.history_id, "900");
});

test("a reply from anyone in a lead's thread counts, even from another address", async () => {
  const mailbox = [msg("c1", { at: 6000, from: "colleague@biz.com", to: "me@x.com", thread: "t-lead" })];
  const history = [{ messagesAdded: [{ message: { id: "c1", threadId: "t-lead", labelIds: ["INBOX"] } }] }];
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" };
  const { changes } = await syncAccount(
    fakeGmail(mailbox, { history }),
    { leads: [lead], threads: new Map([[1, new Set(["t-lead"])]]), cursor: { history_id: "900", synced_at: 0 } },
    new Counter()
  );
  assert.equal(changes.get(1).last_email_dir, "received");
  assert.equal(changes.get(1).last_email_at, 6000);
});

test("a new draft in a lead's thread is found; a sent or discarded one is cleared", async () => {
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10 };
  const threads = new Map([[1, new Set(["t-lead"])]]);
  const cursor = { history_id: "900", synced_at: 0 };
  const draft = msg("d9", { at: 7000, from: "me@x.com", to: "", sent: true, labels: ["DRAFT"], thread: "t-lead" });
  const added = [{ messagesAdded: [{ message: { id: "d9", threadId: "t-lead", labelIds: ["DRAFT"] } }] }];
  const first = await syncAccount(fakeGmail([draft], { history: added }), { leads: [lead], threads, cursor }, new Counter());
  assert.equal(first.changes.get(1).gmail_draft_id, "draft-d9");
  assert.ok(first.draftMeta.has("d9"));

  const deleted = [{ messagesDeleted: [{ message: { id: "d9" } }] }];
  const withDraft = { ...lead, gmail_draft_id: "draft-d9" };
  const second = await syncAccount(fakeGmail([], { history: deleted }), { leads: [withDraft], threads, cursor, draftMeta: first.draftMeta }, new Counter());
  assert.equal(second.changes.get(1).gmail_draft_id, null);
});

test("deleting the email a lead's dates came from looks the lead up again", async () => {
  const mailbox = [msg("old", { at: 1000, from: "me@x.com", to: "a@biz.com", sent: true })];
  const history = [{ labelsAdded: [{ message: { id: "newest" }, labelIds: ["TRASH"] }] }];
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 9000, last_message_id: "newest", last_email_dir: "received" };
  const { changes } = await syncAccount(fakeGmail(mailbox, { history }), { leads: [lead], cursor: { history_id: "900", synced_at: 0 } }, new Counter());
  assert.equal(changes.get(1).last_email_at, 1000);
  assert.equal(changes.get(1).last_email_dir, "sent");
});

test("autoStatus follows the emails but never overrides a status you set", () => {
  assert.equal(autoStatus({ last_email_dir: "received" }, "Awaiting Reply"), "Pending action");
  assert.equal(autoStatus({ last_email_dir: "sent" }, "Pending action"), "Awaiting Reply");
  assert.equal(autoStatus({ last_email_dir: "sent", gmail_draft_id: "d" }, ""), "Pending action");
  assert.equal(autoStatus({}, ""), "Open");
  assert.equal(autoStatus({ last_email_dir: "received" }, "Closed - interested"), null);
  assert.equal(autoStatus({ last_email_dir: "received" }, "Confirmed"), null);
  assert.equal(autoStatus({ last_email_dir: "received" }, "My custom status"), null);
});

test("pendingWrites only writes cells whose value differs", () => {
  const at = new Date(2026, 9, 28).getTime();
  const lead = { id: 7, gmail_checked: 1, last_email_at: at, last_email_dir: "sent", last_followed_up_at: at, gmail_draft_id: "r-1" };
  const row = {
    tab: "ca, hotel",
    rowNumber: 4,
    columns: { lastEmail: 10, lastEmailDir: 11, lastFollowedUp: 12, draftId: 13, followUpStatus: 14 },
    lastEmail: formatDate(at),
    lastEmailDir: "",
    lastFollowedUp: "",
    draftId: "",
    followUpStatus: "pending action",
  };
  assert.deepEqual(pendingWrites(lead, row), [
    { leadId: 7, key: "lastEmailDir", range: "'ca, hotel'!L4", value: "sent" },
    { leadId: 7, key: "lastFollowedUp", range: "'ca, hotel'!M4", value: formatDate(at), date: true },
    { leadId: 7, key: "draftId", range: "'ca, hotel'!N4", value: "r-1" },
  ]);
});

test("pendingWrites treats a date in the sheet's own format as the same date", () => {
  const at = new Date(2026, 9, 28).getTime();
  const lead = { id: 1, gmail_checked: 1, last_email_at: at, last_email_dir: "sent", last_followed_up_at: at };
  const row = { tab: "t", rowNumber: 2, columns: { lastEmail: 0, lastEmailDir: 1, lastFollowedUp: 2, draftId: 3, followUpStatus: 4 },
    lastEmail: "10/28/2026", lastEmailDir: "sent", lastFollowedUp: "10/28/2026", draftId: "", followUpStatus: "Awaiting Reply" };
  assert.deepEqual(pendingWrites(lead, row), []);
});

test("a draft the sheet links to is kept even with no recipient or thread", async () => {
  const draft = msg("m5", { at: 7000, from: "me@x.com", to: "", sent: true, labels: ["DRAFT"] });
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 0, draft_id: "m5" };
  const { changes } = await syncAccount(fakeGmail([draft]), { leads: [lead] }, new Counter());
  assert.equal(changes.get(1).gmail_draft_id, "draft-m5", "linked by message id, stored as the draft id");
});

test("pendingWrites leaves a row alone until Gmail has checked it", () => {
  const row = { tab: "t", rowNumber: 2, columns: { lastEmail: 0 }, lastEmail: "2026-01-01" };
  assert.deepEqual(pendingWrites({ id: 1, gmail_checked: 0 }, row), []);
});

test("contactsIn: who you sent to, or who wrote to you, minus yourself and automated or bulk mail", () => {
  const self = new Set(["me@x.com"]);
  const sent = msg("s", { at: 1, from: "Me <me@x.com>", to: "Jane Doe <Jane@Acme.com>, me@x.com", sent: true });
  assert.deepEqual(contactsIn(sent, self), [{ email: "jane@acme.com", name: "Jane Doe" }]);
  const inbound = msg("r", { at: 1, from: "Bob <bob@shop.com>", to: "me@x.com" });
  assert.deepEqual(contactsIn(inbound, self), [{ email: "bob@shop.com", name: "Bob" }]);
  const robot = msg("n", { at: 1, from: "no-reply@service.com", to: "me@x.com" });
  assert.deepEqual(contactsIn(robot, self), []);
  const newsletter = msg("l", { at: 1, from: "News <news@brand.com>", to: "me@x.com" });
  newsletter.payload.headers.push({ name: "List-Unsubscribe", value: "<mailto:u@brand.com>" });
  assert.deepEqual(contactsIn(newsletter, self), []);
});

test("new mail from people not in any sheet is reported as contacts; bulk categories never are", async () => {
  const mailbox = [
    msg("o1", { at: 8000, from: "me@x.com", to: "New Person <new@acme.com>", sent: true }),
    msg("p1", { at: 8100, from: "promo@brand.com", to: "me@x.com" }),
  ];
  const history = [
    { messagesAdded: [{ message: { id: "o1", threadId: "t-o1", labelIds: ["SENT"] } }] },
    { messagesAdded: [{ message: { id: "p1", threadId: "t-p1", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] } }] },
  ];
  const gmail = fakeGmail(mailbox, { history });
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10 };
  const { contacts } = await syncAccount(gmail, { leads: [lead], cursor: { history_id: "900", synced_at: 0 }, self: new Set(["me@x.com"]) }, new Counter());
  assert.deepEqual([...contacts.keys()], ["new@acme.com"]);
  assert.equal(contacts.get("new@acme.com").name, "New Person");
  assert.equal(contacts.get("new@acme.com").lastDir, "sent");
});

test("autoStatus: outreach Gmail can't see becomes Contacted elsewhere; a new reply reopens Closed", () => {
  assert.equal(autoStatus({}, "Awaiting Reply", { elsewhere: true }), "Contacted elsewhere");
  assert.equal(autoStatus({ last_email_dir: "sent" }, "Contacted elsewhere"), "Awaiting Reply", "switches once Gmail has mail");
  assert.equal(autoStatus({ last_email_dir: "received" }, "Closed - declined for now", { reopen: true }), "Pending action");
  assert.equal(autoStatus({ last_email_dir: "received" }, "Confirmed", { reopen: true }), null, "Confirmed is never reopened");
});

const COLS = { email: 0, businessName: 1, lastEmail: 2, lastEmailDir: 3, lastFollowedUp: 4, draftId: 5, followUpStatus: 6, priority: 7, notes: 8 };

test("pendingWrites keeps the sheet's dates when Gmail has no email with them", () => {
  const lead = { id: 1, gmail_checked: 1, last_email_at: null, last_followed_up_at: null };
  const row = { tab: "t", rowNumber: 2, columns: COLS, lastEmail: "10/28/2026", lastEmailDir: "sent", lastFollowedUp: "", draftId: "", followUpStatus: "Awaiting Reply" };
  assert.deepEqual(pendingWrites(lead, row), [{ leadId: 1, key: "followUpStatus", range: "'t'!G2", value: "Contacted elsewhere" }]);
});

test("pendingWrites reopens a Closed row on a new reply and drops priority 0", () => {
  const at = new Date(2026, 10, 2).getTime();
  const lead = { id: 1, gmail_checked: 1, last_email_at: at, last_email_dir: "received", last_followed_up_at: at - 1 };
  const row = { tab: "t", rowNumber: 5, columns: COLS, lastEmail: formatDate(at), lastEmailDir: "received", lastFollowedUp: formatDate(at - 1),
    draftId: "", followUpStatus: "Closed - declined for now", priorityRaw: "0" };
  assert.deepEqual(pendingWrites(lead, row), [], "no new reply this sync: stays closed");
  assert.deepEqual(pendingWrites(lead, row, { newReply: true }).map((w) => [w.key, w.value]), [
    ["followUpStatus", "Pending action"],
    ["priority", ""],
  ]);
});

test("a reply in a lead's thread from someone new is reported as a new reply and tied to that lead", async () => {
  const mailbox = [msg("c2", { at: 9000, from: "Bob <bob@biz.com>", to: "me@x.com", thread: "t-lead" })];
  const history = [{ messagesAdded: [{ message: { id: "c2", threadId: "t-lead", labelIds: ["INBOX", "CATEGORY_UPDATES"] } }] }];
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" };
  const { contacts, replies } = await syncAccount(
    fakeGmail(mailbox, { history }),
    { leads: [lead], threads: new Map([[1, new Set(["t-lead"])]]), cursor: { history_id: "900", synced_at: 0 }, self: new Set(["me@x.com"]) },
    new Counter()
  );
  assert.ok(replies.has(1));
  const bob = contacts.get("bob@biz.com");
  assert.equal(bob.viaLead, 1, "even from Gmail's Updates tab, since it's in the lead's thread");
  assert.equal(bob.messageId, "c2");
});

test("addressWrites adds new people from a lead's thread to its email cell", () => {
  const lead = { id: 1 };
  const sheetRows = new Map([[1, { tab: "main", rowNumber: 7, columns: COLS, email: "jane@biz.com", emails: ["jane@biz.com"], emailCell: "Jane@Biz.com" }]]);
  const writes = addressWrites(
    [
      { lead, contact: { email: "bob@biz.com" } },
      { lead, contact: { email: "cy@biz.com" } },
    ],
    sheetRows
  );
  assert.deepEqual(writes, [{ leadId: 1, key: "email", range: "'main'!A7", value: "Jane@Biz.com, bob@biz.com, cy@biz.com", added: ["bob@biz.com", "cy@biz.com"] }]);
  sheetRows.get(1).emails.push("bob@biz.com");
  assert.deepEqual(addressWrites([{ lead, contact: { email: "bob@biz.com" } }], sheetRows), [], "already there: no write");
});

test("a lead's other addresses count for matching", async () => {
  const mailbox = [msg("b1", { at: 9500, from: "bob@biz.com", to: "me@x.com" })];
  const history = [{ messagesAdded: [{ message: { id: "b1", threadId: "t-b1", labelIds: ["INBOX"] } }] }];
  const lead = { id: 1, email: "jane@biz.com", all_emails: "jane@biz.com,bob@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" };
  const { changes, contacts } = await syncAccount(fakeGmail(mailbox, { history }), { leads: [lead], cursor: { history_id: "900", synced_at: 0 } }, new Counter());
  assert.equal(changes.get(1).last_email_dir, "received");
  assert.equal(contacts.size, 0, "bob is already in a sheet");
});

test("own domains leave out free mail providers", async () => {
  const { ownDomainsOf } = await import("../src/sync.js");
  assert.deepEqual([...ownDomainsOf(new Set(["me@acme.com", "me@gmail.com"]))], ["acme.com"]);
});

test("confirmRows drops writes to rows that moved since the sync read the sheet", () => {
  const header = ["email", "business name", "last email", "last email dir", "last followed up", "draft id", "follow-up status", "priority", "notes"];
  const row = (email, n) => ({ tab: "main", rowNumber: n, columns: COLS, email, emails: [email], emailCell: email });
  const sheetRows = new Map([
    [1, row("jane@biz.com", 2)],
    [2, row("bob@biz.com", 3)],
  ]);
  const updates = [
    { leadId: 1, key: "lastEmail", range: "'main'!C2", value: "2026-11-01" },
    { leadId: 1, key: "followUpStatus", range: "'main'!G2", value: "Pending action" },
    { leadId: 2, key: "lastEmail", range: "'main'!C3", value: "2026-11-02" },
  ];

  const unchanged = { main: [header, ["jane@biz.com"], ["bob@biz.com"]] };
  assert.deepEqual(confirmRows(updates, sheetRows, unchanged), { ok: updates, moved: new Set() });

  const sorted = { main: [header, ["bob@biz.com"], ["jane@biz.com"]] };
  assert.deepEqual(confirmRows(updates, sheetRows, sorted), { ok: [], moved: new Set([1, 2]) });

  const insertedAbove = { main: [header, ["new@x.com"], ["jane@biz.com"], ["bob@biz.com"]] };
  assert.deepEqual(confirmRows(updates, sheetRows, insertedAbove).moved, new Set([1, 2]));

  const columnsMoved = { main: [["business name", ...header.filter((h) => h !== "business name")], ["", "jane@biz.com"], ["", "bob@biz.com"]] };
  assert.deepEqual(confirmRows(updates, sheetRows, columnsMoved).moved, new Set([1, 2]));

  const janeGone = { main: [header, ["bob@biz.com"]] };
  const out = confirmRows(updates, sheetRows, janeGone);
  assert.deepEqual(out.moved, new Set([1, 2]), "bob shifted up a row too");

  const headerRenamed = { main: [header.map((h) => (h === "draft id" ? "draft" : h)), ["jane@biz.com"], ["bob@biz.com"]] };
  assert.deepEqual(confirmRows(updates, sheetRows, headerRenamed).ok, []);
});

test("confirmRows refuses an email-cell write when the cell was edited by hand", () => {
  const header = ["email", "business name", "last email", "last email dir", "last followed up", "draft id", "follow-up status", "priority", "notes"];
  const sheetRows = new Map([[1, { tab: "main", rowNumber: 2, columns: COLS, email: "jane@biz.com", emails: ["jane@biz.com"], emailCell: "jane@biz.com" }]]);
  const updates = [{ leadId: 1, key: "email", range: "'main'!A2", value: "jane@biz.com, bob@biz.com", added: ["bob@biz.com"] }];
  assert.deepEqual(confirmRows(updates, sheetRows, { main: [header, ["jane@biz.com"]] }).ok, updates);
  assert.deepEqual(confirmRows(updates, sheetRows, { main: [header, ["jane@biz.com, cy@biz.com"]] }).moved, new Set([1]));
});

// --- Bounces and automatic replies -------------------------------------------

// msg() plus extra headers and a snippet.
function auto(id, opts, headers = {}, snippet = "") {
  const m = msg(id, opts);
  m.payload.headers.push(...Object.entries(headers).map(([name, value]) => ({ name, value })));
  m.snippet = snippet;
  return m;
}

test("automatedKind tells bounces and auto-replies from people", () => {
  const base = { at: 1, to: "me@x.com" };
  const kind = (from, headers, snippet) => automatedKind(auto("m", { ...base, from }, headers, snippet));
  assert.equal(kind("Mail Delivery Subsystem <mailer-daemon@googlemail.com>"), "bounce");
  assert.equal(kind("postmaster@outlook.com"), "bounce");
  assert.equal(kind("Microsoft Outlook <MicrosoftExchange1@biz.com>", { "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' }), "bounce");
  assert.equal(kind("relay@biz.com", { "X-Failed-Recipients": "a@biz.com" }), "bounce");
  assert.equal(kind("relay@biz.com", {}, "Mail Delivery Subsystem: address not found"), "bounce", "named in the text");
  assert.equal(kind("relay@biz.com", { Subject: "Undeliverable: Hello", "Auto-Submitted": "auto-replied" }), "bounce");
  assert.equal(
    kind("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", { Subject: "Delivery Status Notification (Delay)" }),
    "auto",
    "a delay notice isn't a bounce yet"
  );
  assert.equal(kind("a@biz.com", { Subject: "Automatic reply: Hello" }), "auto");
  assert.equal(kind("a@biz.com", { Subject: "Out of Office: back Monday" }), "auto");
  assert.equal(kind("a@biz.com", { "Auto-Submitted": "auto-replied", Subject: "Re: Hello" }), "auto", "Gmail's vacation responder");
  assert.equal(kind("a@biz.com", { "X-Autoreply": "yes" }), "auto");
  assert.equal(kind("a@biz.com", { Subject: "Re: undeliverable package?" }), null, "a person's subject alone isn't enough");
  assert.equal(kind("a@biz.com", { Subject: "Re: I'll be out of office next week" }), null);
  assert.equal(kind("a@biz.com", { "Auto-Submitted": "no" }), null);
});

test("a bounce in a lead's thread marks it bounced, not replied; an out-of-office is ignored", async () => {
  const mailbox = [
    auto("b1", { at: 6000, from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", to: "me@x.com", thread: "t-1" }, { "X-Failed-Recipients": "a@biz.com" }),
    auto("o1", { at: 6000, from: "b@biz.com", to: "me@x.com", thread: "t-2" }, { Subject: "Automatic reply: Hello", "Auto-Submitted": "auto-replied" }),
  ];
  const history = [
    { messagesAdded: [{ message: { id: "b1", threadId: "t-1", labelIds: ["INBOX"] } }] },
    { messagesAdded: [{ message: { id: "o1", threadId: "t-2", labelIds: ["INBOX"] } }] },
  ];
  const leads = [
    { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" },
    { id: 2, email: "b@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" },
  ];
  const threads = new Map([[1, new Set(["t-1"])], [2, new Set(["t-2"])]]);
  const { changes, replies, contacts } = await syncAccount(
    fakeGmail(mailbox, { history }),
    { leads, threads, cursor: { history_id: "900", synced_at: 0 } },
    new Counter()
  );
  assert.equal(changes.get(1).last_email_dir, "bounced");
  assert.equal(changes.get(1).last_email_at, 6000);
  assert.equal(changes.has(2), false, "the out-of-office changes nothing");
  assert.equal(replies.size, 0, "neither counts as a reply, so neither reopens a Closed row");
  assert.equal(contacts.size, 0);
});

test("a bounce outside the lead's thread finds the lead by the failed address", async () => {
  const mailbox = [auto("b1", { at: 6000, from: "postmaster@biz.com", to: "me@x.com" }, { "X-Failed-Recipients": "a@biz.com" })];
  const history = [{ messagesAdded: [{ message: { id: "b1", threadId: "t-b1", labelIds: ["INBOX"] } }] }];
  const lead = { id: 1, email: "a@biz.com", gmail_checked: 1, last_email_at: 10, last_email_dir: "sent" };
  const { changes } = await syncAccount(fakeGmail(mailbox, { history }), { leads: [lead], cursor: { history_id: "900", synced_at: 0 } }, new Counter());
  assert.equal(changes.get(1).last_email_dir, "bounced");
});

test("a first lookup passes over out-of-office replies to the newest real email", async () => {
  const mailbox = [
    msg("s1", { at: 1000, from: "me@x.com", to: "a@biz.com", sent: true }),
    auto("o1", { at: 2000, from: "a@biz.com", to: "me@x.com" }, { Subject: "Out of office" }),
  ];
  const { changes } = await syncAccount(fakeGmail(mailbox), { leads: [{ id: 1, email: "a@biz.com", gmail_checked: 0 }] }, new Counter());
  const c = changes.get(1);
  assert.equal(c.last_email_dir, "sent");
  assert.equal(c.last_email_at, 1000);
  assert.equal(c.last_followed_up_at, 1000);
});

test("a bounced lead is Pending action", () => {
  assert.equal(autoStatus({ last_email_dir: "bounced" }, "Awaiting Reply"), "Pending action");
  assert.equal(autoStatus({ last_email_dir: "bounced" }, "Closed - interested"), null, "a bounce doesn't reopen");
});
