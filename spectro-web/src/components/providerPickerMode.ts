// Pure logic for the provider picker, split out so it is testable without a DOM.

import type { ProviderRow } from "../state/providerRegistry";

/** Every selectable LLM backend, and the app's only copy of that set — it is
 *  held to SpectroConfig.KNOWN_PROVIDERS from the Java side by
 *  ProviderListDriftTest, which reads this array out of this file. Before that
 *  guard existed, a backend declared in Java left the picker silent about it
 *  with every test in both languages green (card 312, round 4).
 *
 *  The OpenAI-compatible ids sit next to the cloud ones and the picker treats
 *  them all uniformly; llamacpp is an operator's own llama-server, kept apart
 *  from lmstudio because it answers with what it has loaded (card 312), and
 *  spectro-local is the bundled model, its own first-class entry. */
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
 * list is AUTHORITATIVE. A local backend (every provider addressSpecFor gives a
 * field to) and a keyed cloud provider whose key is present ("ready") both
 * return their real models, so a
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

export interface PickerOption {
  disabled: boolean;
  reasonKey: string | null;
  vars?: Record<string, string>;
}

/**
 * How one provider renders in the chat picker (owner decision D9, 2026-10-09:
 * grey out, never hide). The provider the chat runs on is never disabled, so
 * the chip can always be re-selected and never claims a state it is not in.
 * An unknown row (an older server) is enabled.
 */
export function pickerOption(row: ProviderRow | undefined, current: string): PickerOption {
  if (!row || row.id === current) return { disabled: false, reasonKey: null };
  if (row.state === "needs-key") return { disabled: true, reasonKey: "pp.optNeedsKey" };
  if (row.state === "failed") {
    const reason = row.reason ?? "unknown";
    return row.endpoint
      ? { disabled: true, reasonKey: "pp.optFailedAt", vars: { addr: row.endpoint, reason } }
      : { disabled: true, reasonKey: "pp.optFailed", vars: { reason } };
  }
  if (row.state === "reachable" && row.models.length === 0) {
    return { disabled: false, reasonKey: "pp.optNoModels" };
  }
  return { disabled: false, reasonKey: null };
}
