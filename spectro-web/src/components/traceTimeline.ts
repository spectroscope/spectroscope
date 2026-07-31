// The timeline lens (langfuse P1.3, konzept/LANGFUSE-REVIEW.md): trace events
// are INSTANTS, so the honest Gantt read of a run is where the WAITING
// happened — each row's gap to its predecessor, drawn as a bar. The Δt column
// already carries the number; the lens makes it scannable.

/** Per-row wait fractions for a visible row set's timestamps: gap to the
 *  predecessor, normalized on a LOG scale against the largest gap —
 *  `log1p(dt) / log1p(max)`. Linear normalization let one outlier flatten
 *  everything (an 18 s LLM wait rendered the ~120 ms steps at 0.7% width,
 *  owner report 2026-07-23); log keeps the ordinary waits readable while the
 *  outlier still clearly wins, and the Δt column stays the linear truth.
 *  `null` where no bar exists at all (first row, or a field with no gaps);
 *  `0` for a zero wait inside a field that has gaps. Skewed clocks clamp
 *  to 0. Monotonic: a longer wait never gets a shorter bar. */
export function timelineFractions(ts: number[]): (number | null)[] {
  const gaps = ts.map((t, i) => (i === 0 ? null : Math.max(0, t - ts[i - 1])));
  const max = gaps.reduce<number>((m, g) => (g !== null && g > m ? g : m), 0);
  if (max === 0) return ts.map(() => null);
  const scale = Math.log1p(max);
  return gaps.map((g) => (g === null ? null : Math.log1p(g) / scale));
}
