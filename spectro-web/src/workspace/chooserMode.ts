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
