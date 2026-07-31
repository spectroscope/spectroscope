// What the context gauge measures against, and what to call it.
//
// Three sources, in order of how much they actually know:
//   1. the compaction threshold the harness reported for THIS run
//   2. the model's own context window
//   3. a constant, only when neither is known
//
// The bug this exists to prevent: skipping straight from 1 to 3 read 859k
// against a hardcoded 100k and printed 859%, three lines above the gauge's own
// caption saying the window is 1M. A gauge that contradicts its caption is
// worse than no gauge.

/** Only reached for a model whose window is unknown and a run that reported no
 *  threshold — a local or custom backend. */
export const FALLBACK_THRESHOLD = 100_000;

export interface ContextDenominator {
  value: number;
  /** Which source it came from, so the caption can say what was measured. */
  of: "compaction" | "window" | "fallback";
}

/**
 * The denominator for the context gauge.
 *
 * @param reportedThreshold the run's compaction threshold, when the harness
 *        emitted one; a zero counts as absent, since dividing by it says
 *        nothing
 * @param modelWindow the model's real context window, or null when the model
 *        is not one we have a documented figure for
 * @return the number to divide by, and where it came from
 */
export function contextDenominator(
  reportedThreshold: number | undefined,
  modelWindow: number | null,
): ContextDenominator {
  if (reportedThreshold !== undefined && reportedThreshold > 0) {
    return { value: reportedThreshold, of: "compaction" };
  }
  if (modelWindow !== null && modelWindow > 0) {
    return { value: modelWindow, of: "window" };
  }
  return { value: FALLBACK_THRESHOLD, of: "fallback" };
}
