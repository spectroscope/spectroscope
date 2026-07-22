// The real context-window size per model family, so the context gauge can name
// the model's actual window instead of implying the compaction threshold IS the
// window. Values verified from the providers' own docs (July 2026):
//   Claude   — Opus 4.6+/Sonnet 5 = 1M, Haiku 4.5 + legacy = 200k
//              (platform.claude.com/docs/en/build-with-claude/context-windows)
//   OpenAI   — GPT-4o = 128k, GPT-4.1 & GPT-5.x = ~1M
//              (openai.com/index/gpt-4-1, openai.com/index/introducing-gpt-5-5)
//   Gemini   — 1.5 Pro up to 2M, 2.5 Pro/Flash = 1M
//              (ai.google.dev/gemini-api/docs/long-context)
// Local backends (ollama, lmstudio) and anything unrecognised vary widely — we
// return null rather than fabricate a number.

/** The model's real context window in tokens, or null when it isn't known (a
 *  local/custom model). Rounded to the clean flagship figure (the exact
 *  1,048,576 vs 1,000,000 is immaterial at gauge scale). */
export function contextWindowFor(model: string): number | null {
  const m = model.toLowerCase();
  // Claude
  if (m.startsWith("claude-opus") || m.startsWith("claude-sonnet")) return 1_000_000;
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
