// Where the band draws a mark, and which mark a pointer is asking for, once
// there is a window over the axis.
//
// This is the arithmetic that a window makes newly wrong, so it lives here where
// it can be pinned rather than in the .tsx where nothing can reach it. Drawing
// and hit-testing invert the SAME mapping, pad included: computing one of them
// with the pad and the other without is a 4px lie that only shows up as a scrub
// line sitting a hair off its own mark.
//
// Pure. No DOM, no React.

import type { LaneTick } from "./spectrumModel";
import { visibleRange } from "./laneSlice";
import { fromScreen, toScreen, type Window } from "./viewport";

/** A pointer offset inside the band element, in the band's own drawing units.
 *
 *  The svg stretches a fixed `width`-unit viewBox across whatever the lane grid
 *  gave it, so a pointer measured in layout pixels is in the wrong space until
 *  it comes through here. One conversion, at the edge, and every function below
 *  it works in one coordinate system. Null when the element has no width yet. */
export function viewBoxX(offsetPx: number, rectWidth: number, width: number): number | null {
  if (!(rectWidth > 0)) return null;
  return (offsetPx / rectWidth) * width;
}

/** The band's DRAWABLE width in LAYOUT pixels: what a screen-space gesture is
 *  measured against.
 *
 *  The band has two widths and they are not interchangeable. Marks and pointers
 *  convert into the viewBox units above, because that is where drawing happens.
 *  A wheel reports its deltas in layout pixels and they stay there, because a
 *  gesture compares its own two deltas against each other: scale one of them and
 *  the axis a swipe belongs to becomes a function of how wide the browser window
 *  is. Zero, never NaN, for a band that has not been measured. */
export function innerWidthPx(rectWidth: number, width: number, pad: number): number {
  if (!(rectWidth > 0) || !(width > 0)) return 0;
  return (rectWidth * Math.max(0, width - 2 * pad)) / width;
}

/** A mark's centre, in the same coordinate space as `width`.
 *
 *  A mark outside the window comes back outside `[pad, width - pad]`, on purpose.
 *  Clamping would pile every earlier event onto the left pad and draw a wall of
 *  marks at an instant none of them happened at; letting them fall outside means
 *  the svg simply does not paint them. */
export function markX(x: number, win: Window, width: number, pad: number): number {
  const inner = Math.max(0, width - 2 * pad);
  return pad + toScreen(x, win, inner);
}

/** The domain fraction under a pointer, clamped to the window.
 *
 *  Clamped rather than free because the pointer can sit on the pad, and time
 *  outside the window is not on screen to be asked about. Null (never NaN) when
 *  the band has not been measured, which is the state of every element on its
 *  first paint. */
export function fracAt(px: number, width: number, pad: number, win: Window): number | null {
  const inner = width - 2 * pad;
  if (!(inner > 0)) return null;
  const raw = fromScreen(px - pad, win, inner);
  if (raw === null) return null;
  return Math.min(win.b, Math.max(win.a, raw));
}

/** The seq the scrubber lands on: the nearest mark THE WINDOW SHOWS.
 *
 *  Restricted to the visible range, and that restriction is the whole point.
 *  Scanning the lane is right at full extent and wrong the moment there is a
 *  window: zoom into a burst and the event just before the left edge is nearer
 *  to a pointer at that edge than anything inside the window is. The band would
 *  then preview an event with no rect on screen and stand its scrub line where
 *  nothing was drawn.
 *
 *  Null when the window is over empty axis. Nothing is drawn there, so there is
 *  nothing to point at, and naming a distant event would be an invention.
 *
 *  Note this narrows only what a POINTER can reach, never what the lane can
 *  reach: the keyboard walk in bandScrub still steps every tick, and marks stay
 *  reachable by zooming to them. Thinning the ink still costs nobody an event. */
export function seqAt(
  ticks: readonly LaneTick[],
  px: number,
  width: number,
  pad: number,
  win: Window,
): number | null {
  const frac = fracAt(px, width, pad, win);
  if (frac === null) return null;
  const [lo, hi] = visibleRange(ticks, win);
  let best: number | null = null;
  let bestDist = Infinity;
  for (let i = lo; i < hi; i++) {
    const dist = Math.abs(ticks[i].x - frac);
    // Strict, so a tie resolves to the earlier mark, the same way the keyboard
    // walk and the column rule in sliceLane already resolve one.
    if (dist < bestDist) {
      bestDist = dist;
      best = ticks[i].seq;
    }
  }
  return best;
}
