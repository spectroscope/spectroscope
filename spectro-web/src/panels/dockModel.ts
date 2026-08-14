// Card 219, first cut — pure decisions for the workspace panels: order,
// labels and mode normalization live here so they are testable without a DOM
// (the house suite runs in plain Node).
//
// Card 228 (criterion 0) moved the LAYOUT from a divider stack to a grid of
// cards, and the pair-weight arithmetic left with the dividers: a grid shares
// no edges, so there is nothing to drag between neighbours. The persisted
// `dockWeights` field stays in the layout store for blob compatibility in
// both directions (state/layout.ts says why); nothing reads it any more.

import type { DockPanelId, DockPanelMode, LayoutState } from "../state/layout";

/** Every dock panel, in its fixed order — the grid flows the cards in it. */
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

/** No open card may be smaller than this, or its content is a sliver nobody
 *  can read. The BROWSER panel has a second, stricter honesty rule on top:
 *  under PANE_FLOOR (viewport.ts) it posts `visible: false` instead of a
 *  rectangle the shell would refuse. */
export const PANEL_MIN_PX = 60;
