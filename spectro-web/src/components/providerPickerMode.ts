// Pure logic for the provider picker, split out so it is testable without a DOM.

/** Every selectable LLM backend. The two OpenAI-compatible presets (lmstudio,
 *  openrouter) sit next to the cloud ones; llamacpp is an operator's own
 *  llama-server, kept apart from lmstudio because it answers what it has
 *  loaded (card 312); spectro-local is the bundled model,
 *  its own first-class entry; the picker treats them uniformly. */
export const PROVIDERS = [
  "anthropic",
  "ollama",
  "openai",
  "lmstudio",
  "llamacpp",
  "openrouter",
  "gemini",
  "spectro-local",
] as const;

/** The picker label for a provider. spectro-local reads "built-in" — which model
 *  it runs is the chooser dialog's business now that there is a catalogue, so
 *  the provider row no longer hardcodes a model name. Every other provider
 *  keeps its id. */
export function providerDisplayName(provider: string): string {
  return provider === "spectro-local" ? "built-in" : provider;
}

/** What the model field should render for the selected provider. */
export type ModelFieldMode =
  | "needs-key" // an API provider with no key — show 'add it to .env', not a list
  | "needs-download" // the built-in model is not there yet — the download modal, not a list
  | "list" // a live/curated model list to choose from
  | "freetext"; // no list (a local backend that isn't running, or a fixed model) — free text

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
  if (providerStatus?.[provider] === "needs-download") {
    return "needs-download";
  }
  return models.length > 0 ? "list" : "freetext";
}

/**
 * Which model to select once a provider's list has loaded, given whether that
 * list is AUTHORITATIVE. A local backend (ollama, lmstudio) and a keyed cloud
 * provider whose key is present ("ready") both return their real models, so a
 * selection that isn't in the list — e.g. claude-opus carried over from
 * anthropic, or "local-model" left seeded on a keyed openai — is replaced with
 * the first real one. A needs-key / curated-fallback list is NOT authoritative,
 * so the caller passes false and the selection is left alone; an empty list
 * (backend down) also leaves it alone.
 */
export function pickModel(current: string, models: string[], authoritative: boolean): string {
  if (authoritative && models.length > 0 && !models.includes(current)) {
    return models[0];
  }
  return current;
}
