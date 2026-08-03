// The viewport is a pair of fractions over the shared time axis. Clamping two
// coupled quantities is where the classic inversion bug lives, so every mutation
// funnels through one normalize and every invariant it owes is pinned here.

import { describe, expect, it } from "vitest";
import {
  fit,
  fromScreen,
  isWhole,
  minWidthFor,
  normalize,
  panBy,
  rebase,
  storeWindow,
  toScreen,
  zoomAt,
} from "./viewport";

/** A 100x floor: most cases below do not care about the number, only that the
 *  window can never fall through it. */
const M = 0.01;

describe("normalize", () => {
  it("never returns an inverted window", () => {
    const w = normalize(0.8, 0.2, M);
    expect(w.a).toBeLessThan(w.b);
    expect(w).toEqual({ a: 0.2, b: 0.8 });
  });

  it("shifts a window that starts before the domain, it does not clip it", () => {
    // The naive fix clamps a and b independently and silently changes the zoom
    // level as a side effect of panning. This is the test that catches it.
    expect(normalize(-0.2, 0.3, M)).toEqual({ a: 0, b: 0.5 });
  });

  it("shifts a window that ends after the domain, it does not clip it", () => {
    expect(normalize(0.8, 1.3, M)).toEqual({ a: 0.5, b: 1 });
  });

  it("collapses a window wider than the domain to the whole", () => {
    expect(normalize(-0.5, 1.5, M)).toEqual({ a: 0, b: 1 });
  });

  it("holds the floor, keeping the midpoint when it has to widen", () => {
    const w = normalize(0.5, 0.5001, M);
    expect(w.b - w.a).toBeCloseTo(M, 12);
    expect((w.a + w.b) / 2).toBeCloseTo(0.50005, 12);
  });

  it("lets no NaN through", () => {
    for (const w of [normalize(NaN, 0.5, M), normalize(0.2, NaN, M), normalize(0.2, 0.8, NaN)]) {
      expect(Number.isFinite(w.a)).toBe(true);
      expect(Number.isFinite(w.b)).toBe(true);
      expect(w.a).toBeLessThan(w.b);
    }
  });
});

describe("zoomAt", () => {
  it("never zooms below the minimum width", () => {
    let w = fit();
    for (let i = 0; i < 40; i++) w = zoomAt(w, 0.5, 0.5, M);
    expect(w.b - w.a).toBeCloseTo(M, 12);
  });

  it("holds the anchor at the same screen fraction in the interior", () => {
    const win = { a: 0.2, b: 0.8 };
    const anchor = 0.5;
    const before = (anchor - win.a) / (win.b - win.a);
    const after = zoomAt(win, anchor, 0.5, M);
    expect((anchor - after.a) / (after.b - after.a)).toBeCloseTo(before, 12);
  });

  it("gives the anchor up at the edge rather than leaving the domain", () => {
    // Zooming out from a window pinned at 0: the anchor CANNOT stay put without
    // pushing a below zero. The window wins, the anchor moves, and a stays 0.
    const win = { a: 0, b: 0.4 };
    const anchor = 0.02;
    const before = (anchor - win.a) / (win.b - win.a);
    const after = zoomAt(win, anchor, 2, M);
    expect(after.a).toBe(0);
    expect(after.b).toBeCloseTo(0.8, 12);
    expect((anchor - after.a) / (after.b - after.a)).not.toBeCloseTo(before, 6);
  });

  it("survives a factor of zero, a negative factor and NaN", () => {
    const win = { a: 0.2, b: 0.6 };
    for (const bad of [0, -1, NaN, Infinity]) {
      const w = zoomAt(win, 0.4, bad, M);
      expect(Number.isFinite(w.a)).toBe(true);
      expect(Number.isFinite(w.b)).toBe(true);
      expect(w.a).toBeLessThan(w.b);
    }
  });

  it("clamps an anchor that sits outside the window instead of flinging it", () => {
    const w = zoomAt({ a: 0.4, b: 0.6 }, 9, 0.5, M);
    expect(w.a).toBeGreaterThanOrEqual(0);
    expect(w.b).toBeLessThanOrEqual(1);
    expect(w.a).toBeLessThan(w.b);
  });
});

describe("panBy", () => {
  it("moves the window without changing its width", () => {
    const w = panBy({ a: 0.2, b: 0.4 }, 0.1, M);
    expect(w.a).toBeCloseTo(0.3, 12);
    expect(w.b).toBeCloseTo(0.5, 12);
  });

  it("stops at the domain edge as a rigid body", () => {
    // Overshooting right must not squash the window against the wall: the width
    // that went in is the width that comes out.
    const right = panBy({ a: 0.7, b: 0.9 }, 0.5, M);
    expect(right.a).toBeCloseTo(0.8, 12);
    expect(right.b).toBeCloseTo(1, 12);
    const left = panBy({ a: 0.1, b: 0.3 }, -0.5, M);
    expect(left.a).toBeCloseTo(0, 12);
    expect(left.b).toBeCloseTo(0.2, 12);
  });
});

describe("screen mapping", () => {
  it("round-trips a position through toScreen and fromScreen", () => {
    const win = { a: 0.25, b: 0.75 };
    for (const x of [0.25, 0.3, 0.5, 0.74, 0.75]) {
      const px = toScreen(x, win, 800);
      expect(fromScreen(px, win, 800)).toBeCloseTo(x, 12);
    }
  });

  it("returns null instead of NaN for a zero-width viewport", () => {
    expect(fromScreen(10, fit(), 0)).toBeNull();
    expect(fromScreen(10, fit(), -5)).toBeNull();
  });
});

describe("fit", () => {
  it("fits to the whole domain", () => {
    expect(fit()).toEqual({ a: 0, b: 1 });
  });
});

describe("minWidthFor", () => {
  it("makes zoom a no-op when the span is at or below the floor", () => {
    expect(minWidthFor(1_000, 1_000)).toBe(1);
    expect(minWidthFor(400, 1_000)).toBe(1);
  });

  it("is a fixed duration, never derived from what is on screen", () => {
    // A 30 second session can still be opened down to one second, which is 30x.
    expect(minWidthFor(30_000, 1_000)).toBeCloseTo(1 / 30, 12);
    // Four days of transcript: the same one second floor, now a much deeper well.
    expect(minWidthFor(325_000_000, 1_000)).toBeCloseTo(1 / 325_000, 12);
  });

  it("stays finite on an empty or broken span", () => {
    expect(minWidthFor(0, 1_000)).toBe(1);
    expect(minWidthFor(-5, 1_000)).toBe(1);
    expect(minWidthFor(NaN, 1_000)).toBe(1);
  });
});

describe("rebase", () => {
  // A live stream grows t1 under a zoomed reader. Every x in the model is
  // renormalized against the new span, so a window left alone would silently
  // drag off the content it was pointed at. Neither recon caught this one.
  const HOUR = 3_600_000;

  it("holds the window on the same absolute instants when the span grows", () => {
    // Watching the second hour of a two hour stream, which then runs to four.
    const win = { a: 0.5, b: 1 };
    const next = rebase(win, 0, 2 * HOUR, 0, 4 * HOUR);
    expect(next.a).toBeCloseTo(0.25, 12);
    expect(next.b).toBeCloseTo(0.5, 12);
  });

  it("holds them when the stream grows at the FRONT as well", () => {
    // An import can prepend history: t0 moves too, and both edges must follow.
    const next = rebase({ a: 0, b: 0.5 }, HOUR, 3 * HOUR, 0, 4 * HOUR);
    expect(next.a).toBeCloseTo(0.25, 12);
    expect(next.b).toBeCloseTo(0.5, 12);
  });

  it("does NOT hold a full window at full extent, which is why following is a null window", () => {
    // Rebasing means absolute instants, and the old whole is not the new whole.
    // The view keeps "follow the live edge" as a null window instead of trying
    // to express it as a pair of fractions that a growing span keeps rewriting.
    const next = rebase(fit(), 0, 2 * HOUR, 0, 4 * HOUR);
    expect(next.b).toBeCloseTo(0.5, 12);
  });

  it("is identity when the domain did not move", () => {
    expect(rebase({ a: 0.25, b: 0.75 }, 0, HOUR, 0, HOUR)).toEqual({ a: 0.25, b: 0.75 });
  });

  it("clamps a window the new domain can no longer contain", () => {
    // The stream was rewound: the old window sits past the new end.
    const next = rebase({ a: 0.8, b: 1 }, 0, 4 * HOUR, 0, HOUR);
    expect(next.b).toBeLessThanOrEqual(1);
    expect(next.a).toBeGreaterThanOrEqual(0);
    expect(next.a).toBeLessThan(next.b);
  });

  it("stays calm on a degenerate domain", () => {
    for (const w of [
      rebase({ a: 0.2, b: 0.8 }, 0, 0, 0, HOUR),
      rebase({ a: 0.2, b: 0.8 }, 0, HOUR, 5, 5),
      rebase({ a: 0.2, b: 0.8 }, NaN, HOUR, 0, HOUR),
    ]) {
      expect(Number.isFinite(w.a)).toBe(true);
      expect(Number.isFinite(w.b)).toBe(true);
      expect(w.a).toBeLessThan(w.b);
    }
  });
});

// "The whole" is a claim about the WINDOW, and the view had two ways of asking
// it: the predicate below, and whether its state slot happened to have been
// written. The two disagree the moment a gesture lands on the whole by arriving
// there, which the fit button does on every press.
describe("isWhole", () => {
  it("is true of the whole and false of anything narrower", () => {
    expect(isWhole(fit())).toBe(true);
    expect(isWhole({ a: 0, b: 0.999 })).toBe(false);
    expect(isWhole({ a: 0.001, b: 1 })).toBe(false);
    expect(isWhole({ a: 0.4, b: 0.6 })).toBe(false);
  });

  it("absorbs the residue normalize leaves behind, so it cannot be true a hair off", () => {
    // normalize rebuilds b as a + w, so a window that walked back to the whole
    // measures a hair wide. A predicate that called that "not the whole" would
    // leave the reader in a view that says it is showing everything and offers
    // a button to show everything.
    expect(isWhole(normalize(0, 1 + 1e-15, 0))).toBe(true);
    expect(isWhole({ a: 1e-12, b: 1 - 1e-12 })).toBe(true);
  });
});

// The one place a gesture's result becomes stored state. A window that IS the
// whole has to be stored as the sentinel: on a live stream the whole keeps
// moving, and a stored pair of fractions freezes it at the instant of the press.
describe("storeWindow", () => {
  it("stores the whole as null, which is how this view says follow the live edge", () => {
    expect(storeWindow(fit())).toBeNull();
    expect(storeWindow({ a: 0, b: 1 })).toBeNull();
  });

  it("stores anything narrower unchanged, to the exact numbers", () => {
    const win = { a: 0.375, b: 0.625 };
    expect(storeWindow(win)).toEqual(win);
    expect(storeWindow({ a: 0, b: 0.5 })).toEqual({ a: 0, b: 0.5 });
  });
});
