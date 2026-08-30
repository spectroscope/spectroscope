import { describe, it, expect } from "vitest";
import { modelFieldMode, pickModel, PROVIDERS, providerDisplayName } from "./providerPickerMode";

describe("the built-in provider", () => {
  it("is its own selectable entry", () => {
    expect(PROVIDERS).toContain("spectro-local");
  });
  it("reads plainly 'built-in' — the model is the chooser's business, not the row's", () => {
    // The old hardcoded "built-in · VibeThinker-3B" died with the catalogue: a
    // provider row naming ONE model would lie whenever another one is selected.
    expect(providerDisplayName("spectro-local")).toBe("built-in");
  });
  it("leaves every other provider's label as-is", () => {
    expect(providerDisplayName("anthropic")).toBe("anthropic");
    expect(providerDisplayName("lmstudio")).toBe("lmstudio");
  });
  it("renders a needs-download field mode when no model is there", () => {
    expect(modelFieldMode("spectro-local", { "spectro-local": "needs-download" }, [])).toBe("needs-download");
  });
  it("is a plain freetext (chooser-managed model) once ready", () => {
    expect(modelFieldMode("spectro-local", { "spectro-local": "ready" }, [])).toBe("freetext");
  });
});

describe("pickModel", () => {
  const ollama = ["qwen3.5:27b", "glm-5.2", "llama4"];
  it("drops a stale cross-provider model for a LOCAL backend (opus after switching to ollama)", () => {
    // ollama's list is authoritative — claude-opus isn't in it, so take the first real one.
    expect(pickModel("claude-opus-4-8", ollama, true)).toBe("qwen3.5:27b");
  });
  it("keeps the model when it IS in the local list", () => {
    expect(pickModel("glm-5.2", ollama, true)).toBe("glm-5.2");
  });
  it("fills an empty selection with the first local model", () => {
    expect(pickModel("", ollama, true)).toBe("qwen3.5:27b");
  });
  it("never second-guesses a cloud model (the list can be a curated fallback)", () => {
    // a newer cloud model not in the curated list must survive.
    expect(pickModel("claude-opus-5", ["claude-opus-4-8"], false)).toBe("claude-opus-5");
  });
  it("leaves the model untouched when the local list is empty (backend down)", () => {
    expect(pickModel("claude-opus-4-8", [], true)).toBe("claude-opus-4-8");
  });
  it("snaps a keyed cloud provider off the bogus 'local-model' seed to a real one", () => {
    // openai with a key returns its real list; 'local-model' (the openai default)
    // isn't in it, so an authoritative list must replace it with the first real model.
    expect(pickModel("local-model", ["gpt-4o", "gpt-4o-mini"], true)).toBe("gpt-4o");
  });
});

describe("modelFieldMode", () => {
  it("shows the honest needs-key message when the provider has no key", () => {
    // No fake list: the picker must say 'add a key to .env', not pretend to work.
    expect(modelFieldMode("anthropic", { anthropic: "needs-key" }, [])).toBe("needs-key");
    expect(modelFieldMode("openrouter", { openrouter: "needs-key" }, ["x"])).toBe("needs-key");
  });

  it("lists models when the provider is ready and the list is non-empty", () => {
    expect(modelFieldMode("anthropic", { anthropic: "ready" }, ["claude-x"])).toBe("list");
    expect(modelFieldMode("ollama", { ollama: "local" }, ["qwen3"])).toBe("list");
  });

  it("falls back to free text when there is no list (local backend unreachable)", () => {
    // A local provider with an empty list = not running: free text, not needs-key.
    expect(modelFieldMode("ollama", { ollama: "local" }, [])).toBe("freetext");
    expect(modelFieldMode("lmstudio", { lmstudio: "local" }, [])).toBe("freetext");
  });

  it("tolerates a missing status map (never throws)", () => {
    expect(modelFieldMode("anthropic", undefined, ["claude-x"])).toBe("list");
    expect(modelFieldMode("anthropic", undefined, [])).toBe("freetext");
  });

  // The SET is guarded across the language boundary by ProviderListDriftTest,
  // which reads PROVIDERS out of providerPickerMode.ts and compares it to
  // SpectroConfig.KNOWN_PROVIDERS — this list alone could only ever agree with
  // itself. What is left here, and only here, is the ORDER the picker draws.
  it("offers every provider, in the order the picker draws them", () => {
    expect(PROVIDERS).toEqual([
      "anthropic",
      "ollama",
      "openai",
      "lmstudio",
      "llamacpp",
      "openrouter",
      "gemini",
      "spectro-local",
    ]);
  });
});
