// The strip is the orientation surface: at 200x you are inside half a percent of
// the axis and the band alone cannot tell you where. It draws a count of
// discrete things, so it draws BARS, not a waveform (which would imply a
// continuous quantity) and not a filmstrip (which would imply continuous media).

import { describe, expect, it } from "vitest";
import { barHeight, densityProfile, needsViewport } from "./overview";
import type { LaneTick, TickKind } from "./spectrumModel";

const tick = (x: number, kind: TickKind, seq: number): LaneTick => ({ x, kind, seq });

describe("densityProfile", () => {
  it("returns one column per requested column, empty ones included", () => {
    // Empty columns are the point: 83% of a real transcript's axis is dead air,
    // and the gaps are what make the working rhythm legible.
    const cols = densityProfile([tick(0, "token", 0)], 10);
    expect(cols).toHaveLength(10);
    expect(cols[0].count).toBe(1);
    expect(cols[5]).toEqual({ count: 0, kind: null, marker: false });
  });

  it("counts the marks that fall in each column", () => {
    const ticks = [
      tick(0.01, "token", 0),
      tick(0.02, "token", 1),
      tick(0.03, "token", 2),
      tick(0.55, "token", 3),
    ];
    const cols = densityProfile(ticks, 10);
    expect(cols[0].count).toBe(3);
    expect(cols[5].count).toBe(1);
  });

  it("names the dominant kind of a column", () => {
    const ticks = [tick(0.01, "token", 0), tick(0.02, "token", 1), tick(0.03, "reasoning", 2)];
    expect(densityProfile(ticks, 10)[0].kind).toBe("token");
  });

  it("gives a gate or an error the column, however badly it is outnumbered", () => {
    // A single denied write inside a thousand token deltas is the event a reader
    // is scanning for. It cannot be averaged away by the flood around it.
    const flood = Array.from({ length: 50 }, (_, i) => tick(0.001 * i, "token", i));
    const withGate = densityProfile([...flood, tick(0.02, "gate", 99)], 10);
    expect(withGate[0].kind).toBe("gate");
    expect(withGate[0].marker).toBe(true);
    const withError = densityProfile([...flood, tick(0.02, "error", 99)], 10);
    expect(withError[0].kind).toBe("error");
    expect(withError[0].marker).toBe(true);
    // An error outranks a gate when both land in the same column.
    const both = densityProfile([tick(0.01, "gate", 0), tick(0.02, "error", 1)], 10);
    expect(both[0].kind).toBe("error");
  });

  it("marks nothing when a column holds no gate and no error", () => {
    expect(densityProfile([tick(0.01, "token", 0)], 10)[0].marker).toBe(false);
  });

  it("puts the last mark inside the last column rather than one past the end", () => {
    const cols = densityProfile([tick(1, "lifecycle", 0)], 10);
    expect(cols[9].count).toBe(1);
  });

  it("stays calm on an empty lane and a nonsense column count", () => {
    expect(densityProfile([], 10).every((c) => c.count === 0)).toBe(true);
    expect(densityProfile([tick(0.5, "token", 0)], 0)).toEqual([]);
    expect(densityProfile([tick(0.5, "token", 0)], -3)).toEqual([]);
  });
});

describe("needsViewport", () => {
  // The strip and the axis are for the streams that need them. The threshold is
  // half: a lane that cannot draw half of what it carries is a lane a reader
  // cannot read at full extent. Measured over the 147 sessions of one real store
  // on 2026-08-03 at 900 px, 9 of them cross it, and both of the long ones are
  // among the nine. The looser question, "did any two marks collide", was true
  // for 55 of the 147, which is not a feature that disappears.
  it("is false when every mark already owns a pixel column", () => {
    const lanes = [{ ticks: [tick(0, "token", 0), tick(0.5, "token", 1), tick(1, "token", 2)] }];
    expect(needsViewport(lanes, 1000)).toBe(false);
  });

  it("is false for a short run where one pair happens to collide", () => {
    // Three lifecycle marks, two of them a millisecond apart. This is an ordinary
    // local run, and it is 15 of the 55 that the old "any collision" rule caught:
    // handing it an overview strip and a time axis would be answering a question
    // nobody asked. One mark of three is not a stream you have to navigate.
    const lanes = [
      { ticks: [tick(0, "lifecycle", 0), tick(0.0008, "lifecycle", 1), tick(1, "lifecycle", 2)] },
    ];
    expect(needsViewport(lanes, 900)).toBe(false);
  });

  it("is true once a lane draws less than half of what it carries", () => {
    // Sixteen marks into five columns: the band is showing a third of the lane,
    // and no amount of squinting recovers the rest.
    const crowded = Array.from({ length: 16 }, (_, i) => tick(i / 300, "token", i));
    expect(needsViewport([{ ticks: crowded }], 100)).toBe(true);
  });

  it("asks the question per lane, so one crowded agent is enough", () => {
    const roomy = [tick(0, "token", 0), tick(0.5, "token", 1), tick(1, "token", 2)];
    const crowded = Array.from({ length: 40 }, (_, i) => tick(0.5 + i / 100000, "token", i));
    expect(needsViewport([{ ticks: roomy }], 900)).toBe(false);
    expect(needsViewport([{ ticks: roomy }, { ticks: crowded }], 900)).toBe(true);
  });

  it("is true as soon as one lane cannot fit into the pixels it has", () => {
    const dense = Array.from({ length: 400 }, (_, i) => tick(i / 400 / 100, "token", i));
    expect(needsViewport([{ ticks: dense }], 100)).toBe(true);
  });

  it("takes no window, so zooming in can never hide the way back out", () => {
    // The signature is the guarantee. Were this asked of the CURRENT window,
    // zooming into a sparse minute would drop the strip to zero hidden marks,
    // the strip would vanish, and the reader would be stranded at 200x with no
    // orientation surface and no way back. It can only be asked of the whole.
    expect(needsViewport).toHaveLength(2);
  });

  it("says yes for a pile of tied timestamps, which is honest even though zoom cannot part them", () => {
    // The importer stamps every content block of one transcript record with that
    // record's single timestamp, so ties arrive by the thousand. Marks really
    // are hidden; the strip really does have something to say about where they
    // sit. That no magnification separates them is the footer's job to admit.
    const tied = Array.from({ length: 40 }, (_, i) => tick(0.5, "token", i));
    expect(needsViewport([{ ticks: tied }], 1000)).toBe(true);
  });

  it("stays calm on an empty lane list", () => {
    expect(needsViewport([], 1000)).toBe(false);
    expect(needsViewport([{ ticks: [] }], 1000)).toBe(false);
  });
});

describe("barHeight", () => {
  // A four day transcript puts 1 event in one column and 3843 in another.
  // Linear heights would draw the whole day as a flat line beside one spike, so
  // the strip borrows the log scale the timeline lens already uses for waits.
  it("gives the busiest column the full height", () => {
    expect(barHeight(3843, 3843, 30)).toBeCloseTo(30, 6);
  });

  it("keeps a single event visible instead of rounding it to nothing", () => {
    const h = barHeight(1, 3843, 30);
    expect(h).toBeGreaterThanOrEqual(2);
    expect(h).toBeLessThan(30);
  });

  it("is log scaled, so a hundred events is not a hundredth of the picture", () => {
    // Linear would put 100/3843 at 0.8 of a pixel. Log puts it around a third.
    const h = barHeight(100, 3843, 30);
    expect(h).toBeGreaterThan(30 * 0.4);
    expect(h).toBeLessThan(30 * 0.8);
  });

  it("draws nothing for an empty column", () => {
    expect(barHeight(0, 3843, 30)).toBe(0);
  });

  it("stays finite when every column holds exactly one mark", () => {
    const h = barHeight(1, 1, 30);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeCloseTo(30, 6);
  });

  it("stays finite on nonsense", () => {
    for (const h of [barHeight(5, 0, 30), barHeight(NaN, 10, 30), barHeight(5, 10, NaN)]) {
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
    }
  });
});
