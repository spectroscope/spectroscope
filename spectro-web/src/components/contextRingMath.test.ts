// The gauge's denominator. Pulled out as a pure rule because the bug it fixes
// was arithmetic, not rendering: the ring read 859k against a hardcoded 100k
// and printed 859%, three lines above its own caption saying the window is 1M.
import { describe, expect, it } from "vitest";
import {
  contextDenominator,
  contextGauge,
  FALLBACK_THRESHOLD,
  namedWindow,
  windowProvenance,
} from "./contextRingMath";

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

// Card 377: the headline divides by the WINDOW whenever the run's threshold was
// derived from one. The owner read `143k of 175k before compaction (82%)` over a
// caption saying `loaded window · 250k`, and 175,257 is exactly 70 % of 250,368,
// so the big number was a share of the harness's housekeeping point and the
// small one was the size he was actually paying for. The compaction point does
// not leave the surface; it stops being the scale.
describe("contextGauge", () => {
  it("divides by the loaded window when the harness measured one", () => {
    expect(contextGauge(175_257, 250_368, "window")).toEqual({
      denominator: { value: 250_368, of: "window" },
      compactsAt: 175_257,
      windowOf: "loaded",
    });
  });

  it("divides by the published window when the model's vendor states it", () => {
    expect(contextGauge(700_000, 1_000_000, "model")).toEqual({
      denominator: { value: 1_000_000, of: "window" },
      compactsAt: 700_000,
      windowOf: "published",
    });
  });

  it("leaves an operator-typed threshold as the headline", () => {
    // Under an override the number is the operator's own, and the window beside
    // it says nothing about where his figure came from.
    expect(contextGauge(50_000, 1_000_000, "override")).toEqual({
      denominator: { value: 50_000, of: "compaction" },
      compactsAt: null,
      windowOf: null,
    });
  });

  it("leaves a fallen-back threshold as the headline, with nothing to mark", () => {
    expect(contextGauge(100_000, undefined, "fallback")).toEqual({
      denominator: { value: 100_000, of: "compaction" },
      compactsAt: null,
      windowOf: null,
    });
  });

  it("leaves a pre-card-366 frame exactly as it was", () => {
    // No provenance and no window: the threshold is taken at its word, the way
    // it always was.
    expect(contextGauge(200_000, undefined, undefined)).toEqual({
      denominator: { value: 200_000, of: "compaction" },
      compactsAt: null,
      windowOf: null,
    });
  });

  it("refuses to promote a window under a provenance it has never heard of", () => {
    // The Java enum may grow a fifth source. An unrecognised word must not be
    // read as "this threshold is a share of that window".
    expect(contextGauge(175_257, 250_368, "tokenizer")).toEqual({
      denominator: { value: 175_257, of: "compaction" },
      compactsAt: null,
      windowOf: null,
    });
  });

  it("does not treat a zero window as a window", () => {
    expect(contextGauge(175_257, 0, "window")).toEqual({
      denominator: { value: 175_257, of: "compaction" },
      compactsAt: null,
      windowOf: null,
    });
  });

  it("marks nothing when the threshold is not below the window", () => {
    // Nothing on the wire forbids it, and a tick at the full circumference is a
    // ring that looks finished on an empty run.
    expect(contextGauge(250_368, 250_368, "window")).toEqual({
      denominator: { value: 250_368, of: "window" },
      compactsAt: null,
      windowOf: "loaded",
    });
  });

  it("still names the window on a frame that stated one without a threshold", () => {
    expect(contextGauge(undefined, 250_368, "window")).toEqual({
      denominator: { value: 250_368, of: "window" },
      compactsAt: null,
      windowOf: "loaded",
    });
  });

  it("falls to the constant when the run stated neither", () => {
    expect(contextGauge(undefined, undefined, undefined)).toEqual({
      denominator: { value: FALLBACK_THRESHOLD, of: "fallback" },
      compactsAt: null,
      windowOf: null,
    });
  });
});

describe("the window the operator set for this session (card 390)", () => {
  it("is what the gauge divides by, with the compaction point marked", () => {
    expect(contextGauge(358_400, 512_000, "window_override")).toEqual({
      denominator: { value: 512_000, of: "window" },
      compactsAt: 358_400,
      windowOf: "set",
    });
  });

  it("is called his, not loaded and not published", () => {
    expect(windowProvenance("window_override")).toBe("set");
  });

  it("is not named a second time under the headline", () => {
    const gauge = contextGauge(358_400, 512_000, "window_override");
    expect(namedWindow(512_000, "window_override", gauge.denominator)).toBeNull();
  });
});
