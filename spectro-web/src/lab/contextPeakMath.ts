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
// 2. A MEASURED THRESHOLD BEATS THE TABLE. contextWindowFor is a prefix guess
//    and has already been wrong once in production: claude-fable-5 fell to the
//    200k row and the ring read 379% on a healthy session. When the run said
//    what its own threshold is, that number wins.
//
// 3. A THRESHOLD THE HARNESS FELL BACK TO IS NOT A MEASUREMENT. This is what
//    thresholdSource buys: the number 100000 arrives on the wire whether the
//    harness measured a window or learned nothing at all, and only the
//    provenance separates the two. `fallback` is therefore passed on as ABSENT,
//    so the divisor drops to the model table (labelled as published) or to the
//    constant (labelled as neither). An absent provenance is NOT `fallback` —
//    a pre-card-263 frame stated nothing, and its threshold is taken at its
//    word the way it always was.

import { contextDenominator, type ContextDenominator } from "../components/contextRingMath";
import { contextWindowFor } from "../components/contextWindow";
import type { AgentDirectory } from "./agentDirectory";

/** The harness's own CompactionThreshold.Source, as it rides the wire. */
export type ThresholdSource = "override" | "window" | "fallback";

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
   *  child — see rule 1 above. */
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
 * - `measured`          the root's divisor is the threshold the run reported
 * - `published`         it is a published limit from the model table instead
 * - `unknown`           it is neither: a constant stand-in
 * - `childrenNoWindow`  a child is on the panel and prints no percentage
 */
export type ContextPeakNote = "measured" | "published" | "unknown" | "childrenNoWindow";

export interface ContextPeakTable {
  rows: ContextPeakRow[];
  notes: ContextPeakNote[];
}

/** What the run said about its own threshold, when it said anything. */
export interface ReportedThreshold {
  threshold: number;
  /** Absent on a pre-card-263 frame — which is not the same as "fallback". */
  source?: ThresholdSource;
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
  /** The model to fall back to for the ROOT when its run_start named none —
   *  the app's currently selected model. Never used for a child. */
  fallbackModel?: string;
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

  // Rule 3 first: a threshold the harness says it fell back to states that
  // nothing was learned, so it is handed on as nothing.
  const measured = reported !== null && reported.source !== "fallback" ? reported.threshold : undefined;
  const rootModel = (rootId === null ? undefined : models[rootId]) ?? input.fallbackModel;
  const rootWindow = rootModel === undefined || rootModel === "" ? null : contextWindowFor(rootModel);

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
    // Rule 1: only the root has anything a percentage could honestly divide by.
    const denominator = isRoot ? contextDenominator(measured, rootWindow) : null;
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

  const notes: ContextPeakNote[] = [];
  const rootRow = rows.find((r) => r.root);
  if (rootRow !== undefined && rootRow.denominator !== null) {
    notes.push(
      rootRow.denominator.of === "compaction"
        ? "measured"
        : rootRow.denominator.of === "window"
          ? "published"
          : "unknown",
    );
  }
  if (rows.some((r) => !r.root)) notes.push("childrenNoWindow");

  return { rows, notes };
}
