// Card 455: which first-start dialog is up, as one pure rule. The mode screen
// comes first. Only learn goes on to the tutorial question; light answers that
// question itself with "off" (lightTutorialAnswer). The backend sheet waits for
// both, so at most one of the three is up at a time.

import type { LevelingMode, LevelingSnapshot } from "./leveling";
import type { ViewMode } from "./viewMode";

export type FirstStartDialog = "mode" | "tutorial" | "backend" | null;

export interface FirstStartState {
  /** Whether the mode screen was answered in this origin. */
  modeChosen: boolean;
  /** The window's mode. */
  viewMode: ViewMode;
  /** The server's leveling state, or null while unknown or unavailable. */
  snapshot: LevelingSnapshot | null;
  /** Whether the backend sheet would show on its own terms (shouldShowOnboarding). */
  backendDue: boolean;
}

/** Whether the tutorial question is still open in this home. Null reads as answered. */
function tutorialOpen(snapshot: LevelingSnapshot | null): boolean {
  return snapshot !== null && !snapshot.introSeen;
}

/** The one dialog that is up, or null. */
export function firstStartDialog(state: FirstStartState): FirstStartDialog {
  if (!state.modeChosen) return "mode";
  if (tutorialOpen(state.snapshot)) {
    // In any mode but learn the question is never asked; the answer that
    // lightTutorialAnswer sends is on its way, and the backend sheet waits for it.
    return state.viewMode === "learn" ? "tutorial" : null;
  }
  return state.backendDue ? "backend" : null;
}

/**
 * The tutorial answer a window outside learn sends in place of the question:
 * "off", while the question is open and the mode screen is done. Null when
 * there is nothing to send.
 *
 * Why off: a fresh home starts on the ladder, and in light the tab row and the
 * level pill are open while the tutorial is on (state/surfaces.ts). Without an
 * answer, a light user would get the tutorial the mode screen skipped for them.
 * A home that already answered keeps its answer.
 */
export function lightTutorialAnswer(state: Omit<FirstStartState, "backendDue">): LevelingMode | null {
  if (!state.modeChosen || state.viewMode === "learn") return null;
  return tutorialOpen(state.snapshot) ? "off" : null;
}
