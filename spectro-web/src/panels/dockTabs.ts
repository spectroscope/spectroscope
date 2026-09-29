// Card 444: the decisions behind the dock's tabs mode that need no DOM.
//
// A swap is not a close. Closing a panel unmounts it, and for the terminal
// that ends every shell (measured 2026-09-29: a new PID after close and
// reopen). In tabs mode a panel the operator swaps away from stays mounted and
// hidden, "parked", so switching Terminal to Files and back finds the same
// shell. The parked set lives in the dock component for as long as tabs mode
// and the dock stay; these functions decide what goes in it.

import { DOCK_ORDER } from "./dockModel";
import type { DockPanelId, DockPanelMode } from "../state/layout";

/**
 * The panel that stays when the dock switches from side by side to tabs.
 *
 * @param modes   each panel's mode
 * @param offered the panels this reading offers (work only in the v2 chat)
 * @param focused the panel the operator last touched, or null
 * @return the focused panel if it is shown and offered, else the first shown
 *         one in dock order, else the first offered one, else null
 */
export function keepOnTabs(
  modes: Readonly<Record<DockPanelId, DockPanelMode>>,
  offered: readonly DockPanelId[],
  focused: DockPanelId | null,
): DockPanelId | null {
  if (focused !== null && offered.includes(focused) && modes[focused] !== "closed") return focused;
  const shown = DOCK_ORDER.find((id) => offered.includes(id) && modes[id] !== "closed");
  return shown ?? offered[0] ?? null;
}

/**
 * The parked panels after the shown one changed.
 *
 * @param parked the panels parked so far
 * @param prev   the panel shown before, or null
 * @param now    the panel shown now, or null
 * @return the new parked list: `now` leaves it, `prev` joins it when it was swapped away
 */
export function nextParked(
  parked: readonly DockPanelId[],
  prev: DockPanelId | null,
  now: DockPanelId | null,
): DockPanelId[] {
  const out = parked.filter((id) => id !== now);
  if (prev !== null && prev !== now && !out.includes(prev)) out.push(prev);
  return out;
}

/**
 * What the dock mounts in tabs mode: the shown panel and the parked ones, in
 * dock order so a swap never moves a mounted card among its siblings.
 *
 * @param parked the parked panels
 * @param shown  the shown panel, or null
 * @return the mounted panels and the one of them that is visible
 */
export function tabsSeating(
  parked: readonly DockPanelId[],
  shown: DockPanelId | null,
): { mounted: DockPanelId[]; shown: DockPanelId | null } {
  return { mounted: DOCK_ORDER.filter((id) => id === shown || parked.includes(id)), shown };
}
