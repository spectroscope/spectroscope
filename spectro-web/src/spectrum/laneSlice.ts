// What a lane puts on screen for a given window and a given pixel width.
//
// The old rule counted array entries and never looked at where the marks sat,
// so two marks 4 ms apart and two marks 4 hours apart were treated the same.
// This one is density-aware: ONE MARK PER PIXEL COLUMN AND KIND. It follows
// that narrowing the window strictly reveals more (fewer marks share a column),
// which is the property the whole zoom feature rests on, and that the dense
// channels are deduped rather than deleted wholesale, so reasoning comes back
// to a band whose legend has been promising it all along.
//
// Pure. Ticks must arrive sorted by x, which is what the model now guarantees.

import type { LaneTick } from "./spectrumModel";
import { normalize, type Window } from "./viewport";

/** First index with x >= value. */
function lowerBound(ticks: readonly LaneTick[], value: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].x < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with x > value. */
function upperBound(ticks: readonly LaneTick[], value: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].x <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The half-open index span of marks inside the window, both edges inclusive of
 *  a mark sitting exactly on them. Two binary searches, no scan. */
export function visibleRange(ticks: readonly LaneTick[], win: Window): [number, number] {
  if (ticks.length === 0) return [0, 0];
  return [lowerBound(ticks, win.a), upperBound(ticks, win.b)];
}

/** The marks this window can actually distinguish, and how many it cannot.
 *
 *  `hidden` counts VISIBLE minus kept, never total minus kept. Zoom into a
 *  sparse minute and it falls to zero and the sentence under the band stops
 *  rendering; zoom into a pile of tied timestamps and it stays put forever,
 *  which is the truth: those events cannot be separated on a time axis at any
 *  magnification. Either way the number degrades into truth, not into a lie. */
export function sliceLane(
  ticks: readonly LaneTick[],
  win: Window,
  widthPx: number,
): { marks: LaneTick[]; hidden: number } {
  const [lo, hi] = visibleRange(ticks, win);
  const visible = hi - lo;
  if (visible === 0) return { marks: [], hidden: 0 };
  const columns = Math.max(1, Math.floor(Number.isFinite(widthPx) ? widthPx : 1));
  const span = win.b - win.a;
  const seen = new Set<string>();
  const marks: LaneTick[] = [];
  for (let i = lo; i < hi; i++) {
    const t = ticks[i];
    const raw = span > 0 ? Math.floor(((t.x - win.a) / span) * columns) : 0;
    const col = raw < 0 ? 0 : raw > columns - 1 ? columns - 1 : raw;
    const key = `${col}|${t.kind}`;
    if (seen.has(key)) continue;
    // First in time wins the column, so the kept mark is deterministic and, for
    // a gate, is the REQUEST rather than a decision that landed in the same
    // pixel. Order stays chronological: the band renders marks as they came.
    seen.add(key);
    marks.push(t);
  }
  return { marks, hidden: visible - marks.length };
}

/** Page forward: one window width, and if that lands on empty axis, snap so the
 *  next mark sits at the left edge.
 *
 *  Two rules and no magic constant. Counting "bursts" would need a gap
 *  threshold, and that number is not a property of the data: on a real four-day
 *  transcript, moving it from one minute to thirty swings the burst count by 8x
 *  and the zoom target by 13x. This navigates the marks themselves instead. */
export function pageNext(ticks: readonly LaneTick[], win: Window): Window {
  const w = win.b - win.a;
  const candidate = normalize(win.a + w, win.b + w, w);
  const [lo, hi] = visibleRange(ticks, candidate);
  if (hi > lo) return candidate;
  const next = upperBound(ticks, win.b);
  if (next >= ticks.length) return win;
  return normalize(ticks[next].x, ticks[next].x + w, w);
}

/** The mirror. One window back, and if that is empty axis, snap so the previous
 *  mark sits at the RIGHT edge: going back you want to land where the earlier
 *  work ENDED, and read forward from there. */
export function pagePrev(ticks: readonly LaneTick[], win: Window): Window {
  const w = win.b - win.a;
  // The last mark strictly before the window: what "back" is even about.
  const prev = lowerBound(ticks, win.a) - 1;
  if (prev < 0) return win;
  const candidate = normalize(win.a - w, win.b - w, w);
  if (ticks[prev].x >= candidate.a) return candidate;
  return normalize(ticks[prev].x - w, ticks[prev].x, w);
}
