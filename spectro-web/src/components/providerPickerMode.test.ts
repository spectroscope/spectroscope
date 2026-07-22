import { describe, it, expect } from "vitest";
import { modelFieldMode, PROVIDERS } from "./providerPickerMode";

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
    expect(PROVIDERS).toEqual(["anthropic", "ollama", "openai", "lmstudio", "openrouter"]);
  });
});
