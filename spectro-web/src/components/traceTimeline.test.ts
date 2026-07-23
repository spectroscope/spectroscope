import { describe, it, expect } from "vitest";
import { timelineFractions } from "./traceTimeline";

describe("timelineFractions — the timeline lens's wait bars", () => {
  it("is empty for no rows and bar-less for a single row", () => {
    expect(timelineFractions([])).toEqual([]);
    expect(timelineFractions([1000])).toEqual([null]);
  });

  it("normalizes on a log scale so one outlier cannot flatten the rest", () => {
    // gaps: — , 9, 99 → log1p(9)/log1p(99) = ln10/ln100 = exactly one half:
    // the small wait keeps HALF a bar next to an 11× outlier, instead of the
    // linear 9% sliver.
    const [first, small, big] = timelineFractions([0, 9, 108]);
    expect(first).toBeNull();
    expect(small).toBeCloseTo(0.5, 10);
    expect(big).toBe(1);
  });

  it("keeps ordinary waits visible next to a huge LLM wait (the owner's 18 s case)", () => {
    // One 18 s wait among ~120 ms steps: linear normalization rendered the
    // 120 ms bars at 0.7% width — invisible. Log keeps them readable while
    // the outlier still clearly wins.
    const [, step, outlier] = timelineFractions([0, 120, 18202]);
    expect(step).toBeGreaterThan(0.4);
    expect(step).toBeLessThan(outlier!);
    expect(outlier).toBe(1);
  });

  it("stays monotonic: a longer wait never gets a shorter bar", () => {
    const [, a, b, c] = timelineFractions([0, 50, 250, 1250]) as number[];
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
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
