import { describe, it, expect } from "vitest";
import { IMAGE_MODELS, imageModelOptions } from "./imageModels";

describe("imageModelOptions", () => {
  it("lists a provider's curated image models", () => {
    expect(imageModelOptions("gemini", "")).toEqual(IMAGE_MODELS.gemini);
    expect(imageModelOptions("openai", "")).toEqual(IMAGE_MODELS.openai);
  });

  it("keeps a custom/stale current model as a leading option so it is never dropped", () => {
    // e.g. an openai model still selected right after switching to gemini, or a
    // newer model set via env that isn't in the curated list.
    expect(imageModelOptions("gemini", "dall-e-3")).toEqual([
      "dall-e-3",
      ...IMAGE_MODELS.gemini,
    ]);
  });

  it("never duplicates a current model that is already in the list", () => {
    expect(imageModelOptions("gemini", "gemini-2.5-flash-image")).toEqual(IMAGE_MODELS.gemini);
  });

  it("treats an empty current model as 'use the provider default' (no extra option)", () => {
    expect(imageModelOptions("openai", "")).toEqual(IMAGE_MODELS.openai);
  });

  it("tolerates an unknown provider, surfacing just the current value", () => {
    expect(imageModelOptions("nope", "custom-x")).toEqual(["custom-x"]);
    expect(imageModelOptions("nope", "")).toEqual([]);
  });
});
