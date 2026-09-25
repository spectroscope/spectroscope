// The folder a stored session ran in, read from its own events (card 421).
//
// A session reopened from the sidebar is a replay: the reducer folds its JSONL
// alone, and the workspace_info frame never lands in that file, so the Files
// pane had no announcement and promised a first run. Since card 284 the
// folder is in the file on the run_start of a run Agent.java started with a
// cwd. A triggered node's run_start lacks it: HeadlessRunner re-stamps it
// through the constructor that predates card 284 (card 439). This module
// reads the folder where the file has one and names it; nothing on disk is
// resolved, listed or created from it.

import { t, type Lang } from "../i18n/i18n";
import type { RunEvent } from "../events";
import type { PaneState, WorkspaceAnnouncement } from "./paneState";

/**
 * The folder the session's runs worked in, as its own record carries it.
 *
 * The same rule as the server's SessionStore.recordedWorkspace, which a resume
 * uses to land in that folder: the FIRST run_start that names a non-blank
 * folder wins, because a later run in the same file inherited whatever the
 * resume resolved.
 *
 * @param events the session's events as stored
 * @return the folder, or null when no run named one
 */
export function storedFolderOf(events: readonly RunEvent[]): string | null {
  for (const event of events) {
    if (event.type === "run_start" && typeof event.workspace === "string" && event.workspace.trim() !== "") {
      return event.workspace;
    }
  }
  return null;
}

/**
 * The recorded folder of the replay on screen, when it is a session this app
 * stored. An import keeps card 291's path and wording, and a scenario is a
 * demo, so both answer null here; so does the live view.
 *
 * @param replay the replay on screen, or null for the live view
 * @return the folder its record names, or null
 */
export function storedCwdOf(replay: { id: string; events: readonly RunEvent[] } | null): string | null {
  if (replay === null || replay.id.startsWith("import:") || replay.id.startsWith("scenario:")) {
    return null;
  }
  return storedFolderOf(replay.events);
}

/**
 * The pane for a stored session whose record names a folder.
 *
 * Worded apart from an import's: that run happened somewhere else, this one
 * ran on this machine. It only names the folder, like card 291's pane, and the
 * moment a live announcement exists the live answer wins and this says nothing.
 *
 * @param storedCwd the folder the session's record names, or nothing
 * @param announcement the latest workspace_info frame, or null before any
 * @param lang the UI-chrome language
 * @return the pane to show instead of paneState's, or null to defer to it
 */
export function storedWorkspace(
  storedCwd: string | null | undefined,
  announcement: WorkspaceAnnouncement | null,
  lang: Lang,
): PaneState | null {
  if (storedCwd == null || storedCwd === "" || announcement !== null) return null;
  return { kind: "pending", path: storedCwd, message: t(lang, "ws.stored") };
}
