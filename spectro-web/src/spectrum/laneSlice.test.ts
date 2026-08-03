// Thinning is a question about the VIEWPORT, not about the fold. These pin the
// rule that replaces the old fixed budget: one mark per pixel column and kind,
// so narrowing the window strictly reveals more, and the count under the band
// says what THIS window hides rather than what the stream holds.

import { describe, expect, it } from "vitest";
import type { LaneTick, TickKind } from "./spectrumModel";
import { pageNext, pagePrev, sliceLane, visibleRange } from "./laneSlice";
import { fit } from "./viewport";

const tick = (x: number, kind: TickKind, seq: number): LaneTick => ({ x, kind, seq });

/** Evenly spaced marks of one kind: the token flood, in miniature. */
const spread = (n: number, kind: TickKind = "token"): LaneTick[] =>
  Array.from({ length: n }, (_, i) => tick(n === 1 ? 0 : i / (n - 1), kind, i));

describe("visibleRange", () => {
  const ticks = [
    tick(0, "lifecycle", 0),
    tick(0.25, "token", 1),
    tick(0.5, "tool", 2),
    tick(0.75, "token", 3),
    tick(1, "lifecycle", 4),
  ];

  it("returns the half-open span of ticks inside the window", () => {
    expect(visibleRange(ticks, { a: 0.2, b: 0.6 })).toEqual([1, 3]);
  });

  it("includes both edges: a mark exactly on a boundary is visible", () => {
    expect(visibleRange(ticks, { a: 0.25, b: 0.75 })).toEqual([1, 4]);
  });

  it("returns the whole array at full extent", () => {
    expect(visibleRange(ticks, fit())).toEqual([0, 5]);
  });

  it("returns an empty span for a window over dead air", () => {
    expect(visibleRange(ticks, { a: 0.8, b: 0.9 })).toEqual([4, 4]);
  });

  it("stays calm on an empty lane", () => {
    expect(visibleRange([], fit())).toEqual([0, 0]);
  });
});

describe("sliceLane", () => {
  it("keeps at most one mark per pixel column and kind", () => {
    // Three tokens and a tool inside a single 10px column.
    const ticks = [
      tick(0.01, "token", 0),
      tick(0.02, "tool", 1),
      tick(0.03, "token", 2),
      tick(0.04, "token", 3),
    ];
    const { marks, hidden } = sliceLane(ticks, fit(), 10);
    expect(marks.map((m) => m.seq)).toEqual([0, 1]);
    expect(hidden).toBe(2);
  });

  it("never drops an error or a gate that is in range", () => {
    // A column stuffed with tokens: the two marks a reader must not miss are
    // distinct kinds, so the per-kind rule carries them through on its own.
    const ticks: LaneTick[] = [
      ...Array.from({ length: 50 }, (_, i) => tick(0.001 * i, "token", i)),
      tick(0.02, "gate", 90),
      tick(0.03, "error", 91),
    ].sort((p, q) => p.x - q.x || p.seq - q.seq);
    const { marks } = sliceLane(ticks, fit(), 10);
    expect(marks.some((m) => m.kind === "gate")).toBe(true);
    expect(marks.some((m) => m.kind === "error")).toBe(true);
  });

  it("reveals more marks as the window narrows", () => {
    // The property the whole feature rests on. 40 marks over 4 columns: at full
    // extent the first quarter is one column and collapses to a single mark.
    const ticks = spread(40);
    const whole = sliceLane(ticks, fit(), 4);
    const inFirstQuarter = whole.marks.filter((m) => m.x <= 0.25).length;
    const zoomed = sliceLane(ticks, { a: 0, b: 0.25 }, 4);
    expect(inFirstQuarter).toBe(1);
    expect(zoomed.marks.length).toBeGreaterThan(inFirstQuarter);
  });

  it("counts what the window hides, not what the stream holds", () => {
    // Ten marks in the left tenth, one alone on the right. A window over the
    // right one hides NOTHING, even though the lane carries ten more.
    const ticks = [
      ...Array.from({ length: 10 }, (_, i) => tick(i * 0.001, "token", i)),
      tick(0.9, "token", 10),
    ];
    expect(sliceLane(ticks, { a: 0.8, b: 1 }, 100).hidden).toBe(0);
    expect(sliceLane(ticks, fit(), 100).hidden).toBe(9);
  });

  it("hides nothing when every visible tick owns its column", () => {
    const ticks = [tick(0.1, "token", 0), tick(0.5, "tool", 1), tick(0.9, "gate", 2)];
    const { marks, hidden } = sliceLane(ticks, fit(), 200);
    expect(marks).toHaveLength(3);
    expect(hidden).toBe(0);
  });

  it("collapses ticks that share one instant and keeps saying so at every zoom", () => {
    // The importer stamps every content block of one transcript record with that
    // record's timestamp, so these ties are made upstream, not by the reader.
    // No magnification can separate them, and the count must not pretend it can.
    const ticks = Array.from({ length: 10 }, (_, i) => tick(0.4, "token", i));
    for (const win of [fit(), { a: 0.3, b: 0.5 }, { a: 0.399, b: 0.401 }]) {
      const { marks, hidden } = sliceLane(ticks, win, 800);
      expect(marks).toHaveLength(1);
      expect(hidden).toBe(9);
    }
  });

  it("pins the exact density rule: one column per kind, counted", () => {
    // The real safety net, and the reason the identity test below is not one.
    //
    // Identity on a sparse lane is arithmetic, not evidence: nine marks a tenth
    // of the axis apart cannot collide at 1000 px whatever the rule underneath
    // is, so that test passes even if the column rule is made fifty times
    // coarser. This one fixes the numbers. 200 evenly spread marks across 100
    // columns is exactly 100 drawn and exactly 100 hidden, and any change to
    // how a column is computed moves one of those two numbers.
    // Exactly two marks in each of 128 columns. The width is a power of two and
    // the offsets are quarters on purpose: c/100 is not a binary fraction, so a
    // fixture built on hundredths puts its own marks in the wrong column and
    // then blames the code. (c + 0.25) / 128 is exact.
    const COLS = 128;
    const pairs = (kindOf: (i: number) => TickKind): LaneTick[] =>
      Array.from({ length: 2 * COLS }, (_, i) =>
        tick((Math.floor(i / 2) + (i % 2 === 0 ? 0.25 : 0.75)) / COLS, kindOf(i), i),
      );

    const same = sliceLane(
      pairs(() => "token"),
      fit(),
      COLS,
    );
    expect(same.marks).toHaveLength(128);
    expect(same.hidden).toBe(128);

    // Per KIND, not per column: give the second mark of every column a different
    // kind and the whole lane survives, because a tool never hides behind a
    // token. Same instants, same width, twice the ink.
    const mixed = sliceLane(
      pairs((i) => (i % 2 === 0 ? "token" : "tool")),
      fit(),
      COLS,
    );
    expect(mixed.marks).toHaveLength(256);
    expect(mixed.hidden).toBe(0);
  });

  it("pins the full-extent slice on a SPARSE lane: nothing collides, nothing drops", () => {
    // True, and much weaker than it looks: this says a lane with room on screen
    // is untouched. It does NOT say the view renders what it rendered before the
    // per-column rule arrived. On a real store that claim is false for 55 of 147
    // sessions, where the old fold drew every mark and this one dedupes the
    // pile. The count under the band is what reports that, and the test above is
    // what pins it.
    const ticks = [
      tick(0, "lifecycle", 0),
      tick(0.1, "reasoning", 1),
      tick(0.2, "token", 2),
      tick(0.3, "subagent", 3),
      tick(0.45, "tool", 4),
      tick(0.55, "gate", 5),
      tick(0.7, "tool", 6),
      tick(0.85, "error", 7),
      tick(1, "lifecycle", 8),
    ];
    const { marks, hidden } = sliceLane(ticks, fit(), 1000);
    expect(marks).toEqual(ticks);
    expect(hidden).toBe(0);
  });

  it("stays calm on an empty lane, a single mark and a viewport with no width", () => {
    expect(sliceLane([], fit(), 500)).toEqual({ marks: [], hidden: 0 });
    expect(sliceLane([tick(0, "token", 0)], fit(), 500).marks).toHaveLength(1);
    const noWidth = sliceLane(spread(20), fit(), 0);
    expect(noWidth.marks.length).toBeGreaterThan(0);
    expect(noWidth.hidden).toBe(20 - noWidth.marks.length);
  });
});

describe("pageNext", () => {
  it("pans one window width when the next page has marks on it", () => {
    const ticks = [tick(0.05, "token", 0), tick(0.15, "token", 1), tick(0.25, "token", 2)];
    const w = pageNext(ticks, { a: 0, b: 0.1 });
    expect(w.a).toBeCloseTo(0.1, 12);
    expect(w.b).toBeCloseTo(0.2, 12);
  });

  it("pages across dead air by snapping the next mark to the left edge", () => {
    // 83% of this axis is empty. Crossing it takes one press, and it needs no
    // invented burst threshold to decide where to land.
    const ticks = [tick(0, "token", 0), tick(0.9, "token", 1)];
    const w = pageNext(ticks, { a: 0, b: 0.1 });
    expect(w.a).toBeCloseTo(0.9, 12);
    expect(w.b).toBeCloseTo(1, 12);
  });

  it("does nothing at the last mark", () => {
    const ticks = [tick(0.1, "token", 0), tick(0.5, "token", 1)];
    const win = { a: 0.45, b: 0.55 };
    expect(pageNext(ticks, win)).toEqual(win);
  });

  it("does nothing on an empty lane", () => {
    const win = { a: 0.2, b: 0.4 };
    expect(pageNext([], win)).toEqual(win);
  });
});

describe("pagePrev", () => {
  it("pans one window width back when that page has marks on it", () => {
    const ticks = [tick(0.05, "token", 0), tick(0.15, "token", 1), tick(0.25, "token", 2)];
    const w = pagePrev(ticks, { a: 0.2, b: 0.3 });
    expect(w.a).toBeCloseTo(0.1, 12);
    expect(w.b).toBeCloseTo(0.2, 12);
  });

  it("pages back across dead air by snapping the previous mark to the RIGHT edge", () => {
    // Going back, you want to land where the earlier work ENDED, so the mark
    // arrives at the trailing edge and its run reads forward from there.
    const ticks = [tick(0.3, "token", 0), tick(0.9, "token", 1)];
    const w = pagePrev(ticks, { a: 0.9, b: 1 });
    expect(w.b).toBeCloseTo(0.3, 12);
    expect(w.a).toBeCloseTo(0.2, 12);
  });

  it("does nothing at the first mark", () => {
    const ticks = [tick(0.5, "token", 0), tick(0.9, "token", 1)];
    const win = { a: 0.45, b: 0.55 };
    expect(pagePrev(ticks, win)).toEqual(win);
  });

  it("does nothing on an empty lane", () => {
    const win = { a: 0.2, b: 0.4 };
    expect(pagePrev([], win)).toEqual(win);
  });

  it("undoes a page forward across the same dead air", () => {
    const ticks = [tick(0.3, "token", 0), tick(0.9, "token", 1)];
    const start = { a: 0.25, b: 0.35 };
    const there = pageNext(ticks, start);
    const back = pagePrev(ticks, there);
    // Not byte-identical to where it started, but back on the same mark.
    expect(back.a).toBeLessThanOrEqual(0.3);
    expect(back.b).toBeGreaterThanOrEqual(0.3);
  });
});
