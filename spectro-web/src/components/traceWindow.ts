// Which trace rows are worth building (card 117).
//
// Card 116 refused to cap the trace, and it was right: a trace is evidence, and
// an incident transcript that silently begins in the middle loses the part that
// says how the incident started. So the record stays whole and only the BUILD
// gets bounded — the reader still scrolls the entire thing, the scrollbar still
// measures the entire thing, and nothing is dropped.
//
// The arithmetic is exact rather than estimated, because of one fact about this
// list: `openSeq` is a single value, so at most ONE row is ever taller than the
// others. Every offset is therefore `i * rowH` plus the excess of that single
// row when it sits above `i` — no per-row measurement cache, no drift, no
// scrollbar that grows as you scroll.

/** Everything the window needs, all of it measured by the caller. */
export interface TraceWindowInput {
  /** The scroller's scrollTop, already relative to the first row. */
  scrollTop: number;
  /** The scroller's visible height. 0 means "not laid out yet". */
  viewportH: number;
  /** How many rows the current filter leaves. */
  count: number;
  /** One collapsed row's height. 0 means "not measured yet". */
  rowH: number;
  /** The expanded row's index in the CURRENT filtered list, or -1 for none. */
  openIndex: number;
  /** The expanded row's measured height — only read when openIndex is in range. */
  openH: number;
  /** Rows of margin built beyond each edge, so a scroll does not show a gap. */
  overscan: number;
}

/** The slice to build, and the two spacers that stand in for the rest. */
export interface TraceWindowSlice {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Where row {@code index} starts, in pixels from the first row.
 *
 * The stepper and the search walk need this. Before this card they found their
 * target with {@code querySelector('[data-seq=…]')} and let the browser scroll
 * to it — which stops working the moment the target might not be built. A
 * windowed list that breaks the stepper has traded one complaint for another,
 * so the position is computed instead of looked up, and the DOM is only asked
 * for focus once the row exists.
 *
 * @param index the row's index in the current filtered list
 * @param rowH one collapsed row's height
 * @param openIndex the expanded row's index, or -1
 * @param openH the expanded row's height
 */
export function traceRowOffset(index: number, rowH: number, openIndex: number, openH: number): number {
  const excess = openIndex >= 0 ? Math.max(openH - rowH, 0) : 0;
  return index * rowH + (openIndex >= 0 && index > openIndex ? excess : 0);
}

/**
 * The rows worth building for this scroll position.
 *
 * An UNMEASURED view (viewportH or rowH at 0) renders the list whole. That is
 * not a fallback bolted on for tests — it is the correct first frame, since the
 * row height can only be measured from a row that exists, and it keeps the
 * pre-card-117 behaviour intact anywhere layout never happens.
 */
export function traceWindow(input: TraceWindowInput): TraceWindowSlice {
  const { viewportH, count, rowH, overscan } = input;
  if (count <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  if (viewportH <= 0 || rowH <= 0) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 };
  }

  // A stale open index — the filter can hide the open row while openSeq lives
  // on — must bend nothing. Out of range simply means "no tall row".
  const openIndex = input.openIndex >= 0 && input.openIndex < count ? input.openIndex : -1;
  const openH = openIndex >= 0 ? Math.max(input.openH, rowH) : rowH;
  const excess = openIndex >= 0 ? openH - rowH : 0;
  const total = count * rowH + excess;

  /** Where row `i` starts, counting the one tall row when it sits above it. */
  const offsetOf = (i: number): number => i * rowH + (openIndex >= 0 && i > openIndex ? excess : 0);

  /** Which row covers pixel `y` — the inverse of offsetOf, in closed form. */
  const indexAt = (y: number): number => {
    if (y <= 0) return 0;
    if (openIndex < 0) return Math.floor(y / rowH);
    const openTop = openIndex * rowH;
    if (y < openTop) return Math.floor(y / rowH);
    if (y < openTop + openH) return openIndex;
    return openIndex + 1 + Math.floor((y - openTop - openH) / rowH);
  };

  const clamp = (i: number): number => Math.min(Math.max(i, 0), count);

  // A scrollTop past the end (one frame after a filter shortens the list) must
  // still render something — a blank flash reads as data loss.
  const top = Math.min(Math.max(input.scrollTop, 0), Math.max(total - viewportH, 0));
  const start = clamp(indexAt(top) - overscan);
  // The LAST VISIBLE pixel, not the first invisible one: with a 600px viewport
  // over 20px rows, pixel 600 is the first pixel of row 30 and row 30 is not on
  // screen. Reading the boundary pixel builds one row too many at every scroll
  // position — harmless-looking, and wrong about what "visible" means.
  const end = clamp(indexAt(top + viewportH - 1) + 1 + overscan);

  return {
    start,
    end,
    padTop: offsetOf(start),
    padBottom: total - offsetOf(end),
  };
}
