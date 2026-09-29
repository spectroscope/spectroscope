// Card 443: the generated images are a panel of the dock.
//
// Two doors reach them from outside the dock: the header's images toggle and
// the desktop's View > Images row (`images.toggle`). Both call
// toggleImagesPanel, so they cannot disagree. A picture that arrives while the
// operator watches reveals the panel, the way the old area opened itself.

import { getLayout, openDockPanel, openRightPanel, toggleDockPanel } from "./layout";
import type { LayoutState } from "./layout";

/**
 * Whether the images are on screen: the dock is shown and the panel is in it.
 *
 * @param layout the layout to read
 * @return true when the operator can see the images panel
 */
export function imagesShown(layout: LayoutState): boolean {
  return layout.rightPanelOpen && layout.dockImages !== "closed";
}

/**
 * The header toggle and the View menu row. Shown images close their panel and
 * leave the dock as it is. Anything else shows them: the panel opens (or
 * unfolds) and the dock appears. A panel that is open behind a hidden dock is
 * shown rather than closed, because closing something nobody can see changes
 * nothing the operator can check.
 *
 * <p>The open is an explicit ask, so it writes the dock's return memory (card
 * 242), like the header's panel icons do.</p>
 */
export function toggleImagesPanel(): void {
  if (imagesShown(getLayout())) {
    toggleDockPanel("images");
    return;
  }
  openDockPanel("images");
  openRightPanel(true);
}

/**
 * A new picture arrived while the operator watches. Opens the panel and shows
 * the dock without touching the return memory: the open serves the moment,
 * like the agent's browser cue (card 241).
 */
export function revealImagesPanel(): void {
  openDockPanel("images");
  openRightPanel();
}
