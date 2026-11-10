import { markUntrusted, UNTRUSTED_NOTICE } from "multi-gmail-mcp/src/gmail.js";

export const SYSTEM_PROMPT = `You write short follow-up emails for the user's outreach.

For each lead you get the business name, the sheet notes, the user's instructions, and the most recent messages in the email thread (oldest first). Write the next email the user would send.

- Match the tone and language of the user's earlier messages in the thread.
- If the lead hasn't replied, write a brief, friendly nudge that adds something useful; don't repeat the whole pitch.
- If the lead replied, answer what they said.
- No placeholders like [Name] - leave out anything you don't know.
- Plain text only.

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
  parts.push(...leadSections(items, "No previous emails - this is a first message. Include a subject."));
  return parts.join("\n\n");
}

// One prompt section per lead: name, notes and thread.
function leadSections(items, firstMessageNote) {
  return items.map((item) => {
    const lines = [`### Lead key: ${item.key}`, `Business: ${item.businessName || "(unknown)"}`, `Email: ${item.email}`];
    if (item.notes) lines.push(`Sheet notes (written by the user): ${item.notes}`);
    if (!item.thread.length) {
      lines.push(firstMessageNote);
    } else {
      lines.push("Thread:");
      for (const m of item.thread) {
        const who = m.dir === "sent" ? "USER (you are writing as them)" : `LEAD (${m.from})`;
        const text = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n[...cut]` : m.text;
        lines.push(`--- ${who}, ${m.date}`);
        lines.push(m.dir === "sent" ? text : markUntrusted(text));
      }
    }
    return lines.join("\n");
  });
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

// --- Saved emails ------------------------------------------------------------
// With a saved email picked, Claude writes only each lead's greeting (and a
// subject for a first message); the saved body and the sign-off are added
// as written by assembleSaved, so Claude never retypes them.

export const GREETING_SYSTEM_PROMPT = `You write the opening line of follow-up emails for the user's outreach. The user has written the body of the email themselves; the same body goes to every lead, and their sign-off is added after it. Your only job is the greeting that comes before the body.

For each lead you get the business name, the sheet notes, the most recent messages in the email thread (oldest first), and the saved body.

- If you know the name of the person you're writing to (from their replies, their signature, how the user addressed them before, or the sheet notes), greet them: "Dear <first name>," - or the full name if that's how the user addressed them.
- Otherwise address the business: "To the <business name> team,".
- The user's instructions for the batch take priority over these rules.
- The greeting is one short line. Don't add any other sentences, and don't repeat or change the body.
- No placeholders like [Name] - leave out anything you don't know.
- Plain text only.

${UNTRUSTED_NOTICE}

Reply with only a JSON array, no prose and no code fences:
[{"key": "<lead key>", "subject": "<subject that fits the body, used only when there is no thread>", "greeting": "<greeting line>"}]`;

// Like buildPrompt, but for greetings: the saved body is given once as
// context, and nothing about tone or sign-off (they don't apply).
export function buildGreetingPrompt(items, instructions, template) {
  const parts = [`The saved body the user wrote, which follows your greeting in every email:\n${template.body}`];
  if (instructions?.trim()) parts.push(`Instructions from the user for this batch:\n${instructions.trim()}`);
  parts.push(...leadSections(items, "No previous emails - this is a first message. Include a subject that fits the saved body."));
  return parts.join("\n\n");
}

// The model's reply -> [{ key, subject, greeting }].
export function parseGreetings(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("Claude didn't return a list of greetings");
  const list = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(list)) throw new Error("Claude didn't return a list of greetings");
  return list
    .filter((d) => d && typeof d.key === "string" && typeof d.greeting === "string" && d.greeting.trim())
    .map((d) => ({ key: d.key, subject: typeof d.subject === "string" ? d.subject : "", greeting: d.greeting.trim() }));
}

// Greeting, then the saved body exactly as written, then the sign-off.
export function assembleSaved(greeting, body, signOff) {
  return [greeting, body.trim(), signOff?.trim()].filter(Boolean).join("\n\n");
}
