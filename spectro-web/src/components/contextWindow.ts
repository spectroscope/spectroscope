// How to PRINT a context window. The knowledge of how big one is used to live
// here too, as a hand-typed vendor prefix table, and card 366 moved it into
// Java beside the code that derives the compaction threshold from it
// (spectro-core .../session/ModelWindows.java).
//
// WHY IT LEFT. Two copies of one table is the defect card 312 found three times
// in a single card, and these two were not even equal partners: the Java side
// MEASURES the loaded window and derives the threshold from it, while this copy
// could only colour a gauge. Worse, it returned null for every local model, so
// the gauge's window line never rendered on the backends this house tests with
// — two months of a denominator with no stated origin, under a gauge whose own
// header says a gauge that contradicts its caption is worse than no gauge. The
// window now rides on `context_info` (RunEvent.ContextInfo.contextWindow) with
// the harness's own provenance beside it, and every surface reads it from
// there.

/**
 * Compact window label: 128000 -> "128k", 1000000 -> "1M", 1048576 -> "1M".
 *
 * The millions are rounded to one decimal BECAUSE of card 366: the figures
 * reaching this function used to be published round numbers from a table, and
 * are now measured ones off a running server. `${tokens / 1_000_000}M` printed
 * the owner's own ceiling as "1.048576M".
 */
export function formatWindow(tokens: number): string {
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}
