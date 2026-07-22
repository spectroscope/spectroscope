import { describe, it, expect } from "vitest";
import { modelFieldMode, pickModel, PROVIDERS } from "./providerPickerMode";

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

  it("offers all five providers, including the two OpenAI-compatible ones", () => {
    expect(PROVIDERS).toEqual(["anthropic", "ollama", "openai", "lmstudio", "openrouter", "gemini"]);
  });
});
