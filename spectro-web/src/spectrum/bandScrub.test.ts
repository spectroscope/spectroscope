// The band draws a slice and scrubs the WHOLE lane. These pin that gap, because
// it is the one place where "we drew fewer marks" could quietly turn into "you
// can no longer open that event in the trace".

import { describe, expect, it } from "vitest";
import { nearestTick, seqAtFrac, stepSeq } from "./bandScrub";
import { sliceLane } from "./laneSlice";
import type { LaneTick, TickKind } from "./spectrumModel";
import { fit } from "./viewport";

const tick = (x: number, kind: TickKind, seq: number): LaneTick => ({ x, kind, seq });

/** 256 marks packed two to a column across 128 columns: half of them get no rect
 *  of their own. Quarters over a power of two width, so the columns are exact. */
const packed = (): LaneTick[] =>
  Array.from({ length: 256 }, (_, i) =>
    tick((Math.floor(i / 2) + (i % 2 === 0 ? 0.25 : 0.75)) / 128, "token", i),
  );

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

describe("seqAtFrac", () => {
  it("hands back the seq under the pointer, not an array index", () => {
    // Index and seq differ here, which is the whole reason this returns a seq:
    // the drawn array is resliced whenever the stream grows.
    const ticks = [tick(0.1, "token", 40), tick(0.9, "tool", 41)];
    expect(seqAtFrac(ticks, 0.12)).toBe(40);
    expect(seqAtFrac(ticks, 0.88)).toBe(41);
  });

  it("finds an event that the band never drew a rect for", () => {
    // THE regression. Two marks share column 0, so the slice keeps only the
    // first; pointing at the second must still reach the second. Before this
    // was pinned, the band hit-tested the drawn marks and the event was gone:
    // no hover, no preview, no way into the trace.
    const ticks = packed();
    const drawn = sliceLane(ticks, fit(), 128).marks;
    expect(drawn).toHaveLength(128);
    expect(drawn.some((m) => m.seq === 1)).toBe(false);
    expect(seqAtFrac(ticks, ticks[1].x)).toBe(1);
  });

  it("stays null on an empty lane", () => {
    expect(seqAtFrac([], 0.5)).toBeNull();
  });
});

describe("stepSeq", () => {
  it("walks every event, including the ones with no rect", () => {
    // Arrow scrubbing is the keyboard reader's only way through the band. If it
    // walks the drawn marks it silently skips half the run.
    const ticks = packed();
    const seen: number[] = [];
    let at: number | null = null;
    for (let i = 0; i < ticks.length; i++) {
      at = stepSeq(ticks, at, 1);
      seen.push(at as number);
    }
    expect(seen).toHaveLength(256);
    expect(new Set(seen).size).toBe(256);
    expect(seen[0]).toBe(0);
    expect(seen[255]).toBe(255);
  });

  it("enters from the correct end", () => {
    const ticks = [tick(0.1, "token", 7), tick(0.5, "token", 8), tick(0.9, "token", 9)];
    expect(stepSeq(ticks, null, 1)).toBe(7);
    expect(stepSeq(ticks, null, -1)).toBe(9);
  });

  it("stops at the ends instead of wrapping", () => {
    // Wrapping would send a reader from the last event to the first without
    // telling them they had reached the end.
    const ticks = [tick(0.1, "token", 7), tick(0.5, "token", 8)];
    expect(stepSeq(ticks, 8, 1)).toBe(8);
    expect(stepSeq(ticks, 7, -1)).toBe(7);
  });

  it("re-enters from the end when the remembered seq is gone", () => {
    // A live re-fold can drop the scrubbed event out from under the cursor.
    const ticks = [tick(0.1, "token", 7), tick(0.5, "token", 8)];
    expect(stepSeq(ticks, 999, 1)).toBe(7);
  });

  it("stays null on an empty lane", () => {
    expect(stepSeq([], null, 1)).toBeNull();
    expect(stepSeq([], 3, -1)).toBeNull();
  });
});
