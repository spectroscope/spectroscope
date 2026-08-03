// The overview strip's data: what the WHOLE axis looks like, so a reader who is
// two hundred times deep can still tell which of the day's episodes they are in.
//
// It is a count of discrete things, so it is BARS. Not a waveform (that implies
// a continuous quantity) and not a filmstrip (that implies continuous media).
// The picture that falls out is the one that makes a four day transcript
// legible: a couple of hundred occupied columns against eight hundred empty
// ones reads as the rhythm of four working days.

import { sliceLane } from "./laneSlice";
import type { LaneTick, TickKind } from "./spectrumModel";
import { fit } from "./viewport";

export interface DensityColumn {
  count: number;
  /** The kind that gets to colour this column, or null when it is empty. */
  kind: TickKind | null;
  /** A gate or an error landed here: the strip draws it full height as a marker
   *  track rather than letting it average into a bar. */
  marker: boolean;
}

/** Bin every mark by column. Takes no window: the strip is the WHOLE, always,
 *  which is what makes it an orientation surface rather than a second band. */
export function densityProfile(ticks: readonly LaneTick[], cols: number): DensityColumn[] {
  const n = Math.floor(Number.isFinite(cols) ? cols : 0);
  if (n <= 0) return [];
  const counts: DensityColumn[] = Array.from({ length: n }, () => ({
    count: 0,
    kind: null,
    marker: false,
  }));
  // Per column, a tally per kind. Sparse on purpose: most columns are empty.
  const tally = new Map<number, Map<TickKind, number>>();
  for (const t of ticks) {
    const raw = Math.floor((Number.isFinite(t.x) ? t.x : 0) * n);
    // A mark at exactly 1 belongs in the LAST column, not one past the end.
    const col = raw < 0 ? 0 : raw > n - 1 ? n - 1 : raw;
    counts[col].count++;
    if (t.kind === "gate" || t.kind === "error") counts[col].marker = true;
    let byKind = tally.get(col);
    if (byKind === undefined) {
      byKind = new Map();
      tally.set(col, byKind);
    }
    byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  }
  for (const [col, byKind] of tally) {
    counts[col].kind = dominant(byKind);
  }
  return counts;
}

/** Which kind speaks for a column.
 *
 *  An error outranks a gate outranks everything else, however badly outnumbered:
 *  one denied write inside a thousand token deltas is the thing a reader is
 *  scanning for, and it must not be averaged away by the flood around it.
 *  Below those two, the most frequent kind wins. */
function dominant(byKind: Map<TickKind, number>): TickKind {
  if (byKind.has("error")) return "error";
  if (byKind.has("gate")) return "gate";
  let best: TickKind = "token";
  let bestN = -1;
  for (const [kind, n] of byKind) {
    if (n > bestN) {
      bestN = n;
      best = kind;
    }
  }
  return best;
}

/** A column's bar height, log scaled.
 *
 *  On a real four day transcript one column holds a single event and another
 *  holds 3843. Linear heights would draw four working days as a flat line beside
 *  one spike. The log scale is the same answer the timeline lens already gives
 *  for waits, and the small floor keeps a lone event from rounding away. */
export function barHeight(count: number, max: number, h: number): number {
  if (!(count > 0) || !(h > 0)) return 0;
  const top = Number.isFinite(max) && max > count ? max : count;
  const floor = Math.min(h, 2);
  return floor + (h - floor) * (Math.log1p(count) / Math.log1p(top));
}

/** Does this stream need a viewport at all?
 *
 *  Deliberately takes NO window. Asked of the current window, the answer would
 *  flip to false the moment a reader zoomed into a sparse minute, the strip
 *  would vanish, and they would be stranded two hundred times deep with no
 *  orientation surface and no way back. It is a question about the whole.
 *
 *  The threshold is HALF: a lane that cannot draw half of what it carries is a
 *  lane that cannot be read at full extent. "Did any two marks collide" was the
 *  obvious rule and it is far too sensitive to be one, because two marks land in
 *  one pixel column the moment a run emits them a millisecond apart. Measured
 *  over the 147 sessions of one real store on 2026-08-03 at 900 px: the
 *  collision rule fires on 55 of them, including a three event run that lasted
 *  under four seconds. Half fires on 9, and the two longest sessions in the
 *  store are among the nine. That is the difference between a surface that
 *  appears when a reader is lost and one that is always on. */
export function needsViewport(lanes: readonly { ticks: readonly LaneTick[] }[], widthPx: number): boolean {
  const whole = fit();
  return lanes.some((l) => {
    const { marks, hidden } = sliceLane(l.ticks, whole, widthPx);
    // `hidden > 0` first: an empty lane hides nothing and draws nothing, and
    // "nothing is at least nothing" would hand a viewport to a blank screen.
    return hidden > 0 && hidden >= marks.length;
  });
}
