import { markUntrusted, UNTRUSTED_NOTICE } from "multi-gmail-mcp/src/gmail.js";

export const SYSTEM_PROMPT = `You write short follow-up emails for the user's outreach.

For each lead you get the business name, the sheet notes, the user's instructions, and the most recent messages in the email thread (oldest first). Write the next email the user would send.

- Match the tone and language of the user's earlier messages in the thread.
- If the lead hasn't replied, write a brief, friendly nudge that adds something useful; don't repeat the whole pitch.
- If the lead replied, answer what they said.
- No placeholders like [Name] - leave out anything you don't know.
- Plain text only. Sign off the way the user signed earlier messages, if they did.

${UNTRUSTED_NOTICE}

Reply with only a JSON array, no prose and no code fences:
[{"key": "<lead key>", "subject": "<subject, used only when there is no thread>", "body": "<email body>"}]`;

const MAX_MESSAGE_CHARS = 4000;

// One prompt covering a batch of leads. Message bodies and notes from the
// lead are wrapped as untrusted, since anyone can email the user.
export function buildPrompt(items, instructions) {
  const parts = [];
  if (instructions?.trim()) parts.push(`Instructions from the user for this batch:\n${instructions.trim()}`);
  for (const item of items) {
    const lines = [`### Lead key: ${item.key}`, `Business: ${item.businessName || "(unknown)"}`, `Email: ${item.email}`];
    if (item.notes) lines.push(`Sheet notes (written by the user): ${item.notes}`);
    if (!item.thread.length) {
      lines.push("No previous emails - this is a first message. Include a subject.");
    } else {
      lines.push("Thread:");
      for (const m of item.thread) {
        const who = m.dir === "sent" ? "USER (you are writing as them)" : `LEAD (${m.from})`;
        const text = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n[...cut]` : m.text;
        lines.push(`--- ${who}, ${m.date}`);
        lines.push(m.dir === "sent" ? text : markUntrusted(text));
      }
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// The model's reply -> [{ key, subject, body }]. Tolerates a code fence or
// stray text around the array.
export function parseDrafts(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("Claude didn't return a list of drafts");
  const list = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(list)) throw new Error("Claude didn't return a list of drafts");
  return list
    .filter((d) => d && typeof d.key === "string" && typeof d.body === "string")
    .map((d) => ({ key: d.key, subject: typeof d.subject === "string" ? d.subject : "", body: d.body.trim() }));
}
