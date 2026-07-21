import { describe, expect, it } from "vitest";
import { nearestTick } from "./SpectrumBand";

// The pure hit-testing math behind the band scrubber: given ticks at known
// x-fractions and a cursor fraction, which tick is closest? Kept apart from the
// DOM so the geometry is unit-testable without a layout.
describe("nearestTick", () => {
  it("returns null when there are no ticks", () => {
    expect(nearestTick([], 0.5)).toBeNull();
  });

  it("returns the only tick regardless of the cursor", () => {
    const ticks = [{ x: 0.2 }];
    expect(nearestTick(ticks, 0)).toBe(0);
    expect(nearestTick(ticks, 1)).toBe(0);
  });

  it("picks the closest tick by x-distance", () => {
    const ticks = [{ x: 0.1 }, { x: 0.5 }, { x: 0.9 }];
    expect(nearestTick(ticks, 0.12)).toBe(0);
    expect(nearestTick(ticks, 0.48)).toBe(1);
    expect(nearestTick(ticks, 0.8)).toBe(2);
  });

  it("resolves a tie to the earlier tick", () => {
    // 0.5 is equidistant from 0.4 and 0.6 — strict '<' keeps the first seen.
    expect(nearestTick([{ x: 0.4 }, { x: 0.6 }], 0.5)).toBe(0);
  });

  it("clamps at the ends: frac 0 and 1 snap to the boundary ticks", () => {
    const ticks = [{ x: 0.05 }, { x: 0.5 }, { x: 0.95 }];
    expect(nearestTick(ticks, 0)).toBe(0);
    expect(nearestTick(ticks, 1)).toBe(2);
  });
});
