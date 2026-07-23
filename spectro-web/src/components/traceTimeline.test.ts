import { describe, it, expect } from "vitest";
import { timelineFractions } from "./traceTimeline";

describe("timelineFractions — the timeline lens's wait bars", () => {
  it("is empty for no rows and bar-less for a single row", () => {
    expect(timelineFractions([])).toEqual([]);
    expect(timelineFractions([1000])).toEqual([null]);
  });

  it("normalizes each row's wait against the largest gap (linear, honest)", () => {
    // gaps: — , 100, 300 → the 300 ms wait is the full bar, the 100 ms a third.
    expect(timelineFractions([0, 100, 400])).toEqual([null, 100 / 300, 1]);
  });

  it("draws no bars when every event lands on the same instant", () => {
    expect(timelineFractions([100, 100, 100])).toEqual([null, null, null]);
  });

  it("clamps clock skew to zero instead of a negative bar", () => {
    // 50 arrives BEFORE its predecessor's ts (importer skew): its wait is 0,
    // and the max is taken over the clamped gaps.
    expect(timelineFractions([100, 50, 250])).toEqual([null, 0, 1]);
  });
});
