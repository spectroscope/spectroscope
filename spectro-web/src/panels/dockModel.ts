// Card 219, first cut — pure decisions for the dock: the right panel as a
// stack of independent panels. Order, labels, mode normalization, the
// persisted weight format and the divider arithmetic all live here so they
// are testable without a DOM (the house suite runs in plain Node).
//
// The weights are RELATIVE flex-grow factors, not pixels: a window resize
// keeps the proportions without anyone recomputing, which is the same reason
// the workspace divider went percentage (see the card's resize-idiom table).

import type { DockPanelId, DockPanelMode, LayoutState } from "../state/layout";

/** Every dock panel, in its fixed stacking order. Moving panels is OUT of the
 *  first cut — the owner scoped it away himself — so the order is a constant. */
export const DOCK_ORDER: readonly DockPanelId[] = [
  "work",
  "agents",
  "plan",
  "context",
  "files",
  "terminal",
  "browser",
];

/** The i18n key for one panel's name in the strip and its header. */
export function dockLabelKey(id: DockPanelId): string {
  return `rp.${id}`;
}

/** A stored mode, made safe: junk reads as closed, so a corrupt storage entry
 *  never opens a panel — nobody gets a PTY from garbage (the card 93 rule). */
export function normalizeDockMode(v: unknown): DockPanelMode {
  return v === "open" || v === "collapsed" || v === "closed" ? v : "closed";
}

/** One mode per panel, read off the layout store's scalar fields. */
export function dockModes(layout: LayoutState): Record<DockPanelId, DockPanelMode> {
  return {
    work: layout.dockWork,
    agents: layout.dockAgents,
    plan: layout.dockPlan,
    context: layout.dockContext,
    files: layout.dockFiles,
    terminal: layout.dockTerminal,
    browser: layout.dockBrowser,
  };
}

/** What a weight may hand out — generous, because the divider's real clamp is
 *  the pixel floor below. */
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 8;

/** No open panel body may be dragged under this, or its content is a sliver
 *  nobody can read. The BROWSER panel has a second, stricter honesty rule on
 *  top: under PANE_FLOOR (viewport.ts) it posts `visible: false` instead of a
 *  rectangle the shell would refuse. */
export const PANEL_MIN_PX = 60;

/** One keyboard step moves this fraction of the pair's total weight. */
export const DIVIDER_STEP_FRACTION = 0.04;

export type DockWeights = Partial<Record<DockPanelId, number>>;

/** Parses the persisted `"files:2,terminal:0.5"` form. Tolerant by design:
 *  unknown ids, NaN and stray separators fall away rather than throwing. */
export function parseDockWeights(serialized: string): DockWeights {
  const out: DockWeights = {};
  for (const part of serialized.split(",")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const id = part.slice(0, at) as DockPanelId;
    if (!DOCK_ORDER.includes(id)) continue;
    const n = Number(part.slice(at + 1));
    if (Number.isFinite(n) && part.slice(at + 1).trim() !== "") out[id] = n;
  }
  return out;
}

export function serializeDockWeights(weights: DockWeights): string {
  return DOCK_ORDER.filter((id) => weights[id] !== undefined)
    .map((id) => `${id}:${weights[id]}`)
    .join(",");
}

/** A panel's effective weight: default 1, clamped on the way OUT — the store
 *  keeps what was written, the layout only ever sees a sane factor. */
export function weightOf(weights: DockWeights, id: DockPanelId): number {
  const w = weights[id];
  if (w === undefined || !Number.isFinite(w)) return 1;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, w));
}

/**
 * The divider drag: pixels moved, turned into the pair's new weights.
 *
 * <p>The pair's total weight is preserved, so panels outside the pair never
 * move — dragging one divider must not breathe through the whole stack. Both
 * sides floor at `minPx`; a pair too small to honour two minima refuses the
 * drag outright rather than folding a panel to nothing.
 *
 * @param wa    upper panel's weight   @param wb lower panel's weight
 * @param ha    upper panel's height (px) at drag start
 * @param hb    lower panel's height (px) at drag start
 * @param dy    pointer travel since drag start (down = positive = grow upper)
 * @param minPx the smallest height either side may keep
 */
export function pairWeightsForHeights(
  wa: number,
  wb: number,
  ha: number,
  hb: number,
  dy: number,
  minPx: number,
): [number, number] {
  const total = ha + hb;
  if (total < 2 * minPx || total <= 0) return [wa, wb];
  const haNext = Math.max(minPx, Math.min(ha + dy, total - minPx));
  const pair = wa + wb;
  const waNext = (haNext / total) * pair;
  return [waNext, pair - waNext];
}

/** One arrow-key press on the divider: a fixed fraction of the pair travels
 *  from one side to the other, clamped so neither weight leaves its band. */
export function dividerKeyStep(wa: number, wb: number, dir: 1 | -1): [number, number] {
  const pair = wa + wb;
  const delta = pair * DIVIDER_STEP_FRACTION * dir;
  const waNext = Math.max(MIN_WEIGHT, Math.min(wa + delta, pair - MIN_WEIGHT));
  return [waNext, pair - waNext];
}
