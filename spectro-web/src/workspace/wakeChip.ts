// Card 498: the header chip of a stored session, before and after its wake.
//
// A stored session opened from the list shows its recorded folder in the chip
// at once, read from its own first run_start: no message and no server round
// trip. A click into its message box wakes it on the server (wake_session),
// and the answer, a workspace_info that names the session, takes the chip's
// place, so Finder, Terminal and the code graph can act on the folder.
//
// Card 520: the selection of the session wakes it too, and the dock reads the
// same answer, so Files and Terminal reach the folder before anything is typed.

import type { WorkspaceInfo } from "../state/reducer";
import type { SessionSet } from "../state/sessionSet";
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
 * The wake's answer for the stored session on screen, when it counts: it names
 * that session, and its folder is on disk (resolved) or reported gone. The
 * wake socket's first frame names the app's folder and no session; it does not
 * count. The header chip and the dock both read this one rule.
 *
 * @param replayId the stored session on screen, or null for the live view
 * @param woken the workspace the woken record's socket announced, or null
 * @return the answer, or null while there is none for this session
 */
export function wokenWorkspace(replayId: string | null, woken: WorkspaceInfo | null): WorkspaceInfo | null {
  if (replayId === null || woken === null || woken.sessionId !== replayId) return null;
  return woken.resolved || folderGone(woken) ? woken : null;
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
  return wokenWorkspace(input.replayId, input.woken) ?? storedChipWorkspace(input.storedCwd);
}

/**
 * The workspace the dock's Files and Terminal panels read (card 520).
 *
 * The live view reads its own announcement. A stored session the next message
 * continues reads the wake's answer once it counts, by the chip's rule; until
 * then, and for an archive that stays read only, the view's own state as
 * before, where a replay carries no workspace and the Files pane names the
 * recorded folder.
 */
export function dockWorkspace(input: {
  viewingLive: boolean;
  viewWorkspace: WorkspaceInfo | null;
  continuable: boolean;
  replayId: string | null;
  woken: WorkspaceInfo | null;
}): WorkspaceInfo | null {
  if (input.viewingLive || !input.continuable) return input.viewWorkspace;
  return wokenWorkspace(input.replayId, input.woken) ?? input.viewWorkspace;
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

/** What wakeFollowsScreen needs of the session set. */
export type WakeSessions = Pick<SessionSet, "slots" | "close" | "findBySession" | "open">;

/**
 * Keeps the wakes in step with the stored session on screen (card 520).
 *
 * A woken record whose session left the screen closes, and the server releases
 * the session for every other window. The session on screen wakes when
 * wakeWanted says so and the server has not refused it (session_busy): App
 * calls this from an effect when a replay lands and from the message box's
 * focus. A session this page already holds or woke is found and left alone,
 * so a second call sends nothing.
 *
 * @param sessions the page's session set
 * @param input the replay on screen, whether the next message continues it,
 *   and whether a wake of it met session_busy
 * @return true when a wake was opened
 */
export function wakeFollowsScreen(
  sessions: WakeSessions,
  input: { replayId: string | null; continuable: boolean; refused: boolean },
): boolean {
  releaseOffScreen(sessions, input.replayId);
  const id = input.replayId;
  if (id === null || input.refused) return false;
  const held = sessions.findBySession(id) !== undefined;
  if (!wakeWanted({ replayId: id, continuable: input.continuable, held })) return false;
  sessions.open({ wake: id });
  return true;
}

/**
 * Closes every woken record whose session is not the one on screen, and the
 * server releases those sessions for every other window.
 *
 * @param sessions the page's session set
 * @param replayId the stored session on screen, or null
 */
export function releaseOffScreen(sessions: WakeSessions, replayId: string | null): void {
  for (const held of sessions.slots()) {
    if (held.woken && held.sessionId !== replayId) sessions.close(held.key);
  }
}

/**
 * How long a stored session stays on screen before its click wake goes out,
 * in milliseconds (card 520). Chosen, not measured: on loopback a small
 * session's replay lands between two scripted clicks (ten clicks took 335 ms
 * in the live check of 2026-10-11), so without a pause every click of a quick
 * run would claim its session for every other window and let it go again.
 * The message box's focus wakes at once and does not wait.
 */
export const WAKE_SETTLE_MS = 250;

/**
 * The click wake (card 520): App's effect when a replay lands. A wake whose
 * session left the screen closes at once; the session on screen wakes after
 * WAKE_SETTLE_MS, unless the next landing cancels it first.
 *
 * @param sessions the page's session set
 * @param input as for wakeFollowsScreen
 * @return the cancel, for the effect's cleanup
 */
export function settleWake(
  sessions: WakeSessions,
  input: { replayId: string | null; continuable: boolean; refused: boolean },
): () => void {
  releaseOffScreen(sessions, input.replayId);
  const timer = setTimeout(() => {
    wakeFollowsScreen(sessions, input);
  }, WAKE_SETTLE_MS);
  return () => clearTimeout(timer);
}
