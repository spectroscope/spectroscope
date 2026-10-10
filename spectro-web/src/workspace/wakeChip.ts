// Card 498: the header chip of a stored session, before and after its wake.
//
// A stored session opened from the list shows its recorded folder in the chip
// at once, read from its own first run_start: no message and no server round
// trip. A click into its message box wakes it on the server (wake_session),
// and the answer, a workspace_info that names the session, takes the chip's
// place, so Finder, Terminal and the code graph can act on the folder.

import type { WorkspaceInfo } from "../state/reducer";
import { folderGone } from "../components/WorkspaceChip";

/**
 * The chip for a stored session before its wake: the folder its record names,
 * with no session id, so the rows that act through the server still wait.
 *
 * @param storedCwd the folder the session's first run_start recorded, or nothing
 * @return the announcement to draw, or null when the record names no folder
 */
export function storedChipWorkspace(storedCwd: string | null | undefined): WorkspaceInfo | null {
  if (storedCwd == null || storedCwd.trim() === "") return null;
  return { resolved: false, mode: "recorded", configured: false, path: storedCwd };
}

/**
 * The workspace the header chip shows.
 *
 * The live view shows its own announcement. A stored session that the next
 * message continues shows the wake's answer once one names this session, and
 * its recorded folder until then: the wake's socket first says which folder
 * the app would use for a new chat, and that is not this session's. Only an
 * answer that names a folder on disk or a recorded folder that is gone counts;
 * a folder the first message would create leaves the chip as it was. An
 * archive that stays read-only shows no chip, as before.
 */
export function headerWorkspace(input: {
  viewingLive: boolean;
  liveWorkspace: WorkspaceInfo | null;
  continuable: boolean;
  replayId: string | null;
  storedCwd: string | null;
  woken: WorkspaceInfo | null;
}): WorkspaceInfo | null {
  if (input.viewingLive) return input.liveWorkspace;
  if (!input.continuable || input.replayId === null) return null;
  const woken = input.woken;
  if (woken !== null && woken.sessionId === input.replayId && (woken.resolved || folderGone(woken)))
    return woken;
  return storedChipWorkspace(input.storedCwd);
}

/**
 * Whether a focus in the message box wakes the session on screen: a stored
 * session the next message continues, not yet held or woken by this page.
 * An import and a scenario have no file on this server to wake.
 */
export function wakeWanted(input: { replayId: string | null; continuable: boolean; held: boolean }): boolean {
  const id = input.replayId;
  if (id === null || !input.continuable || input.held) return false;
  return !id.startsWith("import:") && !id.startsWith("scenario:");
}

/**
 * The sessions this page holds a socket to: the rail's held rows and every
 * wake. A wake is claimed in the server's live set like any socket, and a
 * session this page holds is never "live in another window".
 */
export function ownSessionIds(
  held: readonly { id: string }[],
  slots: readonly { sessionId: string | null; woken: boolean }[],
): string[] {
  const own = held.map((row) => row.id);
  for (const slot of slots) {
    if (slot.woken && slot.sessionId !== null && !own.includes(slot.sessionId)) own.push(slot.sessionId);
  }
  return own;
}
