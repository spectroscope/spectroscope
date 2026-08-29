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

/** The address field of one local-model provider. */
export interface AddressSpec {
  /** The SpectroConfig field the Settings page reads and writes. */
  field: "ollamaBaseUrl" | "lmstudioBaseUrl" | "llamacppBaseUrl";
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
    // Card 312. llama-server's own documented default: `--port PORT  port to
    // listen (default: 8080)`.
    case "llamacpp":
      return { field: "llamacppBaseUrl", preset: "http://localhost:8080" };
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
