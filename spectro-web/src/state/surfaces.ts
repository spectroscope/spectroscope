// Card 430: which surface is open in which mode. One table, one entry per
// surface, and a surface without an entry for every mode does not compile.
// The tab row and the rail's nav rows are drawn from it; the guard in
// surfaces.guard.test.tsx holds the rendered App against it. The tab on screen,
// the chat menu's live trace switch, the fleet section of the settings page
// and every way into a surface (state/modeRoute.ts) ask it too.
//
// Light is a browser mode: the server records every session as it always did
// (owner decision 2, 2026-09-24). Leveling is a second axis and never removes
// a button (state/leveling.ts); the mode does. Developer (card 481) opens what
// learn opens and the playbook besides; its level pill follows the tutorial
// the way light's does.

import type { NavActionId, NavSegmentId } from "../components/navRows";
import type { LevelingSnapshot } from "./leveling";
import { VIEW_TABS, type ViewTab } from "./route";
import type { ViewMode } from "./viewMode";

/**
 * How present a surface is in one mode.
 *
 * `tutorial` means open while the tutorial is on and gone while it is off. The
 * owner, 2026-09-25 about 17:25: in light the whole tab row can go, except
 * while the tutorial is on, because the tutorial (the level pill and the panel
 * it opens) sits in that row.
 */
export type Presence = "open" | "gone" | "tutorial";

/** Parts of the window that are not a tab and not a nav row. */
export type PartId = "tabRow" | "dock" | "leveling" | "liveTraceSwitch" | "fleetSettings";

export type SurfaceId = ViewTab | NavActionId | NavSegmentId | PartId;

export interface SurfaceSpec {
  modes: Record<ViewMode, Presence>;
  /**
   * Criterion 9: the view modules that load from chunks of their own, as paths
   * under src/. The entry imports none of them statically, light never
   * requests them, and learn fetches them once the browser is idle
   * (state/surfaceChunks.ts). The chunk guard reads this list.
   */
  chunks?: readonly string[];
}

const EVERYWHERE: Record<ViewMode, Presence> = { learn: "open", light: "open", developer: "open" };
/** Open wherever learn is open: learn and developer, gone in light. */
const LEARN_ONLY: Record<ViewMode, Presence> = { learn: "open", light: "gone", developer: "open" };

/** The table. The card's criterion 2, plus the tab row as its own surface. */
export const SURFACES: Record<SurfaceId, SurfaceSpec> = {
  // The row that holds the tabs, the back and forward steps, the translate
  // toggle and the level pill.
  tabRow: { modes: { learn: "open", light: "tutorial", developer: "open" } },
  chat: { modes: EVERYWHERE },
  spectrum: { modes: LEARN_ONLY, chunks: ["spectrum/SpectrumView.tsx"] },
  trace: { modes: LEARN_ONLY, chunks: ["components/TraceView.tsx"] },
  graph: { modes: LEARN_ONLY, chunks: ["graph/GraphView.tsx"] },
  text: { modes: LEARN_ONLY, chunks: ["components/TextView.tsx"] },
  lab: { modes: LEARN_ONLY, chunks: ["lab/LabView.tsx"] },
  // The rail's upper rows. The card names skills; new chat, scenarios and
  // starters open a chat, a picker and a picker, so light keeps them.
  newChat: { modes: EVERYWHERE },
  scenarios: { modes: EVERYWHERE },
  starters: { modes: EVERYWHERE },
  skills: { modes: EVERYWHERE },
  // The rail's segments. Fleets takes the fleet parts of the rail with it.
  sessions: { modes: EVERYWHERE },
  fleets: {
    modes: LEARN_ONLY,
    chunks: [
      "spectrum/FleetLobby.tsx",
      "spectrum/FleetBar.tsx",
      "spectrum/FleetBus.tsx",
      "spectrum/AgentFeed.tsx",
      "spectrum/FleetHome.tsx",
      "spectrum/FleetSpawn.tsx",
      "lab/FleetLab.tsx",
    ],
  },
  stategraph: { modes: LEARN_ONLY, chunks: ["stategraph/StateGraphPane.tsx"] },
  // Card 481: the playbook module, the fourth segment, developer only, in a
  // chunk of its own.
  playbook: {
    modes: { learn: "gone", light: "gone", developer: "open" },
    chunks: ["playbook/PlaybookPane.tsx"],
  },
  // Files, terminal and browser beside the chat.
  dock: { modes: EVERYWHERE },
  // The level pill, the level panel and the locked-tab teaser.
  leveling: { modes: { learn: "open", light: "tutorial", developer: "tutorial" } },
  // The row in the chat's menu that keeps or drops the live trace (card 246).
  liveTraceSwitch: { modes: LEARN_ONLY },
  // The fleet block of the settings page.
  fleetSettings: { modes: LEARN_ONLY },
};

/**
 * Whether the tutorial is on: a leveling snapshot in a mode other than off.
 * That is the state in which App draws the level pill and lets the level panel
 * open (`leveling.snapshot.mode !== "off"` at both render sites), so it is the
 * state in which the tutorial can be reached at all.
 */
export function tutorialOn(snapshot: LevelingSnapshot | null | undefined): boolean {
  return snapshot !== null && snapshot !== undefined && snapshot.mode !== "off";
}

/**
 * Whether a surface is open.
 *
 * @param surface  the table's id
 * @param mode     the window's mode
 * @param tutorial whether the tutorial is on ({@link tutorialOn})
 */
export function isOpen(surface: SurfaceId, mode: ViewMode, tutorial = false): boolean {
  const presence = SURFACES[surface].modes[mode];
  return presence === "open" || (presence === "tutorial" && tutorial);
}

/** The tabs the tab row draws, in route order; none when the row itself is closed. */
export function tabsShown(mode: ViewMode, tutorial: boolean): ViewTab[] {
  if (!isOpen("tabRow", mode, tutorial)) return [];
  return VIEW_TABS.filter((tab) => isOpen(tab, mode, tutorial));
}

/**
 * The tab the window shows for the tab that was chosen: the chosen one where
 * the mode opens it, else the chat of the same place. App reads every `tab`
 * through this, so where the mode and the leveling ladder both speak, the mode
 * wins: a tab light closes is never shown, and so never shown as a teaser
 * either (criterion 8).
 */
export function shownTab(chosen: ViewTab, mode: ViewMode): ViewTab {
  return isOpen(chosen, mode) ? chosen : "chat";
}

/**
 * Whether the settings page draws a section in this mode. The fleet section is
 * the table's `fleetSettings`; every other section is drawn in both modes.
 */
export function settingsSectionOpen(section: string, mode: ViewMode): boolean {
  return section !== "fleet" || isOpen("fleetSettings", mode);
}
