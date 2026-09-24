// Card 300: how full each agent's context got, and what that number is a share
// OF — the second question being the one this module exists to answer honestly.
//
// THE JOIN, AND WHY NOTHING HERE IS DERIVED TWICE.
//   the peak   — deriveDetail(applied).spend, already cache-aware and already
//                peak-not-last (card 287, pinned by flowmap/agentSpend.test.ts)
//   the handle — agentDirectory (card 298), so a tag means the same agent on
//                every surface that prints one
//   the divisor — contextDenominator (components/contextRingMath.ts), the same
//                function the header ring divides by, so the lab and the ring
//                cannot disagree about one run
//
// THE THREE HONESTY RULES.
//
// 1. A CHILD GETS NO PERCENTAGE. The harness carries a measured threshold for
//    the ROOT only: SubagentConfig builds children without introspection, and
//    they emit no context_info at all (its own javadoc says so, in the sentence
//    that explains why the parent's explicit threshold had to be passed down).
//    A child's model is often on the wire, and reading the published table for
//    it would produce a percentage that looks measured and is not. So a child
//    prints its peak, a bar relative to the biggest peak on the panel, and no
//    percent sign — and the panel says why in one line.
//
// 2. THE RUN'S OWN THRESHOLD BEATS ANY PUBLISHED FIGURE — and since card 366
//    that is structural rather than a rule this module enforces. The window
//    now arrives on the SAME frame as the threshold (context_info carries
//    both), so the threshold is always the tier that wins here. The thing this
//    rule used to fend off is gone: the web's own prefix table, a second copy
//    of knowledge the harness had measured, which had already been wrong once
//    in production — claude-fable-5 fell to the 200k row and the ring read 379%
//    on a healthy session. The table lives in Java now (ModelWindows), where it
//    moves the threshold instead of only colouring a gauge.
//
//    THE COST, SAID OUT LOUD: a transcript recorded before card 366 that
//    carries no context_info at all has no window on it, and no threshold
//    either — so this panel now prints its root's peak with NO percentage,
//    exactly the way a child is printed, and says which in one line.
//
//    THE FIRST CUT OF THIS CARD GOT THAT LAST STEP WRONG, and it is the
//    reason rule 4 below exists: it took the table away and left the DIVISION
//    standing, so the root fell to contextDenominator's third tier — the
//    100,000 stand-in — and a replayed 859k-token run printed 859 % where the
//    same run had read 86 %. A reviewer measured it:
//    contextPeakOf([run_start(model:"claude-opus-4-6"), usage("main", 859_000)])
//    answered {denominator:{value:100000,of:"fallback"}, pct:859}. That is the
//    exact arithmetic contextRingMath's own header names as the bug it exists
//    to prevent.
//
// 3. A THRESHOLD THE HARNESS FELL BACK TO IS NOT A MEASUREMENT — AND IS STILL
//    THE DIVISOR. This is what thresholdSource buys: the number 100000 arrives
//    on the wire whether the harness measured a window or learned nothing at
//    all, and only the provenance separates the two. The provenance therefore
//    decides the WORDS and never the number.
//
//    This rule was first built the other way round — `fallback` dropped, the
//    divisor falling to the model table — and that was measured wrong on the
//    shape every Anthropic run has. AnthropicProvider does not override
//    LlmProvider.contextWindow(), so it answers 0, and CompactionThreshold
//    .derive returns (100_000, FALLBACK); its javadoc names both this case and
//    the OpenAI wire. Dropping it read 8 % of a published 1,000,000 where the
//    header ring read 77 % of the same spend — two surfaces, one run, a factor
//    of ten. The 8 % was the dishonest one twice over: 100,000 is where the run
//    WILL compact, and the 1,000,000 came from the same prefix table that
//    already misread claude-fable-5 as 379 %.
//
//    So the reported threshold is passed to contextDenominator UNCONDITIONALLY,
//    exactly as ContextRing.tsx passes it, and a `fallback` provenance raises
//    the `fellBack` note instead: the run compacts here, and nobody measured
//    it. An absent provenance is NOT `fallback` — a pre-card-263 frame stated
//    nothing, and its threshold is taken at its word the way it always was.
//
// 4. THE CONSTANT STAND-IN IS NOT A DIVISOR ON THIS PANEL. contextDenominator's
//    third tier answers 100,000 when it knows nothing, and the header ring
//    divides by it happily — the ring is a LIVE gauge with a running harness
//    behind it, so "the run reported nothing" there means a provider that emits
//    no context_info, on a session whose next turn may still bring one. This
//    panel replays and imports for a living: every pre-card-263 session and
//    every foreign JSONL reaches it with nothing at all, and there the stand-in
//    is not a weak measurement but a number no part of the run ever claimed.
//    A share of it is a percentage of a fiction, and it renders three digits
//    wide beside a peak that is real.
//
//    So the root falls to the same shape a child already has — `denominator:
//    null`, no pct, no frac, the relative bar, and `lab.ctx.shareNoLimit`. The
//    two surfaces still divide by the same number whenever there IS one, which
//    is the guarantee the shared function was imported for; where there is
//    none they now differ on purpose, and this paragraph is that purpose.
//
// AND THE WHOLE DIVISOR COMES FROM THE RECORDED RUN. The root's model is read
// from the transcript's own run_start, never from what the operator has
// selected in the app right now. The lab replays and imports; a live selection
// is not evidence about a recorded run, and a note naming a model that appears
// nowhere in the events on screen is the worst kind of wrong on a panel whose
// whole job is telling a measurement from a stand-in. So this module takes the
// events and nothing else — there is no fallback-model parameter to hand one
// in through.

import { contextGauge, type ContextDenominator } from "../components/contextRingMath";
import type { AgentDirectory } from "./agentDirectory";
import type { ThresholdSource } from "../wire/thresholdSources";

/** The harness's own CompactionThreshold.Source, as it rides the wire; the one
 *  list is wire/thresholdSources.ts, held to the Java enum (card 390). */
export type { ThresholdSource };

/** One agent's line on the panel. */
export interface ContextPeakRow {
  agentId: string;
  /** The directory's handle: "main", "w1", "w2"… */
  tag: string;
  /** The directory's display name — never the opaque agent id. */
  name: string;
  root: boolean;
  /** The biggest context this agent ever sent, in tokens. */
  peak: number;
  /** How many usage events that peak was taken over. */
  turns: number;
  /** The model this agent's OWN run_start named. Absent = the run never said. */
  model?: string;
  /** What the peak is a share of, and where that came from. Null for every
   *  child (rule 1), and null for a root whose run reported no threshold —
   *  there is no second tier behind it any more (rule 4). */
  denominator: ContextDenominator | null;
  /** The share as whole percent, or null when there is no honest divisor. */
  pct: number | null;
  /** The same share as 0..1, clamped for a bar. Null likewise. */
  frac: number | null;
  /** Share of the LARGEST peak on this panel — always defined, and a share of
   *  a measurement rather than of anything a model promised. This is what a
   *  child's bar draws, and it is why a child still has a length. */
  relFrac: number;
}

/**
 * What the panel has to say out loud. One per fact, never a sentence built
 * here: the words live in i18n and this module only decides which are true.
 *
 * - `measured`          the root's divisor is a threshold the run MEASURED
 * - `fellBack`          it is the threshold the run reported, but the harness
 *                       said it fell back to it — the run compacts there and
 *                       nothing about the backend's window was learned
 * - `published`         the number came from what the model's VENDOR publishes
 *                       rather than from anything the backend measured — the
 *                       harness says so itself now (`thresholdSource: "model"`,
 *                       card 366), which is the shape every cloud run has: no
 *                       loaded instance to ask about, and a window that is a
 *                       fixed property of the model id
 * - `window`            the root divides by a window the frame stated (card
 *                       377) and the source is not `model`; in practice that
 *                       is `thresholdSource: "window"`. Raised in place of
 *                       `measured`, whose sentence names the threshold, which
 *                       is not what the row is a share of.
 * - `modelWindow`       the root divides by a window and the source is
 *                       `model`, the window the vendor publishes. Raised in
 *                       place of `published` for the same reason.
 * - `setWindow`         the root divides by a window and the source is
 *                       `window_override`, the window the operator set for
 *                       the session from the context ring (card 390). Raised
 *                       in place of `window`, whose sentence says the backend
 *                       stated it.
 * - `unknown`           neither — and so there is nothing to divide by at all.
 *                       The root prints its peak with no percent sign, exactly
 *                       as a child does; the panel does NOT fall to the 100,000
 *                       stand-in the header ring uses (rule 4)
 * - `childrenNoWindow`  a child is on the panel and prints no percentage
 */
export type ContextPeakNote =
  | "measured"
  | "fellBack"
  | "published"
  | "window"
  | "modelWindow"
  | "setWindow"
  | "unknown"
  | "childrenNoWindow";

export interface ContextPeakTable {
  rows: ContextPeakRow[];
  notes: ContextPeakNote[];
}

/** What the run said about its own threshold, when it said anything. */
export interface ReportedThreshold {
  threshold: number;
  /** Absent on a pre-card-263 frame — which is not the same as "fallback". */
  source?: ThresholdSource;
  /** The window the threshold was derived from, when the frame stated one.
   *  Absent on every pre-card-366 recording, and on every frame whose backend
   *  learned nothing. Card 377: this is what the panel divides by whenever it
   *  is here and the provenance says the threshold came out of it. */
  window?: number;
}

export interface ContextPeakInput {
  /** deriveDetail(applied).spend — peak and turns per agent id. */
  spend: Record<string, { peak: number; turns: number }>;
  /** deriveDetail(applied).models — each agent's own run_start model. */
  models: Record<string, string>;
  /** agentDirectory(events, upto) — tags and names. */
  directory: AgentDirectory;
  /** The ROOT's latest context_info totals, or null when none arrived. */
  reported: ReportedThreshold | null;
}

/** The tag's numeric part, for ordering w1 before w10. Non-numeric tags sort
 *  last and keep their relative order. */
function tagOrder(tag: string): number {
  const m = /^w([0-9]+)$/.exec(tag);
  return m === null ? Number.MAX_SAFE_INTEGER : Number(m[1]);
}

/**
 * The panel's whole content, as a pure function of the run's own data.
 *
 * @param input the three canon sources plus what the run reported
 * @return one row per agent that actually spent context, root first, and the
 *   notes the panel must print beside them
 */
export function contextPeaks(input: ContextPeakInput): ContextPeakTable {
  const { spend, models, directory, reported } = input;

  let rootId: string | null = null;
  for (const [id, handle] of directory) {
    if (handle.parentId === null) {
      rootId = id;
      break;
    }
  }

  // Rule 3: the reported threshold is passed on WHATEVER its provenance —
  // the same argument ContextRing.tsx passes, so the two surfaces cannot
  // divide by different numbers. The provenance is kept aside for the words.
  const reportedThreshold = reported === null ? undefined : reported.threshold;
  const fellBack = reported !== null && reported.source === "fallback";
  // THE WINDOW IS PASSED IN NOW (card 377), and the null that stood here was
  // the reason the lab and the ring were about to part company. The comment it
  // carried was right for card 366 and wrong the moment the ring started
  // dividing by the window: it argued the window "could never win the tier
  // above it", which was true only while the threshold was the scale on both
  // surfaces. It is not a tier any more: contextGauge asks whether the
  // threshold was DERIVED from the window, and where it was, the window is
  // what either surface divides by. Same function, same three arguments as
  // ContextRing.tsx, which is the whole guarantee this import exists for.
  //
  // Rule 4 is unchanged and is the line below: this panel refuses the shared
  // function's LAST answer, the constant nobody measured. `fallback` is the one
  // `of` that means "I know nothing", so it is the one that becomes "nothing to
  // divide by" here. A transcript that states a window never reaches it.
  const rootDenominator: ContextDenominator | null = (() => {
    const d = contextGauge(
      reportedThreshold,
      reported === null ? undefined : reported.window,
      reported === null ? undefined : reported.source,
    ).denominator;
    return d.of === "fallback" ? null : d;
  })();

  const spent: { id: string; tag: string; name: string; model?: string; peak: number; turns: number }[] = [];
  for (const [id, handle] of directory) {
    const s = spend[id];
    if (s === undefined || s.turns <= 0) continue;
    const model = models[id] ?? handle.model;
    spent.push({
      id,
      tag: handle.tag,
      name: handle.name,
      ...(model === undefined ? {} : { model }),
      peak: s.peak,
      turns: s.turns,
    });
  }
  spent.sort((a, b) => {
    if (a.id === rootId) return -1;
    if (b.id === rootId) return 1;
    return tagOrder(a.tag) - tagOrder(b.tag);
  });

  const maxPeak = spent.reduce((m, r) => Math.max(m, r.peak), 0);

  const rows: ContextPeakRow[] = spent.map((r) => {
    const isRoot = r.id === rootId;
    // Rule 1: only the root can have anything a percentage could honestly
    // divide by — and rule 4: it does not always have one.
    const denominator = isRoot ? rootDenominator : null;
    const share = denominator === null ? null : r.peak / denominator.value;
    return {
      agentId: r.id,
      tag: r.tag,
      name: r.name,
      root: isRoot,
      peak: r.peak,
      turns: r.turns,
      ...(r.model === undefined ? {} : { model: r.model }),
      denominator,
      pct: share === null ? null : Math.round(share * 100),
      frac: share === null ? null : Math.max(0, Math.min(1, share)),
      relFrac: maxPeak > 0 ? r.peak / maxPeak : 0,
    };
  });

  // The provenance decides the WORDS and never the number (rule 3). A threshold
  // the harness derived from a PUBLISHED window is neither a measurement of a
  // running server nor a stand-in, and card 366 gave it its own name on the
  // wire — so the panel stops calling it "measured".
  //
  // SINCE CARD 377 THE NOTE NAMES THE DIVISOR. `measured` and `published` name
  // the threshold; a frame that states its window makes the window the
  // divisor, and a sentence about the threshold would describe a number the
  // row is not a share of. The two new keys say what divides: the window the
  // backend stated, or the one the vendor publishes.
  const published = reported !== null && reported.source === "model";
  const setByHand = reported !== null && reported.source === "window_override";
  const notes: ContextPeakNote[] = [];
  const rootRow = rows.find((r) => r.root);
  if (rootRow !== undefined) {
    const dividesByWindow = rootRow.denominator?.of === "window";
    notes.push(
      rootRow.denominator === null
        ? "unknown"
        : dividesByWindow
          ? published
            ? "modelWindow"
            : setByHand
              ? "setWindow"
              : "window"
          : fellBack
            ? "fellBack"
            : published
              ? "published"
              : "measured",
    );
  }
  if (rows.some((r) => !r.root)) notes.push("childrenNoWindow");

  return { rows, notes };
}
