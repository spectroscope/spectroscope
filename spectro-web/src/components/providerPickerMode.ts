// Pure logic for the provider picker, split out so it is testable without a DOM.

/** Every selectable LLM backend. The two OpenAI-compatible presets (lmstudio,
 *  openrouter) sit next to the cloud ones; the picker treats them uniformly. */
export const PROVIDERS = ["anthropic", "ollama", "openai", "lmstudio", "openrouter", "gemini"] as const;

/** What the model field should render for the selected provider. */
export type ModelFieldMode =
  | "needs-key" // an API provider with no key — show 'add it to .env', not a list
  | "list" // a live/curated model list to choose from
  | "freetext"; // no list (a local backend that isn't running) — free text, honestly labelled

/**
 * Decide the model field's mode from the provider's onboarding status (from
 * /api/config) and the fetched model list. An API provider without a key gets
 * the honest needs-key message instead of a curated list that fakes readiness;
 * everything else lists when it can and falls back to labelled free text.
 */
export function modelFieldMode(
  provider: string,
  providerStatus: Record<string, string> | undefined,
  models: string[],
): ModelFieldMode {
  if (providerStatus?.[provider] === "needs-key") {
    return "needs-key";
  }
  return models.length > 0 ? "list" : "freetext";
}

/**
 * Which model to select once a provider's list has loaded. A LOCAL backend
 * (ollama, lmstudio) has an AUTHORITATIVE list — its actually-installed models —
 * so a selection that isn't in it (e.g. claude-opus carried over from anthropic,
 * or an empty seed) is replaced with the first real one. A cloud list can be a
 * curated fallback, so a cloud model is never second-guessed; and an empty list
 * (backend down) leaves the selection alone.
 */
export function pickModel(current: string, models: string[], isLocal: boolean): string {
  if (isLocal && models.length > 0 && !models.includes(current)) {
    return models[0];
  }
  return current;
}
