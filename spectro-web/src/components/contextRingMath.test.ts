// The gauge's denominator. Pulled out as a pure rule because the bug it fixes
// was arithmetic, not rendering: the ring read 859k against a hardcoded 100k
// and printed 859%, three lines above its own caption saying the window is 1M.
import { describe, expect, it } from "vitest";
import { contextDenominator, FALLBACK_THRESHOLD, namedWindow } from "./contextRingMath";

describe("contextDenominator", () => {
  it("uses the reported compaction threshold when the harness sent one", () => {
    expect(contextDenominator(150_000, 1_000_000)).toEqual({ value: 150_000, of: "compaction" });
  });

  it("falls back to the model's own window, not to a constant", () => {
    expect(contextDenominator(undefined, 1_000_000)).toEqual({ value: 1_000_000, of: "window" });
  });

  it("only reaches the constant when neither is known", () => {
    // A custom backend: the run stated no window and no threshold, and nothing
    // here fabricates a size.
    expect(contextDenominator(undefined, null)).toEqual({
      value: FALLBACK_THRESHOLD,
      of: "fallback",
    });
  });

  it("does not treat a zero threshold as a reported one", () => {
    expect(contextDenominator(0, 1_000_000)).toEqual({ value: 1_000_000, of: "window" });
  });

  it("keeps the imported case honest: 859k of a 1M window is 86 percent", () => {
    const d = contextDenominator(undefined, 1_000_000);
    expect(Math.round((859_000 / d.value) * 100)).toBe(86);
  });
});

// Card 366: the gauge NAMES the window it is measuring against. The line has
// been in ContextRing.tsx since card 300 and never rendered for a local model,
// because the web answered "which window?" from a hand-typed vendor prefix
// table that returned null for everything that was not Claude, GPT or Gemini —
// which is every backend the owner tests with. The answer now rides the wire,
// with the harness's own provenance beside it.
describe("namedWindow", () => {
  const compaction = { value: 175_257, of: "compaction" } as const;

  it("names the loaded instance when the harness measured one", () => {
    expect(namedWindow(250_368, "window", compaction)).toEqual({ tokens: 250_368, of: "loaded" });
  });

  it("names the published window when the model's vendor states it", () => {
    expect(namedWindow(1_000_000, "model", { value: 700_000, of: "compaction" })).toEqual({
      tokens: 1_000_000,
      of: "published",
    });
  });

  it("states the window without a provenance when the threshold was typed", () => {
    // An override says nothing about where the window came from — the harness
    // fills it from whichever fact it had — so the caption may not claim one.
    expect(namedWindow(250_368, "override", { value: 50_000, of: "compaction" })).toEqual({
      tokens: 250_368,
      of: "unstated",
    });
  });

  it("treats a provenance it has never heard of like an absent one", () => {
    // The Java enum may grow a fifth source; its own additivity test already
    // replays an unknown "tokenizer". An unrecognised word must not silently
    // read as "loaded" or as "published".
    expect(namedWindow(250_368, "tokenizer", compaction)?.of).toBe("unstated");
    expect(namedWindow(250_368, undefined, compaction)?.of).toBe("unstated");
  });

  it("names nothing when the run learned no window", () => {
    expect(namedWindow(undefined, "fallback", { value: 100_000, of: "compaction" })).toBeNull();
    expect(namedWindow(0, "window", compaction)).toBeNull();
  });

  it("names nothing when the gauge is already dividing by the window itself", () => {
    // Otherwise the same number is printed twice, once as the denominator and
    // once as its own origin.
    expect(namedWindow(1_000_000, "model", { value: 1_000_000, of: "window" })).toBeNull();
    expect(namedWindow(1_000_000, "model", { value: 100_000, of: "fallback" })).toBeNull();
  });
});
