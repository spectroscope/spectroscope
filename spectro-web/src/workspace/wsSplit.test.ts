import { describe, it, expect } from "vitest";
import { clampSplitPct, readStoredSplit, DEFAULT_SPLIT, MIN_SPLIT, MAX_SPLIT } from "./wsSplit";

describe("clampSplitPct", () => {
  it("keeps a value inside the range untouched", () => {
    expect(clampSplitPct(50)).toBe(50);
  });
  it("clamps below the minimum", () => {
    expect(clampSplitPct(2)).toBe(MIN_SPLIT);
  });
  it("clamps above the maximum", () => {
    expect(clampSplitPct(99)).toBe(MAX_SPLIT);
  });
});

describe("readStoredSplit", () => {
  it("falls back to the default when nothing is stored", () => {
    expect(readStoredSplit(null)).toBe(DEFAULT_SPLIT);
  });
  it("falls back to the default for junk", () => {
    expect(readStoredSplit("nope")).toBe(DEFAULT_SPLIT);
  });
  it("falls back to the default when out of range", () => {
    expect(readStoredSplit("5")).toBe(DEFAULT_SPLIT);
    expect(readStoredSplit("95")).toBe(DEFAULT_SPLIT);
  });
  it("keeps a valid stored value", () => {
    expect(readStoredSplit("55")).toBe(55);
  });
});
