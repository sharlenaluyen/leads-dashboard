# leads-dashboard

A dashboard that runs locally for outreach spreadsheets. For every row, it shows when
you last emailed (either direction, from Gmail), whether it's your turn, a
0-3 priority and a follow-up status. It can have Claude draft follow-ups for
the rows you tick and save them as Gmail drafts. It never sends emails. Use for outreach, sales leads, etc.

**Gmail is the source of truth for email; the spreadsheet is the source of
truth for the dashboard.** Sync writes what Gmail says (sent, received,
drafts, threads) into the sheet, then the dashboard shows what the sheet
holds. SQLite (`data/leads.db`) keeps Gmail bookmarks and a copy of the
last sheet read: delete it any time and `npm run rebuild` gets that back.
The exceptions are the review list, its dismissals, and reopens not yet
written to the sheet (see [When the cache is rebuilt](#sync)), which only
SQLite holds.

## How it fits together

```
Gmail ──(1) what changed──► sync ──(2) changed cells only──► Google Sheet ──(3)──► dashboard
 sent, received,             │                                 owns: leads, priority,
 drafts, threads             └ SQLite: bookmarks only          notes, manual statuses
```

- Sign-in comes from [google-mcp-accounts](../google%20workspace%20mcp%20servers/google-mcp-accounts):
  the same `~/.google-mcp/accounts.json` the MCP servers use. No extra
  Google Cloud setup.
- Gmail helpers come from [multi-gmail-mcp](../google%20workspace%20mcp%20servers/multi-gmail-mcp)'s
  `src/gmail.js`, which handles message building, header-injection guards,
  reply state and untrusted-content wrapping.
- Sheet edits and drafts are logged to the shared `~/.google-mcp/audit.log`
  as `"server": "leads-dashboard"`.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Needs Node 22.13+ (for the built-in `node:sqlite`). Both sibling repos must
sit in `../google workspace mcp servers/`

## Spreadsheet columns

Every tab you include must have these headers (any order, any letter case, any
extra columns alongside):

| Header | Who fills it |
| --- | --- |
| `business name` | you |
| `email` | you: one address, or several separated by commas (rows without a valid address are skipped) |
| `priority` | you or the dashboard: `0`-`3` (below) |
| `follow-up status` | you or the dashboard: one of the statuses below, or a custom one |
| `last email` | Gmail: date of the newest email either way, in any of the lead's threads |
| `last email dir` | Gmail: `sent` or `received` |
| `last followed up` | Gmail: date of the newest email **you** sent |
| `draft id` | Gmail: the lead's newest unsent draft (blank once it's sent or discarded) |
| `notes` *(optional)* | you: given to Claude when drafting |

**Priority** (3 sorts first):

| | |
| --- | --- |
| `3` | Overdue, no recent movement |
| `2` | Due soon |
| `1` | Too recent to chase yet |
| `0` | Closed out, no action needed |

**Follow-up status:** Open, Pending action, Awaiting Reply, Contacted elsewhere, Closed - interested,
Closed - declined forever, Closed - declined for now, Closed - Other, Confirmed. Any status
starting with "Closed" is hidden unless **Show closed** is ticked.

Sync sets the status from Gmail while it's blank, Open, Pending action,
Awaiting Reply or Contacted elsewhere:

| Gmail shows | Status |
| --- | --- |
| No email with them, but the sheet has a date in `last email` or `last followed up` | Contacted elsewhere (the sheet's dates are kept) |
| They replied last, or there's an unsent draft | Pending action |
| You sent last | Awaiting Reply |
| No emails, and no dates in the sheet | Open |

"Contacted elsewhere" is for outreach outside Gmail (a contact form, another
app, a call): type the date into `last email` and sync keeps it. Once a Gmail
email with them exists, Gmail's dates and statuses take over.

Closed…, Confirmed and custom statuses are yours, with one exception: a new
reply that arrives after a row is Closed reopens it as **Pending action**
(they replied, so it's your turn), and clears a priority of 0. Confirmed and
custom statuses are never changed.

Gmail reports each reply only once, so the reopen is saved in SQLite together
with Gmail's bookmark. If the sheet can't be written that sync (a Sheets
error, an unreadable tab, `writeBack` off), the reopen waits and is applied on
the next sync that writes the row. If you change the row's status yourself
first, in the sheet or the dashboard, your status wins and the reopen is
dropped.

**Order:** rows sort by what they need next. The **Next** column shows it: Reply,
Send draft, Follow up (waiting, priority 3), First email, Waiting, No action
(closed, confirmed or priority 0). Ties go by priority, then sheet row order.

The dashboard only checks for these; it never adds columns. A tab missing any
of them is skipped and the dashboard lists exactly which headers to add. The
header row can be any of the first 10 rows (it's the one with `email`).

A status typed straight into the sheet that the dashboard doesn't know yet
becomes a custom status for that section automatically.

**Dates** are read the way the sheet displays them. `YYYY-MM-DD` and US-style
`MM/DD/YYYY` are understood; a sheet whose locale shows dates as
`DD/MM/YYYY` (UK, most of Europe) is misread: the dashboard shows wrong or
blank dates, and sync rewrites those cells on every sync. Until that's fixed,
keep the spreadsheet's locale (File → Settings) on United States, or format
the date columns as `yyyy-mm-dd`.

## Sections

Each section is one spreadsheet, the tabs you list for it, and the Gmail
account to check. Only tabs you tick are included, so hidden or archived tabs
stay out unless you pick them. Add, edit and remove sections from the page
(**Add section** / **Edit**). They're saved in `config/sources.json`.
That file is gitignored since it holds your spreadsheet IDs; see
`config/sources.example.json` for its shape.
Removing a section never touches the spreadsheet.

`config/sources.json` is the one file here that can't be rebuilt, so it's
written safely: to a temporary file first, flushed to disk, then renamed into
place, with the previous version kept as `config/sources.json.bak`. If
`sources.json` is ever unreadable, the dashboard uses the `.bak` copy and
prints a warning.

**A renamed or deleted tab** only skips that tab: the tab shows "Tab not
found in the spreadsheet (renamed or deleted?)" with Google's own error, and
the section's other tabs sync as usual. Rename it back in Sheets, or click
**Edit** and tick its new name. Its rows stay in the dashboard as last read
until then, and nothing is written to them.

Inside a section, each tab gets its own subsection, in the same order as the
tabs in the spreadsheet. Click any section or tab header to open or close it.
Drag a section by its header (or focus its ⠿ handle and press Alt+↑/↓) to
reorder; the order is saved in `config/sources.json`.

## Sync

**Sync** does three things in order:

1. Reads every section's tabs (one Sheets call per spreadsheet) to learn who
   the leads are.
2. Asks Gmail what changed since last time (one call per account, using
   Gmail's history bookmark): new messages, deleted or trashed ones, and
   drafts created, edited, sent or discarded. Any message in a lead's thread
   counts, even from someone else at their company.
3. Writes only the cells that differ from Gmail (one call per spreadsheet,
   only when something changed). That call returns what the sheet now holds,
   and the dashboard is rebuilt from it.

Email columns follow Gmail: a date or draft id typed into them by hand is
replaced on the next sync. Dates are compared as dates, so a sheet showing
`10/28/2026` isn't rewritten as `2026-10-28`, and dates are written as real
dates, keeping the column's format. If an account's Gmail check fails, that
account's sheets aren't written that sync.

A sync with nothing new is about one call per spreadsheet plus one per
account and takes 1-2 seconds (plus one more call for a spreadsheet with a
missing tab). The header shows the actual count after each
sync.

- A newly added row costs up to three Gmail calls once, to find its threads
  and history. Deleting the email a row's dates came from re-checks that row.
- A `draft id` that still points to a live draft stays linked to its row,
  even if the draft has no recipient yet.
- If more than about a week passes between syncs, Gmail's bookmark expires and
  sync falls back to a date search from the last sync. See the known gaps
  below for what that search can't see.

**When the cache is rebuilt:** only when you run `npm run rebuild`, delete
`data/leads.db` yourself, or after an update to the dashboard changes the
cache's layout (it then rebuilds on the next start, as it did when Gmail
became the source of truth). Sync itself only updates it. A rebuild re-reads
every sheet and looks every lead up in Gmail again: about 3 calls per lead,
once. It also empties the review list (see below) and drops any reopen still
waiting to be written; the change log and `config/` are kept. `npm run
rebuild` refuses to run while the dashboard server is running (`npm start` or
`npm run dev`), because the server would keep using the deleted database file
and both would write to the sheets. Stop the server, rebuild, then start it
again. It finds the server by the pid it records in `data/server.pid`, or by
something answering on the dashboard's port.

**One writer at a time.** Sync, dashboard edits, undo, **Add** from the review
list and **Save to Gmail drafts** all write by row number after a read, so
they take turns: anything started during a sync waits for it to finish, then
runs. A dashboard edit can't be overwritten by a sync that read the sheet
before it, two **Add**s can't land on the same row, and double-clicking
**Save** replaces the first draft instead of making two.

### Known gaps

- **Editing the sheet during a sync.** Sync reads the sheet, then writes about
  1-2 seconds later by row number. If rows are inserted, deleted or sorted
  in between, a write can land on the wrong row. The dashboard assumes you
  don't edit the spreadsheet or draft emails during a sync (a notice says
  when one is running); it doesn't check edits made in Sheets itself.
- **Auto-replies and bounces count as replies.** An out-of-office reply or a
  bounce in a lead's thread is treated like a real reply: the row turns
  **Pending action**, and a Closed row reopens (clearing a priority of 0).
  They're kept out of the review list, but not out of the dates and status.
- **Bcc is ignored.** Mail where a lead was only Bcc'd doesn't count for
  them: lookups search `to:`, `cc:` and `from:`, never `bcc:`.
- **Address variants don't match.** Addresses are compared exactly (letter
  case aside). `jane.doe@gmail.com`, `janedoe@gmail.com` and
  `jane.doe@googlemail.com` all reach the same Gmail inbox, but count as
  different people here; `jane+news@acme.com` isn't matched to
  `jane@acme.com` either. Put every variant a lead uses in their `email`
  cell.
- **Forwards and notes in a lead's thread** count as mail to the lead.
  Forwarding their message to a coworker usually keeps it in the same
  thread, so it updates `last followed up` and sets **Awaiting Reply**.
- **Long gaps between syncs.** When the bookmark has expired, the fallback
  search finds messages by the leads' own addresses since the last sync. It
  can't see:
  - deletions: a search can't report that a message disappeared, so a date
    from an email deleted during the gap stays in the sheet;
  - replies in a lead's thread from a different address (a colleague): they
    aren't in the search, and because they're older than the new bookmark,
    later syncs won't see them either;
  - new people: the review list and auto-added rows only come from the
    bookmark's change list.
  Syncing at least every few days avoids all three.
- **Scheduled sends** aren't handled specially; how a scheduled email counts
  before it actually goes out is untested.
- **Other mailboxes.** Each section sees only its own Gmail account. Mail sent
  as another address *from that account* (Gmail "send mail as", like a
  `default_from`) is in the same mailbox and counts. Mail from a different
  account or mail app doesn't.

## People not in any sheet

**Several addresses per row.** The `email` cell can hold more than one
address, e.g. `jane@acme.com, bob@acme.com`. The first one identifies the
row; all of them are matched against Gmail, and drafts from the dashboard
are addressed to all of them. Adding an address by hand makes the next sync
look the row up in Gmail again so that person's mail counts too.

**Replies in a lead's thread are added automatically.** When someone who
isn't in any sheet replies in a thread with a lead (a colleague, a group
reply), sync adds their address to that lead's `email` cell:
`jane@acme.com` becomes `jane@acme.com, bob@acme.com`. It costs nothing
extra: the reply was already fetched and the cell goes in the same write as
the rest of the sync. If the cell can't be written, they go to the review
list instead.

Coworkers are never auto-added: anyone on your account's own domain (from
its address and `default_from`) goes to the review list instead, so they
don't end up on the lead's drafts. Free mail domains (gmail.com, outlook.com
and the like) don't count as your domain.

**Everyone else goes to a review list.** From the first sync on, anyone you
email, or who emails you, from a section's Gmail account and who isn't in any
sheet shows up in a **Not in a sheet** list at the top of the dashboard.
Each person in the To line of a group email is listed separately. Pick a tab, adjust the business
name, and click **Add**: the dashboard writes their email and business name
in the first empty row after the tab's last row with data, then syncs, which
fills in the dates, direction, draft and status like any other row. **Dismiss**
hides someone.

Skipped automatically: yourself, automated senders (no-reply, notifications,
mailer-daemon), mail with an unsubscribe link or marked as bulk, and
anything in Gmail's Promotions, Social, Updates or Forums tabs. Only the To
line of your sent mail counts, not Cc. The list lives in the SQLite cache, so
`npm run rebuild` empties it (and forgets dismissals).

## History and undo

Every cell the dashboard writes (sync, your edits in the dashboard, added
rows) is appended to `data/sheet-changes.jsonl` with the time, who wrote it,
the tab, row, email, column, and the old and new values. It's logged *before*
the cell is written and flushed to disk, so a crash can't leave a written
cell out of the log. If the write then fails, a line marking it failed
follows, and **History** shows **Write failed** with no Undo. A line cut off
by a crash is skipped and doesn't affect the lines after it.

**History** shows it, newest first, with an **Undo** per cell. Undo only goes
through when the row still holds the same email and the cell hasn't changed
again since. That check also makes it safe when a crash came between
logging and writing.
Undoing an email column lasts until the next sync, since Gmail owns those.
Rebuilding the cache never touches this file. Each sync's writes are also
summarized in the shared `~/.google-mcp/audit.log`.

While a sync runs, a notice asks you not to edit the spreadsheet or draft
emails (see Known gaps). Edits, undos and saved drafts made in the dashboard
meanwhile wait for the sync, then go through.

## Drafting follow-ups

Tick rows, click **Draft follow-ups**, and optionally add instructions. Claude
reads each lead's latest thread (last 6 messages) and the row's notes and
writes a reply. You review and edit each one, then **Save to Gmail drafts**:

- It's a reply in the existing thread, addressed to the lead, from the
  account's `default_from`. A lead with no thread gets a new email.
- If the row already has a dashboard draft that still exists in Gmail, it's
  replaced rather than duplicated.
- The draft ID is written to the `draft id` column. Once you send it from
  Gmail, the next sync picks it up as `last followed up`.
- Saving waits for a running sync. If the email the lead's dates came from
  was deleted since the last sync, saving fails; sync, then save again.

Threads are read four at a time, and up to two Claude calls run at once
(`draftBatchSize` leads each). A batch that fails, or whose reply can't be
read, is tried once more. Both tries share a 2-minute limit, so a stuck
batch shows its error within 2 minutes; only that batch's leads show the
error, and the rest of the drafts come back as usual. If batches keep timing
out, lower `draftBatchSize`.

Claude runs as `claude -p` (your installed Claude Code, on your Claude plan)
with **every tool disabled and no MCP servers**. An email that tries to give
Claude instructions can only affect the draft text, which you review before
saving. Emails from leads are also wrapped as untrusted content in the prompt.

### Switching to the API later

Right now, the cheapest plan for an individual charges via API keys but doesn't charge for Claude Code, so the system currently runs Claude through Claude Code. The ideal is to swap this out for an API key in the future.

In `config/settings.json`, set `"drafter": "api"`, then:

```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=...   # or `ant auth login`
```

It defaults to `claude-opus-5-5`; set `"drafterModel"` to change it. The API
call has server-side refusal fallback turned on.

## Settings (`config/settings.json`)

| Key | Default | |
| --- | --- | --- |
| `port` | `3000` | |
| `writeBack` | `false` | Allow writing to spreadsheets (dates, priority, status, draft id). Off means read-only: sync still runs and reports how many cell updates are held. |
| `createDrafts` | `false` | Allow saving Gmail drafts. |
| `drafter` | `"claude-code"` | or `"api"` |
| `drafterModel` | unset | Model for the drafter |
| `draftBatchSize` | `8` | Leads per Claude call |

Restart `npm start` after changing settings.

## Google sign-in expiry

While the Google OAuth app is in Testing mode, sign-ins expire every 7 days.
Sync then shows "Google sign-in for X has expired". Run `./refresh-tokens.sh`
in google-mcp-accounts and sync again. No restart needed: the dashboard re-reads the new sign-in on the next request.

## Development

```bash
npm test           # parsing, header checks, Gmail sync logic, prompt building, change log, write lock
npm run rebuild    # wipe the SQLite cache and resync (stop the server first)
npm run dev        # restart on file changes
```

The server listens on 127.0.0.1 only and rejects requests from other origins,
because it can write to your sheets and Gmail.
