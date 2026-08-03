// The band's pointer and keyboard arithmetic, kept out of the component.
//
// One rule holds this file together: THE BAND DRAWS A SLICE AND SCRUBS THE
// WHOLE LANE. Since marks are deduped per pixel column, a busy lane can put 826
// events into 39 rects, and if the hit test ran over the rects then 787 events
// would have no hover, no preview and no way into the trace. Nothing about the
// picture getting denser should make an event unreachable, so the drawn array
// answers "what is on screen" and the tick array answers "what can be reached".
//
// Everything here returns a SEQ rather than an array index. Indices are not
// stable across a live re-fold; a seq is the event's place in the stream.

import type { LaneTick } from "./spectrumModel";

/** The index of the tick whose x-fraction is closest to `frac` (0..1), or null
 *  when there are none. Ties resolve to the earlier tick (strict `<`). */
export function nearestTick(ticks: readonly { x: number }[], frac: number): number | null {
  if (ticks.length === 0) {
    return null;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const dist = Math.abs(ticks[i].x - frac);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** The seq the scrubber lands on for a pointer at `frac` across the band.
 *
 *  The band no longer calls this. Once there is a window over the axis, a hit
 *  test that scans the WHOLE lane can return a mark that is off screen, so
 *  pointing goes through `seqAt` in bandGeometry, which is bounded by the
 *  window. This survives as the unwindowed reference that the geometry is
 *  pinned against at full extent: the two must agree when the window is the
 *  whole, and that agreement is what says zoom did not move anything. */
export function seqAtFrac(ticks: readonly LaneTick[], frac: number): number | null {
  const i = nearestTick(ticks, frac);
  return i === null ? null : (ticks[i]?.seq ?? null);
}

/** One arrow press: the neighbouring event's seq, walking every tick.
 *
 *  Ends stop rather than wrap, because a reader who has arrived at the last
 *  event should be told so by the scrub not moving, not by being returned to the
 *  beginning without a word. A `fromSeq` that is no longer in the lane (a live
 *  re-fold dropped it) re-enters from the appropriate end. */
export function stepSeq(ticks: readonly LaneTick[], fromSeq: number | null, dir: 1 | -1): number | null {
  if (ticks.length === 0) {
    return null;
  }
  const current = fromSeq === null ? -1 : ticks.findIndex((t) => t.seq === fromSeq);
  const from = current < 0 ? (dir > 0 ? -1 : ticks.length) : current;
  const next = Math.min(ticks.length - 1, Math.max(0, from + dir));
  return ticks[next].seq;
}
