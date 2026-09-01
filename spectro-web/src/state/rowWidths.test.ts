// Card 361 — one owner for the chat row's widths.
//
// THE DEFECT, transcribed rather than remembered: `resizeRightPanel`
// (App.tsx:474) and `resizeImages` (App.tsx:487) each subtracted the SAME
// reserve from the SAME row with no knowledge of the other. The first case
// below rebuilds the two formulas — the gallery's drag clamp and the dock's
// render-time cap — so the −318 it produces is derived here and not copied out
// of the card's prose.
//
// It is arithmetic, not a live measurement: this suite has no layout engine,
// and the card's own number came from a browser. What these cases pin is a
// property of the formulas, which needs no browser to be true.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_RESERVE_PX,
  DEFAULT_DOCK_MAX_PX,
  ROW_RESIZER_PX,
  chatWidthLeft,
  fitRowPanel,
  readDockWidths,
} from "./rowWidths";

/** The owner's row on 2026-09-01, as the card measured it. */
const ROW = 1030;
/** The gallery's shipped width (DEFAULT_LAYOUT.imagesW). */
const GALLERY = 300;
const DOCK_MIN = 260;

describe("the row the two handlers were sharing", () => {
  it("spends the reserve twice when each handler holds it alone", () => {
    // The gallery, dragged to its limit: App.tsx:487, Math.min(desired,
    // row - reserve) — the handle it sits behind is not counted.
    const gallery = Math.min(9999, ROW - DEFAULT_CHAT_RESERVE_PX);
    // The dock, dragged to ITS limit and then capped where it is DRAWN:
    // panels.css:15, calc(100% - reserve - 8px). Eight pixels tighter than the
    // drag clamp beside it, which is the disagreement criterion 4 closes.
    const dock = ROW - DEFAULT_CHAT_RESERVE_PX - ROW_RESIZER_PX;
    expect(chatWidthLeft(ROW, [gallery, dock])).toBe(-318);
  });

  it("counts one resizer per docked panel — the row's own arithmetic", () => {
    expect(chatWidthLeft(1000, [])).toBe(1000);
    expect(chatWidthLeft(1000, [200])).toBe(1000 - 200 - ROW_RESIZER_PX);
    expect(chatWidthLeft(1000, [200, 300])).toBe(1000 - 500 - 2 * ROW_RESIZER_PX);
  });
});

describe("fitRowPanel is the one owner", () => {
  it("leaves the chat its reserve while the gallery is open", () => {
    const dock = fitRowPanel({
      row: ROW,
      desired: 9999,
      occupied: GALLERY + ROW_RESIZER_PX,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    });
    expect(chatWidthLeft(ROW, [GALLERY, dock])).toBeGreaterThanOrEqual(DEFAULT_CHAT_RESERVE_PX);
  });

  it("leaves the chat its reserve when the GALLERY is the one being dragged", () => {
    // The other direction of the same defect: whichever handler runs must see
    // the panel it is not dragging.
    const dockNow = 300;
    const gallery = fitRowPanel({
      row: ROW,
      desired: 9999,
      occupied: dockNow + ROW_RESIZER_PX,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: 240,
      max: 1200,
    });
    expect(chatWidthLeft(ROW, [gallery, dockNow])).toBeGreaterThanOrEqual(DEFAULT_CHAT_RESERVE_PX);
  });

  it("honours the ceiling on a wide row, where the reserve never binds", () => {
    // Above ~1560px of row the ceiling is what stops the drag, which is the
    // crossover the card measured: raising only the reserve changes nothing here.
    const dock = fitRowPanel({
      row: 2560,
      desired: 9999,
      occupied: 0,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    });
    expect(dock).toBe(DEFAULT_DOCK_MAX_PX);
  });

  it("a raised ceiling actually reaches the drag", () => {
    const dock = fitRowPanel({
      row: 3000,
      desired: 9999,
      occupied: 0,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: 2400,
    });
    expect(dock).toBe(2400);
  });

  it("a raised reserve actually reaches the drag", () => {
    const dock = fitRowPanel({
      row: ROW,
      desired: 9999,
      occupied: 0,
      reserve: 600,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    });
    expect(chatWidthLeft(ROW, [dock])).toBeGreaterThanOrEqual(600);
  });

  it("never returns less than the panel can be read at", () => {
    // A row too narrow for both minima plus the reserve cannot satisfy
    // everything. The panel's own floor wins there and the render-time cap in
    // panels.css shrinks what is drawn — the store never keeps a width the
    // panel is unreadable at, and a wider window restores the drag.
    const dock = fitRowPanel({
      row: 500,
      desired: 9999,
      occupied: 300,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    });
    expect(dock).toBe(DOCK_MIN);
  });

  it("clamps a desired width up to the floor and down to the ceiling", () => {
    const opts = {
      row: 4000,
      occupied: 0,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    };
    expect(fitRowPanel({ ...opts, desired: 10 })).toBe(DOCK_MIN);
    expect(fitRowPanel({ ...opts, desired: 99999 })).toBe(DEFAULT_DOCK_MAX_PX);
    expect(fitRowPanel({ ...opts, desired: 640.4 })).toBe(640);
  });

  it("a row it cannot measure changes nothing — junk in, floor out", () => {
    const dock = fitRowPanel({
      row: Number.NaN,
      desired: 700,
      occupied: 0,
      reserve: DEFAULT_CHAT_RESERVE_PX,
      min: DOCK_MIN,
      max: DEFAULT_DOCK_MAX_PX,
    });
    expect(dock).toBe(700);
  });
});

describe("what the settings view hands over", () => {
  it("takes the two keys when the server resolved them", () => {
    expect(readDockWidths({ chatReserveWidth: 420, dockMaxWidth: 2400 })).toEqual({
      reserve: 420,
      max: 2400,
    });
  });

  it("falls back to the shipped values for a null, a string or a missing key", () => {
    const shipped = { reserve: DEFAULT_CHAT_RESERVE_PX, max: DEFAULT_DOCK_MAX_PX };
    expect(readDockWidths({})).toEqual(shipped);
    expect(readDockWidths({ chatReserveWidth: null, dockMaxWidth: null })).toEqual(shipped);
    expect(readDockWidths({ chatReserveWidth: "420", dockMaxWidth: "2400" })).toEqual(shipped);
    expect(readDockWidths({ chatReserveWidth: Number.NaN, dockMaxWidth: Infinity })).toEqual(shipped);
  });

  it("refuses a reserve below zero and a ceiling under the panel's own floor", () => {
    // A negative reserve would hand the dock more room than the row has; a
    // ceiling under the minimum would make every drag illegal. Both heal to
    // the shipped value rather than wedging the layout (the card-241 rule).
    expect(readDockWidths({ chatReserveWidth: -40, dockMaxWidth: 100 })).toEqual({
      reserve: DEFAULT_CHAT_RESERVE_PX,
      max: DEFAULT_DOCK_MAX_PX,
    });
  });

  it("rounds a fractional setting rather than carrying it into a CSS length", () => {
    expect(readDockWidths({ chatReserveWidth: 361.6, dockMaxWidth: 1199.2 })).toEqual({
      reserve: 362,
      max: 1199,
    });
  });
});
