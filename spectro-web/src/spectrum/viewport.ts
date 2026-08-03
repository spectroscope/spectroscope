// The viewport over a shared time axis: which slice of the domain is on screen.
//
// A window is a PAIR of fractions, not an (offset, scale). The spectrum model
// already emits every mark as a 0..1 fraction of the span, so there is nothing
// to convert; and clamping two coupled quantities is exactly where the classic
// inversion bug lives, so every mutation funnels through one `normalize`.
//
// Pure arithmetic on numbers. This module imports NOTHING: not the spectrum
// model, not React, not the DOM. Any other time-axis surface (the trace
// timeline is the obvious next one) can adopt it without a detangle.
//
// There is deliberately no playhead here. The band already carries a cursor in
// its hovered event; a second one would be a duplicate concept, and clamping it
// would silently move the reader's selection. `zoomAt` takes its anchor as a
// parameter and the caller decides what to point at.

/** A slice of the domain, as fractions of the whole span. Always 0 <= a < b <= 1. */
export interface Window {
  a: number;
  b: number;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The whole domain. */
export function fit(): Window {
  return { a: 0, b: 1 };
}

/** The rounding residue a window carries after a few zooms.
 *
 *  `normalize` reconstructs `b` as `a + w`, so a window that has walked back to
 *  the whole measures a hair wide. Every comparison against the domain edges has
 *  to absorb that, or the view sits a rounding error away from the whole and
 *  says so on screen while offering a button that does nothing. */
export const WINDOW_EPS = 1e-9;

/** Is this window the whole domain?
 *
 *  One predicate for the question the view asks in three places: whether to
 *  offer a way back, whether to report a slice, and whether there is anything to
 *  store at all. Asking it three ways is how a readout and a button come to
 *  disagree about where "everything" ends. */
export function isWhole(win: Window): boolean {
  return win.a <= WINDOW_EPS && win.b >= 1 - WINDOW_EPS;
}

/** What a gesture's result becomes once it is STORED.
 *
 *  The whole is stored as null, and that is not tidying up. A live stream keeps
 *  moving t1, so a stored pair of fractions freezes the view at the instant of
 *  the press: `rebase` below then carries those fractions onto the new span, and
 *  the window that meant "everything" quietly becomes "everything up to the
 *  press", with every later event off the right edge. Null needs no rewriting
 *  and cannot drift, so every gesture that lands on the whole comes back here. */
export function storeWindow(win: Window): Window | null {
  return isWhole(win) ? null : win;
}

/** The one gate every window passes through.
 *
 *  It shifts as a RIGID BODY. Clamping `a` and `b` independently would change
 *  the zoom level as a side effect of panning, which reads as the app fighting
 *  the reader. Only a request genuinely wider than the domain collapses; a
 *  request narrower than `minW` widens around its own midpoint. */
export function normalize(a: number, b: number, minW: number): Window {
  let lo = finite(a, 0);
  let hi = finite(b, 1);
  if (hi < lo) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  const floor = clamp01(finite(minW, 0));
  let w = hi - lo;
  // Nothing to fix: hand back the exact numbers that came in, so a pan of a
  // legal window carries no rounding residue.
  if (w >= floor && w <= 1 && lo >= 0 && hi <= 1) return { a: lo, b: hi };
  if (w > 1 || w < floor) {
    w = Math.min(1, Math.max(floor, w));
    const mid = (lo + hi) / 2;
    lo = mid - w / 2;
  }
  if (lo < 0) lo = 0;
  else if (lo + w > 1) lo = 1 - w;
  return { a: lo, b: lo + w };
}

/** Zoom around a DOMAIN anchor (a 0..1 fraction of the span, not a pixel).
 *
 *  `factor` multiplies the window WIDTH: below 1 narrows (zooms in), above 1
 *  widens. Pointing is a deictic act, so the caller passes what the reader is
 *  pointing at and it stays put under the cursor. At the domain edge it cannot:
 *  there the window wins and the anchor moves, because a window that left the
 *  domain would be showing time that does not exist. */
export function zoomAt(win: Window, anchor: number, factor: number, minW: number): Window {
  const f = finite(factor, 1);
  if (f <= 0) return normalize(win.a, win.b, minW);
  const w = win.b - win.a;
  if (!(w > 0)) return normalize(win.a, win.b, minW);
  const u = clamp01(finite(anchor, (win.a + win.b) / 2));
  const floor = clamp01(finite(minW, 0));
  const next = Math.min(1, Math.max(floor, w * f));
  const a = u - (u - win.a) * (next / w);
  return normalize(a, a + next, minW);
}

/** Slide the window by `delta` span-fractions. Width is preserved. */
export function panBy(win: Window, delta: number, minW: number): Window {
  const d = finite(delta, 0);
  return normalize(win.a + d, win.b + d, minW);
}

/** Where a domain fraction lands, in pixels, inside a viewport `widthPx` wide. */
export function toScreen(x: number, win: Window, widthPx: number): number {
  const w = win.b - win.a;
  if (!(w > 0)) return 0;
  return ((x - win.a) / w) * widthPx;
}

/** The inverse. Null (never NaN) when the viewport has no width yet, which is
 *  the state of every element on its first paint. */
export function fromScreen(px: number, win: Window, widthPx: number): number | null {
  if (!(widthPx > 0)) return null;
  return win.a + (px / widthPx) * (win.b - win.a);
}

/** The zoom floor, as a fraction, for a stream spanning `spanMs`.
 *
 *  A FIXED minimum duration, never derived from what happens to be on screen.
 *  A content-derived floor would move under the reader's hand as they panned
 *  between a dense minute and an empty hour, which reads as the app breaking.
 *  A stream shorter than the floor gets 1, so zoom is a no-op by construction
 *  rather than by a special case somewhere upstream. */
export function minWidthFor(spanMs: number, floorMs: number): number {
  const span = finite(spanMs, 0);
  const floor = finite(floorMs, 0);
  if (!(span > 0) || !(floor > 0)) return 1;
  return Math.min(1, floor / span);
}

/** Carry a window across a change of domain, holding the same ABSOLUTE instants.
 *
 *  A window is a pair of fractions OF THE SPAN, so an arriving event that
 *  extends t1 renormalizes every mark and would silently drag a zoomed reader
 *  off the thing they were looking at. This converts out to instants and back.
 *
 *  Note what it does NOT do: rebasing the whole domain does not give the whole
 *  domain back, because the old whole is not the new whole. "Follow the live
 *  edge" is therefore a NULL window at the call site, never a pair of fractions
 *  that a growing span keeps having to rewrite. */
export function rebase(win: Window, oldT0: number, oldT1: number, newT0: number, newT1: number): Window {
  const o0 = finite(oldT0, 0);
  const o1 = finite(oldT1, 0);
  const n0 = finite(newT0, 0);
  const n1 = finite(newT1, 0);
  const oldSpan = o1 - o0;
  const newSpan = n1 - n0;
  if (!(oldSpan > 0) || !(newSpan > 0)) return normalize(win.a, win.b, 0);
  const at = (f: number): number => (o0 + f * oldSpan - n0) / newSpan;
  const a = at(win.a);
  const b = at(win.b);
  // The floor is the rebased width itself: a domain that merely grew must not
  // widen the window as a side effect of passing through normalize.
  return normalize(a, b, Math.min(1, Math.max(0, b - a)));
}
