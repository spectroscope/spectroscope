// Which trace rows are worth building (card 117).
//
// The trace is a flat list of uniform rows with AT MOST ONE expanded — openSeq
// is a single value, not a set — which is what makes an exact window possible
// without measuring every row. Every offset is arithmetic on three numbers, so
// this is pure and testable, and TraceView only has to supply the measurements.

import { describe, expect, it } from "vitest";
import { traceRowOffset, traceWindow } from "./traceWindow";

/** A row height and viewport in the shape the real trace has. */
const ROW = 20;
const VIEW = 600;

describe("the window over a trace", () => {
  it("renders everything when it has not been measured yet", () => {
    // Before layout — and in any test environment without one — the viewport is
    // 0. A window computed from that would render nothing, and a trace is
    // evidence: showing none of it is worse than building all of it. So an
    // unmeasured view renders whole, which is also exactly the behaviour that
    // shipped before this card.
    const whole = traceWindow({
      scrollTop: 0,
      viewportH: 0,
      count: 9319,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 10,
    });
    expect(whole).toEqual({ start: 0, end: 9319, padTop: 0, padBottom: 0 });

    // A row height of 0 means the same thing — nothing has been measured.
    expect(
      traceWindow({
        scrollTop: 0,
        viewportH: VIEW,
        count: 100,
        rowH: 0,
        openIndex: -1,
        openH: 0,
        overscan: 10,
      }),
    ).toEqual({ start: 0, end: 100, padTop: 0, padBottom: 0 });
  });

  it("renders the viewport plus its margin at the top of a long trace", () => {
    const w = traceWindow({
      scrollTop: 0,
      viewportH: VIEW,
      count: 9319,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 10,
    });
    expect(w.start).toBe(0);
    // 600 / 20 = 30 rows on screen, plus 10 of margin below.
    expect(w.end).toBe(40);
    expect(w.padTop).toBe(0);
    // Everything not built still has to occupy its height, or the scrollbar
    // lies about how long the record is.
    expect(w.padBottom).toBe((9319 - 40) * ROW);
  });

  it("keeps the total height exact so the scrollbar tells the truth", () => {
    // padTop + rendered rows + padBottom must equal the untruncated height, at
    // every scroll position. A scrollbar that grows as you scroll is the classic
    // tell of a windowed list that guessed.
    for (const scrollTop of [0, 137, 4000, 60_000, 186_000]) {
      const w = traceWindow({
        scrollTop,
        viewportH: VIEW,
        count: 9319,
        rowH: ROW,
        openIndex: -1,
        openH: 0,
        overscan: 10,
      });
      const rendered = (w.end - w.start) * ROW;
      expect(w.padTop + rendered + w.padBottom, `at ${scrollTop}`).toBe(9319 * ROW);
    }
  });

  it("covers the whole viewport at a scroll position in the middle", () => {
    const scrollTop = 4000; // row 200
    const w = traceWindow({
      scrollTop,
      viewportH: VIEW,
      count: 9319,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 10,
    });
    expect(w.start).toBe(190); // 200 - overscan
    expect(w.end).toBe(240); // 200 + 30 on screen + 10
    expect(w.padTop).toBe(190 * ROW);
    // The rendered slice must actually reach past both edges of the viewport,
    // or the reader sees blank bands while scrolling.
    expect(w.padTop).toBeLessThanOrEqual(scrollTop);
    expect(w.padTop + (w.end - w.start) * ROW).toBeGreaterThanOrEqual(scrollTop + VIEW);
  });

  it("never runs off either end", () => {
    const top = traceWindow({
      scrollTop: 0,
      viewportH: VIEW,
      count: 5,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 10,
    });
    expect(top).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });

    const bottom = traceWindow({
      scrollTop: 9319 * ROW - VIEW,
      viewportH: VIEW,
      count: 9319,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 10,
    });
    expect(bottom.end).toBe(9319);
    expect(bottom.padBottom).toBe(0);
  });

  it("accounts for the one expanded row above the viewport", () => {
    // The expanded row is the whole reason this cannot be scrollTop/rowH. A tall
    // row above the fold pushes everything below it down by exactly its excess,
    // and a window that ignores that lands the reader in the wrong place.
    const openH = 500;
    const w = traceWindow({
      scrollTop: 4000,
      viewportH: VIEW,
      count: 1000,
      rowH: ROW,
      openIndex: 5,
      openH,
      overscan: 10,
    });
    const excess = openH - ROW;
    // 4000px in, minus the extra the open row contributed, is row 176.
    expect(w.start).toBe(176 - 10);
    expect(w.padTop).toBe((w.start - 1) * ROW + openH);
    expect(w.padTop).toBeLessThanOrEqual(4000);
    expect(w.padTop + (w.end - w.start) * ROW).toBeGreaterThanOrEqual(4000 + VIEW);
    expect(w.padTop + (w.end - w.start) * ROW + w.padBottom).toBe(1000 * ROW + excess);
  });

  it("holds the expanded row itself in the window while it is on screen", () => {
    // Scrolled INTO the tall row: it must be built, or the reader stares at a
    // gap where the thing they opened should be.
    const openH = 2000;
    const w = traceWindow({
      scrollTop: 5 * ROW + 800, // inside the open row's own height
      viewportH: VIEW,
      count: 1000,
      rowH: ROW,
      openIndex: 5,
      openH,
      overscan: 2,
    });
    expect(w.start).toBeLessThanOrEqual(5);
    expect(w.end).toBeGreaterThan(5);
  });

  it("puts an expanded row below the viewport entirely in the bottom pad", () => {
    const openH = 900;
    const w = traceWindow({
      scrollTop: 0,
      viewportH: VIEW,
      count: 1000,
      rowH: ROW,
      openIndex: 800,
      openH,
      overscan: 10,
    });
    expect(w.end).toBe(40);
    expect(w.padTop + (w.end - w.start) * ROW + w.padBottom).toBe(1000 * ROW + (openH - ROW));
  });

  it("treats an out-of-range open index as nothing open", () => {
    // The filter can hide the open row: openSeq survives, its index does not.
    // A stale index must not bend every offset below it.
    const plain = traceWindow({
      scrollTop: 400,
      viewportH: VIEW,
      count: 100,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 5,
    });
    for (const openIndex of [-1, -7, 100, 5000]) {
      expect(
        traceWindow({
          scrollTop: 400,
          viewportH: VIEW,
          count: 100,
          rowH: ROW,
          openIndex,
          openH: 900,
          overscan: 5,
        }),
        `openIndex ${openIndex}`,
      ).toEqual(plain);
    }
  });

  it("survives an empty list", () => {
    expect(
      traceWindow({
        scrollTop: 0,
        viewportH: VIEW,
        count: 0,
        rowH: ROW,
        openIndex: -1,
        openH: 0,
        overscan: 10,
      }),
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("clamps a scroll position past the end rather than rendering nothing", () => {
    // A filter that shortens the list leaves scrollTop past the new end for one
    // frame. Rendering an empty window there would flash the trace blank.
    const w = traceWindow({
      scrollTop: 999_999,
      viewportH: VIEW,
      count: 100,
      rowH: ROW,
      openIndex: -1,
      openH: 0,
      overscan: 5,
    });
    expect(w.end).toBe(100);
    expect(w.start).toBeLessThan(100);
    expect(w.padBottom).toBe(0);
  });
});

describe("where a row sits, for the stepper and the search walk", () => {
  it("is the plain multiple when nothing is expanded", () => {
    expect(traceRowOffset(0, ROW, -1, 0)).toBe(0);
    expect(traceRowOffset(137, ROW, -1, 0)).toBe(137 * ROW);
  });

  it("pushes every row below the expanded one down by its excess", () => {
    const openH = 500;
    expect(traceRowOffset(4, ROW, 5, openH)).toBe(4 * ROW);
    expect(traceRowOffset(5, ROW, 5, openH)).toBe(5 * ROW);
    expect(traceRowOffset(6, ROW, 5, openH)).toBe(5 * ROW + openH);
  });

  it("agrees with the window it has to scroll into", () => {
    // The two must not drift: padTop IS the offset of the first built row, and
    // a stepper that scrolls somewhere else than the window expects lands the
    // reader on a blank band.
    const openH = 400;
    const w = traceWindow({
      scrollTop: 3000,
      viewportH: VIEW,
      count: 1000,
      rowH: ROW,
      openIndex: 12,
      openH,
      overscan: 6,
    });
    expect(w.padTop).toBe(traceRowOffset(w.start, ROW, 12, openH));
  });
});
