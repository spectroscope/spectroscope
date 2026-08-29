// Card 301: which of the dock's three panels is showing.
//
// WHY TABS AND NOT SECTIONS — the decision this card was asked to make and
// state. Card 300 deliberately left the dock UNMOUNTED while collapsed,
// because mounting it would run deriveDetail over the whole applied prefix on
// every step for a panel nobody opened. Stacking three panels as sections
// would give that cost straight back and then double it: an open dock would
// fold the context peak, the message lanes AND the file footprint on every
// single step, while a reader looks at one of them. Tabs keep the property
// card 300 paid for — exactly one fold runs, and a collapsed dock still runs
// none of them.
//
// The choice persists the way the lab's other preferences do (LENS_STORAGE_KEY,
// ROWS_STORAGE_KEY): its own key, a pure read half so a gate can bite the
// round-trip without a DOM, and a write half that shrugs off private mode.

/** The dock's panels, in reading order. `moments` joined them in card 309 —
 *  appended, so a stored preference from before it still reads back as the tab
 *  it named. */
export const DOCK_TABS = ["ctx", "msg", "files", "moments"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export const DOCK_TAB_STORAGE_KEY = "spectroscope.lab.dock";

/** The read half. Anything unrecognised falls back to the context peak — the
 *  panel the dock shipped with, so an unreadable preference is never a blank
 *  dock. */
export function dockTabFrom(stored: string | null): DockTab {
  return (DOCK_TABS as readonly string[]).includes(stored ?? "") ? (stored as DockTab) : "ctx";
}

/** The write half. */
export function persistDockTab(next: DockTab): void {
  try {
    localStorage.setItem(DOCK_TAB_STORAGE_KEY, next);
  } catch {
    // private mode: the choice simply does not stick
  }
}
