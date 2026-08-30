// The real context-window size per model family, so the context gauge can name
// the model's actual window instead of implying the compaction threshold IS the
// window. Values verified from the providers' own docs (July 2026):
//   Claude:  Opus 4.6+/Sonnet 5/Fable 5/Mythos 5 = 1M, Haiku 4.5 + legacy = 200k
//            (platform.claude.com/docs/en/build-with-claude/context-windows)
//   OpenAI:  GPT-4o = 128k, GPT-4.1 & GPT-5.x = ~1M
//            (openai.com/index/gpt-4-1, openai.com/index/introducing-gpt-5-5)
//   Gemini:  1.5 Pro up to 2M, 2.5 Pro/Flash = 1M
//            (ai.google.dev/gemini-api/docs/long-context)
// The local backends serve whatever model was loaded, so their windows and
// anything unrecognised vary widely: we return null rather than fabricate a
// number. Deliberately not a list of names — the pair that stood here missed
// llamacpp the day it arrived (card 312).
//
// THIS TABLE IS A GUESS BY PREFIX AND WILL BE WRONG AGAIN. claude-fable-5 was
// the last name it did not know: it starts with "claude" but with neither
// "claude-opus" nor "claude-sonnet", so it fell to the legacy 200k row and the
// ring read 379% in red on a healthy session. A real source exists for part of
// this: the Anthropic Models API answers max_input_tokens per model on
// GET /v1/models/{id}, and the server ALREADY calls that exact endpoint in
// ModelCapabilityController.anthropicCapability (it reads the "capabilities"
// node of the same body and drops the rest). Serving that number would cost a
// field on the capability record (or a sibling endpoint), an async fetch keyed
// on (provider, model) in ContextRing, and a null-until-known state the ring
// already handles. It would NOT delete this file, but the set it would leave
// behind has grown since this note was written: anthropic and openrouter
// publish a real window through their model APIs, and the two backends that
// ARE a llama.cpp server answer GET /props with the n_ctx the loaded model is
// really running at (OpenAiCompatProvider.readsWindowFromProps /
// loadedWindowFromProps, card 312 — the same fact the guide's wire chapter
// now sends a llamacpp reader to). Whatever publishes nothing keeps this
// table as its fallback. Left as a note on purpose, not built here.

/** Claude families whose current generation ships the 1M window. */
const CLAUDE_1M = ["claude-opus", "claude-sonnet", "claude-fable", "claude-mythos"];

/** The model's real context window in tokens, or null when it isn't known (a
 *  local/custom model). Rounded to the clean flagship figure (the exact
 *  1,048,576 vs 1,000,000 is immaterial at gauge scale). */
export function contextWindowFor(model: string): number | null {
  const m = model.toLowerCase();
  // Claude
  if (CLAUDE_1M.some((family) => m.startsWith(family))) return 1_000_000;
  if (m.startsWith("claude")) return 200_000; // haiku + legacy
  // OpenAI
  if (m.startsWith("gpt-4o")) return 128_000;
  if (m.startsWith("gpt-4.1") || m.startsWith("gpt-5")) return 1_000_000;
  // Gemini
  if (m.startsWith("gemini-1.5-pro")) return 2_000_000;
  if (m.startsWith("gemini")) return 1_000_000;
  return null;
}

/** Compact window label: 128000 -> "128k", 1000000 -> "1M", 2000000 -> "2M". */
export function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`;
}
