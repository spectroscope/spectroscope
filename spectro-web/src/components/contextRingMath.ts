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
//
// CARD 377 SPLIT THE QUESTION IN TWO, because one function was answering both.
// `contextDenominator` answers WHERE THIS RUN COMPACTS, and its tier order is
// unchanged; the lab's note and `namedWindow` still read its `of`. What a
// surface DIVIDES by is `contextGauge` below, and the two differ on exactly the
// runs the owner reported twice: a threshold the harness derived from a window
// is 70 % of that window, so dividing by it printed 82 % on a run with 107,368
// tokens of the loaded window still free. The window is the size the operator
// is paying for; the compaction point is the harness's own housekeeping, and it
// becomes a mark on the ring instead of the scale of it.
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
   *  instance to overrun. `set`: the operator set it for this session from
   *  the ring (card 390). `unstated`: a window is known but this frame does
   *  not say which it is, which is the shape of an operator's own threshold
   *  and of any provenance this reader has never heard of. */
  of: "loaded" | "published" | "set" | "unstated";
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
 *
 * SINCE CARD 377 THE SECOND CASE IS THE COMMON ONE. A `window` or `model` frame
 * (and since card 390 a `window_override` one) puts the window IN the headline,
 * so this caption is left with the frames that keep a compaction point as their
 * headline: an operator's own threshold, and any provenance this reader has
 * never heard of. Both answer `unstated`, so the `loaded`, `published` and `set`
 * arms are unreachable from the popover's caption; they are still live through
 * {@link windowProvenance}, which is the one place those words are chosen, and
 * which the headline reads as well.
 */
export function namedWindow(
  contextWindow: number | undefined,
  source: string | undefined,
  denominator: ContextDenominator,
): NamedWindow | null {
  if (contextWindow === undefined || contextWindow <= 0) return null;
  if (denominator.of !== "compaction") return null;
  return { tokens: contextWindow, of: windowProvenance(source) };
}

/**
 * What a frame's `thresholdSource` says about where its window came from.
 *
 * The one place `loaded` and `published` are chosen, read by the caption above
 * and by the headline below, so the two surfaces cannot call one window by two
 * names. Anything this reader does not recognise is `unstated`: the Java enum
 * may grow a fifth source, and an unknown word must never silently read as a
 * measurement of a running server.
 */
export function windowProvenance(source: string | undefined): NamedWindow["of"] {
  if (source === "window") return "loaded";
  if (source === "model") return "published";
  if (source === "window_override") return "set";
  return "unstated";
}

/** What the gauge divides by, and the compaction point it marks. */
export interface ContextGauge {
  /** The headline denominator: the window when the run states one it derived
   *  its threshold from, the compaction point otherwise. */
  denominator: ContextDenominator;
  /** The compaction threshold, to mark on the ring and state under the line.
   *  Null when the headline IS the compaction point, and null when the run
   *  states a threshold no lower than its window, where a mark at the full
   *  circumference would draw a ring that looks finished on an empty run. */
  compactsAt: number | null;
  /** How the window in the headline was known, or null when the headline does
   *  not name a window. Only the three sources that promote one reach this, so
   *  `unstated` is not among the answers. */
  windowOf: "loaded" | "published" | "set" | null;
}

/**
 * What the gauge divides by.
 *
 * THE RULE IN ONE LINE: a threshold the harness DERIVED from a window is not a
 * size the operator chose, so it is not a scale. `CompactionThreshold.share`
 * takes seven tenths of the window, which makes the printed percentage a fixed
 * 10/7 of the honest one: 143,000 of a 250,368 window read 82 % where it is
 * 57 %. The three sources that carry that derivation are `window` (the backend
 * stated what the LOADED instance serves), `model` (the vendor publishes a
 * ceiling and there is no instance to overrun) and, since card 390,
 * `window_override` (the operator set the window for this session from the
 * ring, and the harness took 70 % of it like any other window).
 *
 * WHAT IS DELIBERATELY LEFT ALONE. Under `override` the number is one the
 * operator typed, so it stays the headline and the window stays a caption; the
 * probe never runs under an override anyway. Under `fallback` there is no
 * window at all. A frame from before card 366 carries none either. All three
 * read exactly as they did, word for word.
 *
 * @param reportedThreshold the run's compaction threshold, when the harness
 *        emitted one; a zero counts as absent
 * @param contextWindow the window the frame stated, or undefined when it stated
 *        none. A zero is not a window
 * @param source the frame's `thresholdSource`
 * @return the denominator, the compaction point to mark, and how the window in
 *         the headline was known
 */
export function contextGauge(
  reportedThreshold: number | undefined,
  contextWindow: number | undefined,
  source: string | undefined,
): ContextGauge {
  const derivedFromWindow = source === "window" || source === "model" || source === "window_override";
  if (derivedFromWindow && contextWindow !== undefined && contextWindow > 0) {
    const of = windowProvenance(source);
    return {
      denominator: { value: contextWindow, of: "window" },
      compactsAt:
        reportedThreshold !== undefined && reportedThreshold > 0 && reportedThreshold < contextWindow
          ? reportedThreshold
          : null,
      // Narrowed rather than asserted: only the three sources above reach here.
      windowOf: of === "unstated" ? null : of,
    };
  }
  return {
    denominator: contextDenominator(reportedThreshold, contextWindow ?? null),
    compactsAt: null,
    windowOf: null,
  };
}
