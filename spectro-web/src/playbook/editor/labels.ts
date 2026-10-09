// Card 483: outcome labels. The layout carries anchors, not text, so the label
// of drawn edge k is the outcome of the arrow projected as edge k.

import type { StateGraphLayout } from "../../stategraph/layout";
import type { PlaybookDoc } from "./doc";
import type { Projection } from "./projection";

/** Assumed advance per character at 11 px mono; Task 12 measures it. */
export const CHAR_PX = 6.6;
/** How far each further label of a parallel pair moves away from the line. */
export const LABEL_STEP = 14;

/** The column gap that holds the longest outcome label, or the engine's own when no arrow has one. */
export function gapFor(doc: PlaybookDoc): number | undefined {
  let longest = 0;
  let any = false;
  for (const a of doc.arrows) {
    if (a.on === undefined || a.on === "") continue;
    any = true;
    longest = Math.max(longest, a.on.length);
  }
  if (!any) return undefined;
  return Math.max(58, Math.min(140, Math.ceil(longest * CHAR_PX) + 20));
}

export interface PlacedLabel {
  edgeIndex: number;
  text: string;
  x: number;
  y: number;
}

/** The parallel index from the engine's edge id: `a->b` is 0, `a->b#2` is 1. */
function parallelIndex(id: string, from: string, to: string): number {
  const pair = `${from}->${to}`;
  if (id === pair || !id.startsWith(`${pair}#`)) return 0;
  const n = Number(id.slice(pair.length + 1));
  return Number.isInteger(n) && n > 1 ? n - 1 : 0;
}

export function placeLabels(doc: PlaybookDoc, p: Projection, laid: StateGraphLayout): PlacedLabel[] {
  const out: PlacedLabel[] = [];
  laid.edges.forEach((e, k) => {
    const j = p.edgeArrow[k];
    if (j === null || j === undefined) return;
    const on = doc.arrows[j]?.on;
    if (on === undefined || on === "") return;
    const n = parallelIndex(e.id, e.from, e.to);
    out.push({
      edgeIndex: k,
      text: on,
      x: e.labelX,
      y: e.back ? e.labelY + n * LABEL_STEP : e.labelY - n * LABEL_STEP,
    });
  });
  return out;
}
