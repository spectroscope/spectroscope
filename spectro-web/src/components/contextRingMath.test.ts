// The gauge's denominator. Pulled out as a pure rule because the bug it fixes
// was arithmetic, not rendering: the ring read 859k against a hardcoded 100k
// and printed 859%, three lines above its own caption saying the window is 1M.
import { describe, expect, it } from "vitest";
import { contextDenominator, FALLBACK_THRESHOLD } from "./contextRingMath";

describe("contextDenominator", () => {
  it("uses the reported compaction threshold when the harness sent one", () => {
    expect(contextDenominator(150_000, 1_000_000)).toEqual({ value: 150_000, of: "compaction" });
  });

  it("falls back to the model's own window, not to a constant", () => {
    expect(contextDenominator(undefined, 1_000_000)).toEqual({ value: 1_000_000, of: "window" });
  });

  it("only reaches the constant when neither is known", () => {
    // A local or custom model: contextWindowFor returns null rather than
    // fabricating a size, and there is no threshold on the wire either.
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
