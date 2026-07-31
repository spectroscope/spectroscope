// Curated image-generation models per provider, for the settings sub-selection.
// The server accepts any model string (ImageProviders.create takes a model arg);
// these are the ones each provider's endpoint is known to serve:
//   - gemini → generateContent image models
//   - openai → /v1/images/generations models
// An empty selection means "use the provider default" (the first entry).

export const IMAGE_MODELS: Record<string, string[]> = {
  gemini: ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"],
  openai: ["gpt-image-1", "dall-e-3", "dall-e-2"],
};

/**
 * The option list for a provider's image-model dropdown. A custom or stale
 * current value (a model set via env, or one left over from another provider
 * before the switch reset it) is surfaced as a leading option so the dropdown
 * never silently drops what is actually configured. An empty current value is
 * "use the provider default" and carries no extra option.
 */
export function imageModelOptions(provider: string, current: string): string[] {
  const base = IMAGE_MODELS[provider] ?? [];
  if (current && !base.includes(current)) {
    return [current, ...base];
  }
  return base;
}
