// Which trace rows are worth building (card 117).
//
// The trace is a flat list of uniform rows with AT MOST ONE expanded — openSeq
// is a single value, not a set — which is what makes an exact window possible
// without measuring every row. Every offset is arithmetic on three numbers, so
// this is pure and testable, and TraceView only has to supply the measurements.

import { describe, expect, it } from "vitest";
import { traceRowOffset, traceWindow, type TraceWindowSlice } from "./traceWindow";

/** A row height and viewport in the shape the real trace has. */
const ROW = 20;
const VIEW = 600;

/** What a slice says when nothing is pinned beside the window (card 211). */
const UNPINNED = { pinIndex: -1, padPin: 0, pinBefore: false };

/**
 * Every pixel the scroller claims, added up the way the DOM adds it: the
 * spacers, the built rows, and the pinned row where it stands.
 *
 * This is the invariant the whole card turns on. `total` is what the arithmetic
 * believes; the sum below is what the document really is. When the two disagree
 * the browser clamps `scrollTop` to the shorter one and the reader is thrown —
 * measured on the owner's session as a 1,137 px jump backwards.
 */
const laidOut = (w: TraceWindowSlice, rowH: number, openH: number, openIndex: number): number => {
  const inWindow = openIndex >= w.start && openIndex < w.end ? openH - rowH : 0;
  const pinned = w.pinIndex >= 0 ? openH : 0;
  return w.padTop + (w.end - w.start) * rowH + inWindow + w.padPin + pinned + w.padBottom;
};

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
    expect(whole).toEqual({ start: 0, end: 9319, padTop: 0, padBottom: 0, ...UNPINNED });

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
    ).toEqual({ start: 0, end: 100, padTop: 0, padBottom: 0, ...UNPINNED });
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
    expect(top).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0, ...UNPINNED });

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
    // Card 211 splits the old single spacer into three: the rows above the
    // pinned open row, the open row itself, and the rows between it and the
    // window. Their sum is the number that used to be padTop alone.
    expect(w.pinIndex).toBe(5);
    expect(w.padTop + openH + w.padPin).toBe((w.start - 1) * ROW + openH);
    expect(w.padTop + openH + w.padPin).toBeLessThanOrEqual(4000);
    expect(w.padTop + openH + w.padPin + (w.end - w.start) * ROW).toBeGreaterThanOrEqual(4000 + VIEW);
    expect(laidOut(w, ROW, openH, 5)).toBe(1000 * ROW + excess);
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

  // This test used to read "puts an expanded row below the viewport entirely in
  // the bottom pad", and card 211 is the decision that made its premise wrong:
  // a row hidden in a spacer is a row nobody is measuring, and its height is the
  // one number the whole window rests on. So the claim is replaced rather than
  // loosened — the threshold it guarded, an exact total, is asserted verbatim.
  it("builds an expanded row below the viewport beside the window, not inside a pad", () => {
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
    expect(w.pinIndex).toBe(800);
    expect(w.pinBefore).toBe(false);
    // The spacer reaches from the window's last row to the pinned row, and the
    // bottom spacer covers only what is left below it.
    expect(w.padPin).toBe((800 - 40) * ROW);
    expect(w.padBottom).toBe((1000 - 801) * ROW);
    expect(laidOut(w, ROW, openH, 800)).toBe(1000 * ROW + (openH - ROW));
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
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, ...UNPINNED });
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
    // The two must not drift: padTop IS the offset of the first thing the window
    // builds, and a stepper that scrolls somewhere else than the window expects
    // lands the reader on a blank band. With card 211 the first thing built can
    // be the pinned open row rather than `start`, and the agreement is asserted
    // against whichever of the two really comes first.
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
    const firstBuilt = w.pinIndex >= 0 && w.pinBefore ? w.pinIndex : w.start;
    expect(w.padTop).toBe(traceRowOffset(firstBuilt, ROW, 12, openH));
  });
});

// Card 211. The window's arithmetic is exact only while `openH` is true, and
// `openH` can only be measured from a row that exists. Leaving the open row to
// the scroll position means it unmounts the moment the reader travels far
// enough — and then the document is shorter than `total` says, the browser
// clamps `scrollTop` to the shorter one, and the reader is thrown backwards
// with the detail gone. Measured before the fix on the owner's own session:
// scrollTop 1600 → 463, scrollHeight 2552 → 1409.
describe("the open row is built wherever the reader stands", () => {
  const OPEN_H = 1168; // the measured height of the owner's open llm_response

  it("pins an open row the window has scrolled past, and splits the spacer around it", () => {
    const w = traceWindow({
      scrollTop: 40_000,
      viewportH: VIEW,
      count: 9319,
      rowH: ROW,
      openIndex: 6,
      openH: OPEN_H,
      overscan: 10,
    });
    expect(w.start).toBeGreaterThan(6);
    expect(w.pinIndex).toBe(6);
    expect(w.pinBefore).toBe(true);
    // Before the pinned row: its own whole rows. After it: the rest, to the
    // window. Both are whole rows, because the excess belongs to the pin.
    expect(w.padTop).toBe(6 * ROW);
    expect(w.padPin).toBe((w.start - 7) * ROW);
    expect(laidOut(w, ROW, OPEN_H, 6)).toBe(9319 * ROW + (OPEN_H - ROW));
  });

  it("does not pin a row the window already builds", () => {
    const w = traceWindow({
      scrollTop: 0,
      viewportH: VIEW,
      count: 9319,
      rowH: ROW,
      openIndex: 6,
      openH: OPEN_H,
      overscan: 10,
    });
    expect(w.start).toBeLessThanOrEqual(6);
    expect(w.end).toBeGreaterThan(6);
    expect(w).toMatchObject(UNPINNED);
  });

  it("lays out exactly the height it claims, at every scroll position", () => {
    // The one invariant the defect broke. `total` is what the arithmetic
    // believes; `laidOut` is what the document is. They must be the same number
    // wherever the reader stands, or the browser clamps and the reader jumps.
    const total = 9319 * ROW + (OPEN_H - ROW);
    for (const openIndex of [0, 6, 4000, 9318]) {
      for (const scrollTop of [0, 137, 4000, 60_000, 186_000, 999_999]) {
        const w = traceWindow({
          scrollTop,
          viewportH: VIEW,
          count: 9319,
          rowH: ROW,
          openIndex,
          openH: OPEN_H,
          overscan: 10,
        });
        expect(laidOut(w, ROW, OPEN_H, openIndex), `open ${openIndex} at ${scrollTop}`).toBe(total);
        expect(w.padTop, `padTop, open ${openIndex} at ${scrollTop}`).toBeGreaterThanOrEqual(0);
        expect(w.padPin, `padPin, open ${openIndex} at ${scrollTop}`).toBeGreaterThanOrEqual(0);
        expect(w.padBottom, `padBottom, open ${openIndex} at ${scrollTop}`).toBeGreaterThanOrEqual(0);
        // And the row is built, either inside the window or beside it.
        const built = (openIndex >= w.start && openIndex < w.end) || w.pinIndex === openIndex;
        expect(built, `built, open ${openIndex} at ${scrollTop}`).toBe(true);
      }
    }
  });

  it("keeps the open row built at the bottom of the owner's own 55-row session", () => {
    // The session the card was filed from, in its measured numbers: 55 rows of
    // 25 px, a 612 px viewport, the open llm_response at index 6 standing
    // 1,168 px tall, and the reader at the very end of the scroller. This is
    // where the jump was recorded — 1600 → 463, the detail gone.
    const w = traceWindow({
      scrollTop: 55 * 25 + (OPEN_H - 25) - 612,
      viewportH: 612,
      count: 55,
      rowH: 25,
      openIndex: 6,
      openH: OPEN_H,
      overscan: 12,
    });
    expect(w.start).toBeGreaterThan(6);
    expect(w.pinIndex).toBe(6);
    const built = (6 >= w.start && 6 < w.end) || w.pinIndex === 6;
    expect(built).toBe(true);
    expect(laidOut(w, 25, OPEN_H, 6)).toBe(55 * 25 + (OPEN_H - 25));
  });
});
