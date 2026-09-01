// What the context gauge measures against, and what to call it.
//
// Three sources, in order of how much they actually know:
//   1. the compaction threshold the harness reported for THIS run
//   2. the model's own context window
//   3. a constant, only when neither is known
//
// Card 366 changed where 2 comes from: the harness reports the window on the
// same frame as the threshold (context_info.contextWindow), so the caller hands
// in a MEASURED figure instead of a prefix guess from a table of the web's own.
// Since both ride one frame, tier 1 is what decides in the app today; tier 2 is
// the answer for a frame that states a window without a threshold, and is
// exercised here.
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

/** The window a gauge may name under its denominator, and how sure it is of
 *  where that window came from. */
export interface NamedWindow {
  tokens: number;
  /** `loaded` — the backend stated what the instance serving the next request
   *  holds. `published` — the model's vendor states the window and there is no
   *  instance to overrun. `unstated` — a window is known but this frame does
   *  not say which of the two it is, which is the shape of an operator's own
   *  threshold and of any provenance this reader has never heard of. */
  of: "loaded" | "published" | "unstated";
}

/**
 * The window to print under the gauge, or null when there is none to print.
 *
 * The value and the provenance both come from the run's own `context_info`
 * (card 366). The web used to answer this from a vendor prefix table of its
 * own — a second copy of knowledge the harness had already MEASURED, on the
 * wrong side of the wire, and one that returned null for every local model, so
 * the line never rendered on the backends this house tests with.
 *
 * @param contextWindow the window the frame stated, or undefined when it stated
 *        none. A zero is not a window: the harness drops the key rather than
 *        sending one, and a 0 arriving anyway is not a claim to repeat
 * @param source the frame's `thresholdSource`. Anything this reader does not
 *        recognise is treated exactly like an absent one — the caption may
 *        state the window either way, and may never invent its origin
 * @param denominator what the gauge is dividing by, from `contextDenominator`
 * @return the window to name and how it was known, or null when naming it would
 *         say nothing new (no window) or say it twice (the gauge already
 *         divides by the window itself)
 */
export function namedWindow(
  contextWindow: number | undefined,
  source: string | undefined,
  denominator: ContextDenominator,
): NamedWindow | null {
  if (contextWindow === undefined || contextWindow <= 0) return null;
  if (denominator.of !== "compaction") return null;
  const of = source === "window" ? "loaded" : source === "model" ? "published" : "unstated";
  return { tokens: contextWindow, of };
}
