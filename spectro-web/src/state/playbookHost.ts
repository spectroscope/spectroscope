// Card 554, task 13: two decisions App makes about the session's playbook
// that are not frames.
//
// headerPlaybook: which pick the header chip draws. The live view draws the
// live session's. A stored session that the next message continues draws
// the wake's answer once there is one, and before it the pick its own file
// recorded, folded from its playbook_picked line (integrator decision e). An
// archive that stays read only draws no chip: a pick there could not leave.
//
// composerMoves: what has to move so the composer of the session is on
// screen when the header's play button wrote into it (criterion 4): back to
// the sessions from the Playbook or the Skills view, and to the chat from a
// tab without a composer. The Lab has one.

import type { PlaybookPick } from "./playbookChat";

/**
 * @param at.viewingLive whether the live view is on screen
 * @param at.livePick    the live session's pick (UiState.playbook)
 * @param at.continuable whether the stored session on screen continues on the next message
 * @param at.replayPick  the pick the stored session's file recorded
 * @param at.wokenPick   the wake's answer for that session, or null before it
 * @returns the pick to draw, or null for no chip
 */
export function headerPlaybook(at: {
  viewingLive: boolean;
  livePick: PlaybookPick | null;
  continuable: boolean;
  replayPick: PlaybookPick | null;
  wokenPick: PlaybookPick | null;
}): { pick: PlaybookPick | null } | null {
  if (at.viewingLive) return { pick: at.livePick };
  if (!at.continuable) return null;
  return { pick: at.wokenPick ?? at.replayPick };
}

/**
 * @param at.skillsOpen whether the Skills and Commands view covers the surface
 * @param at.nav        the rail's segment
 * @param at.tab        the session's tab
 * @returns whether the segment and the tab have to change
 */
export function composerMoves(at: { skillsOpen: boolean; nav: string; tab: string }): {
  segment: boolean;
  tab: boolean;
} {
  return {
    segment: at.skillsOpen || at.nav !== "sessions",
    tab: at.tab !== "chat" && at.tab !== "lab",
  };
}
