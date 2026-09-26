// Which workspace option the chooser starts on. It used to be the literal
// "random", while buildAgentOnce resolves `pinned != null ? pinned :
// config.workspace()`, so on a machine with a configured workspace the empty
// chat showed one answer and the first run used another. A pre-selection is a
// proposal; rendering it as a report is the bug.

import type { Turn } from "../state/reducer";
import type { WorkspaceAnnouncement, WorkspaceMode } from "./paneState";

/**
 * The options the chooser draws, in the order it draws them. Each is a mode
 * SessionConnection.onSetWorkspace accepts from a click, which
 * workspaceModes.drift.test.ts checks against the Java `case` labels.
 * "random" is the entry for no folder: the run then gets a temporary folder
 * of its own, and the row names that folder only once a frame carries it.
 */
export const CHOOSER_OPTIONS = ["random", "default", "set"] as const;

/** One option of the chooser, and the mode a click on it sends. */
export type ChooserOption = (typeof CHOOSER_OPTIONS)[number];

/**
 * The option that stands for each announced mode. A record keyed by the mode
 * union, so a mode added to WORKSPACE_MODES does not compile until it has an
 * option. "recorded" is the folder a resumed session's record names: one
 * specific folder, which is what "set" stands for.
 */
const OPTION_FOR: Record<WorkspaceMode, ChooserOption> = {
  set: "set",
  recorded: "set",
  default: "default",
  random: "random",
};

/**
 * @param mode an announced mode
 * @return the option the chooser marks for it
 */
export function optionFor(mode: WorkspaceMode): ChooserOption {
  return OPTION_FOR[mode];
}

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
 * The option to mark for an announcement.
 *
 * @param announcement the workspace_info frame, or null before one arrives
 * @return the option, or null while the mode is genuinely unknown
 */
export function preselectedOption(announcement: WorkspaceAnnouncement | null): ChooserOption | null {
  const mode = preselectedMode(announcement);
  return mode === null ? null : optionFor(mode);
}

/**
 * The absolute path for the row's tooltip, whenever the frame carries one.
 *
 * It reads the path and not `configured`: the resolved frame of a random-mode
 * run carries a real folder with configured false. The prospective random
 * frame carries no path at all, because that folder is keyed by a session id
 * nobody has minted, and there this answers null.
 *
 * @param announcement the workspace_info frame, or null before one arrives
 * @return the path as the frame carries it, or null when it carries none
 */
export function chooserTitle(announcement: WorkspaceAnnouncement | null): string | null {
  if (announcement === null) return null;
  const path = announcement.path;
  return typeof path === "string" && path.trim() !== "" ? path : null;
}

/**
 * The last segment of a path, or null when it has none ("/" or blank).
 *
 * @param path an absolute path
 * @return the folder's own name
 */
export function folderName(path: string): string | null {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? null : parts[parts.length - 1];
}

/**
 * A folder name cut to `max` characters, the last one an ellipsis. The row
 * clips the name inside the sentence that says a folder is gone, so the end
 * of that sentence stays on screen; the tooltip keeps the whole path.
 *
 * @param name a folder name
 * @param max  the longest result, ellipsis included
 * @return the name, whole when it fits
 */
export function clipName(name: string, max: number): string {
  return name.length <= max ? name : name.slice(0, max - 1) + "\u2026";
}

/**
 * The folder the chooser NAMES: the last segment of chooserTitle.
 *
 * @param announcement the workspace_info frame, or null before one arrives
 * @return the folder's own name, or null when the frame carries no path
 */
export function chooserFolder(announcement: WorkspaceAnnouncement | null): string | null {
  const path = chooserTitle(announcement);
  return path === null ? null : folderName(path);
}

/**
 * Whether the chat is still before its first prompt, the only time the working
 * folder row is drawn (card 428). A user turn is built by the run_start that
 * answers a prompt, or by an imported transcript. An error line alone, from a
 * prompt the server refused or a folder pick it rejected, leaves this true.
 *
 * @param turns the chat's turns
 * @return true while no turn is a prompt
 */
export function beforeFirstPrompt(turns: readonly Turn[]): boolean {
  return !turns.some((turn) => turn.kind === "user");
}
