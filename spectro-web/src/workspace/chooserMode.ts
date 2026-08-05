// Which workspace option the chooser starts on. It used to be the literal
// "random", while buildAgentOnce resolves `pinned != null ? pinned :
// config.workspace()`, so on a machine with a configured workspace the empty
// chat showed one answer and the first run used another. A pre-selection is a
// proposal; rendering it as a report is the bug.

import type { WorkspaceAnnouncement, WorkspaceMode } from "./paneState";

/**
 * The mode a run started right now would actually use.
 *
 * @param announcement the workspace_info frame, or null before one arrives
 * @return the mode to pre-select, or null while it is genuinely unknown
 */
export function preselectedMode(announcement: WorkspaceAnnouncement | null): WorkspaceMode | null {
  return announcement === null ? null : announcement.mode;
}

/**
 * The folder the chooser can NAME, or null when there is nothing honest to say.
 *
 * The announcement has carried the path all along — `SessionConnection` puts it
 * on the frame whenever a workspace is configured — and the chooser read only
 * `mode` off it. So a machine with a configured workspace was handed
 * `/Users/…/ForgeDemo` and rendered the word "default": the one screen that
 * exists to tell the reader where his agent will work named everything except
 * the folder.
 *
 * `random` stays silent on purpose. That folder is keyed by a session id that
 * has not been minted, so there is no name yet and inventing one would be a
 * claim about a session that does not exist.
 *
 * @param announcement the workspace_info frame, or null before one arrives
 * @return the folder's own name (its last segment), or null
 */
export function chooserFolder(announcement: WorkspaceAnnouncement | null): string | null {
  if (announcement === null || !announcement.configured) return null;
  const path = announcement.path;
  if (typeof path !== "string" || path.trim() === "") return null;
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? null : parts[parts.length - 1];
}
