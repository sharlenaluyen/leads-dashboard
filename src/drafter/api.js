/**
 * Anthropic API drafter, for when settings.json has "drafter": "api".
 * Needs `npm install @anthropic-ai/sdk` and ANTHROPIC_API_KEY (or an
 * `ant auth login` profile). Not installed by default.
 */
export async function complete({ system, prompt, model, timeoutMs }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error('The API drafter needs the SDK: run "npm install @anthropic-ai/sdk" in the dashboard folder.');
  }
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: model || "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // If a safety classifier declines, the API retries on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: prompt }],
  }, { timeout: timeoutMs, maxRetries: 0 });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to draft these (${response.stop_details?.category || "no category"}).`);
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
