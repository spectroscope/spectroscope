// The timeline lens (langfuse P1.3, konzept/LANGFUSE-REVIEW.md): trace events
// are INSTANTS, so the honest Gantt read of a run is where the WAITING
// happened — each row's gap to its predecessor, drawn as a proportional bar.
// The Δt column already carries the number; the lens makes it scannable.

/** Per-row wait fractions for a visible row set's timestamps: gap to the
 *  predecessor, normalized linearly against the largest gap. `null` where no
 *  bar exists at all (first row, or a field with no gaps); `0` for a row whose
 *  wait was zero inside a field that has gaps. Skewed clocks clamp to 0. */
export function timelineFractions(ts: number[]): (number | null)[] {
  const gaps = ts.map((t, i) => (i === 0 ? null : Math.max(0, t - ts[i - 1])));
  const max = gaps.reduce<number>((m, g) => (g !== null && g > m ? g : m), 0);
  if (max === 0) return ts.map(() => null);
  return gaps.map((g) => (g === null ? null : g / max));
}
