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

const TONES = {
  friendly: "Warm and friendly, conversational.",
  brief: "Brief and to the point: a few short sentences.",
  formal: "Formal and professional.",
};

// The user's standing voice settings (Settings → Drafting), as prompt text.
export function voiceText({ tone, signOff, aboutMe } = {}) {
  const lines = [];
  if (TONES[tone]) lines.push(`- Tone: ${TONES[tone]} This takes priority over matching the thread's tone.`);
  if (signOff?.trim()) lines.push(`- End every email with this sign-off, exactly as written:\n${signOff.trim()}`);
  if (aboutMe?.trim()) lines.push(`- About the user, for context (don't quote it back): ${aboutMe.trim()}`);
  return lines.length ? `The user's standing preferences for every email:\n${lines.join("\n")}` : "";
}

// One prompt covering a batch of leads. Message bodies and notes from the
// lead are wrapped as untrusted, since anyone can email the user.
// voice: { tone, signOff, aboutMe } from settings.
export function buildPrompt(items, instructions, voice) {
  const parts = [];
  const standing = voiceText(voice);
  if (standing) parts.push(standing);
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
