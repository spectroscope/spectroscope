// Card 193: which settings field carries a provider's OWN address, and what
// the "backend not reachable" sentence says. Pure logic, shared by the
// Settings page (the field itself) and both ModelField hosts (the sentence),
// so the field, the placeholder and the named address cannot drift apart.
//
// Only the local-model providers own an address here. The cloud providers
// authenticate against fixed services (anthropic's endpoint is not
// configurable at all; openai/openrouter/gemini keep the legacy shared
// baseUrl override in the workspace gear), so for them the field stays
// hidden rather than "ignored".

import type { Lang } from "../i18n/i18n";
import { layerLabel, type Origin, type SettingsView } from "../state/serverSettings";

/** The address field of one local-model provider. */
export interface AddressSpec {
  /** The SpectroConfig field the Settings page reads and writes. */
  field: "ollamaBaseUrl" | "lmstudioBaseUrl";
  /** The provider's OWN preset, shown as the placeholder — what an empty
   *  field falls back to (through the legacy baseUrl chain, server-side). */
  preset: string;
}

/** The address spec for `provider`, or null for providers without an address
 *  — the Settings page hides the field for those. The presets mirror
 *  SpectroConfig.openAiCompatPreset / the ollama default on the server. */
export function addressSpecFor(provider: string): AddressSpec | null {
  switch (provider) {
    case "ollama":
      return { field: "ollamaBaseUrl", preset: "http://localhost:11434" };
    case "lmstudio":
      return { field: "lmstudioBaseUrl", preset: "http://localhost:1234" };
    default:
      return null;
  }
}

/** The unreachable-backend note for a local provider: names the exact address
 *  the probe tried (`providerAddress` from /api/config, the same endpointFor
 *  the probe itself dials) — "start ollama" was the wrong advice whenever the
 *  backend ran fine one hostname away. Falls back to the addressless sentence
 *  against an older server that reports no addresses. */
export function localDownNote(
  provider: string,
  providerAddress?: Record<string, string>,
): { key: string; vars?: Record<string, string> } {
  const addr = providerAddress?.[provider];
  if (typeof addr === "string" && addr.trim() !== "") {
    return { key: "pp.localDownAt", vars: { addr } };
  }
  return { key: "pp.localDown" };
}

/** Card 311: the note that makes card 193's fixed field priority visible on
 *  the settings page, in the same voice the doctor already uses.
 *
 *  The settings layers fold in ascending precedence (defaults < env < user <
 *  launch dir < project < local < flags), but `SpectroConfig.endpointFor`
 *  then applies a FIXED priority on top of the folded result: a provider's
 *  own address wins over the shared `baseUrl` no matter which layer either
 *  value came from. That precedence is unchanged here — a field named after
 *  ONE provider is more specific than a field every provider once read. What
 *  is fixed is the silence: an operator who typed an address into the general
 *  field and watched every request go elsewhere was told only that "the
 *  backend" was unreachable, at an address he had not chosen.
 *
 *  Both halves are checked by VALUE as well as by origin, because a present
 *  key is not a value that wins: a hand-edited `"lmstudioBaseUrl": ""` gets a
 *  layer from the fold and an origin to match, while `effectiveLmstudioBaseUrl`
 *  reads a blank as unset and dials the general address after all. Claiming an
 *  override there would be the exact opposite of the truth.
 *
 *  @param provider        the configured provider
 *  @param view            the resolved settings view; null while it loads
 *  @param lang            the operator's language, for the two layer names
 *  @param providerAddress /api/config's per-provider addresses — the server's
 *                         own `endpointFor`, so the sentence names the string
 *                         the probe and the run actually dial
 *  @returns the note, or null when nothing is being overridden */
export function addressOverrideNote(
  provider: string,
  view: SettingsView | null,
  lang: Lang,
  providerAddress?: Record<string, string>,
): { key: string; vars: Record<string, string> } | null {
  const spec = addressSpecFor(provider);
  if (spec === null || view === null) return null;

  const own = view.effective[spec.field];
  const general = view.effective.baseUrl;
  const ownOrigin = view.origins[spec.field];
  const generalOrigin = view.origins.baseUrl;
  if (ownOrigin === undefined || generalOrigin === undefined) return null;

  // "Set" is a layer other than the built-in defaults AND a value that is not
  // blank — endpointFor skips a blank per-provider field, and a blank general
  // one loses nothing worth naming.
  const isSet = (value: unknown, origin: Origin): boolean =>
    origin.winner !== "defaults" && typeof value === "string" && value.trim() !== "";
  if (!isSet(own, ownOrigin) || !isSet(general, generalOrigin)) return null;

  const fromConfig = providerAddress?.[provider];
  const addr = typeof fromConfig === "string" && fromConfig.trim() !== "" ? fromConfig : String(own);
  return {
    key: "set.addressOverride",
    vars: {
      field: spec.field,
      provider,
      addr,
      winner: layerLabel(ownOrigin.winner, lang),
      loser: layerLabel(generalOrigin.winner, lang),
    },
  };
}
