// Card 605, task 12: a GitHub Copilot session folder, read as a whole.
//
// The grouping (groupPickedFiles in claudeCodeRun.ts) names the folder's files
// from their paths; this module reads the ones it names and loads the folder.
// The events go through the importer (detect.ts), whose content check decides
// the format: a folder whose events.jsonl is not a Copilot session loads as
// whatever it is, without the side files. A browser hands a page only the files
// the person picked, so nothing here reads a file the person did not pick.

import type { RunEvent } from "../events";
import type { ImportedRunSummary, PickedCopilotFolder } from "./claudeCodeRun";
import { detectAndLoad, type ImportKind, type ImportSource } from "./detect";
import type { SubagentTranscript } from "./subagentFile";

/** A picked file as far as this module reads it; a browser File is one. */
export interface PickedText {
  name: string;
  text(): Promise<string>;
}

/** The texts of one Copilot session folder: events.jsonl, and the side files the pick held. */
export interface CopilotFolderTexts {
  events: string;
  /** workspace.yaml, or null when the folder had none or it could not be read. */
  workspace: string | null;
  /** rewind-file-snapshots/index.json, or null likewise. */
  snapshots: string | null;
  /** An inuse.*.lock sat beside events.jsonl. */
  live: boolean;
}

/** What a folder load hands the dialog: the same parts a file load hands it, plus the run summary. */
export interface CopilotFolderLoad {
  events: RunEvent[];
  kind: ImportKind;
  source: ImportSource;
  subagent?: SubagentTranscript;
  /** The name the import goes by. */
  label: string;
  run: ImportedRunSummary;
}

/** The name an import of a folder goes by when nothing better names it. */
const EVENTS_FILE = "events.jsonl";

/**
 * Reads the files the grouping named for one folder. events.jsonl must read; a
 * side file that cannot be read is left out, so the session still loads.
 *
 * @param files the picked files the grouping's indices point into
 * @param pick  the folder the grouping found
 * @return the texts
 */
export async function readCopilotFolder(
  files: readonly PickedText[],
  pick: PickedCopilotFolder,
): Promise<CopilotFolderTexts> {
  const side = async (i: number | null): Promise<string | null> =>
    i === null ? null : await files[i].text().catch(() => null);
  return {
    events: await files[pick.events].text(),
    workspace: await side(pick.workspace),
    snapshots: await side(pick.snapshots),
    live: pick.live,
  };
}

/** The cwd of the first ground_info frame, the importer's own reading of the folder it worked in. */
function groundCwd(events: readonly RunEvent[]): string | null {
  for (const e of events) {
    const f = e as unknown as { type?: unknown; cwd?: unknown };
    if (f.type === "ground_info" && typeof f.cwd === "string" && f.cwd !== "") return f.cwd;
  }
  return null;
}

/**
 * One Copilot session folder, loaded.
 *
 * @param texts the folder's texts
 * @return the import, named and summarised for the dialog
 * @throws Error when events.jsonl is not a session the importer reads
 */
export function loadCopilotFolder(texts: CopilotFolderTexts): CopilotFolderLoad {
  const loaded = detectAndLoad(texts.events);
  return {
    events: loaded.events,
    kind: loaded.kind,
    source: loaded.source,
    ...(loaded.subagent !== undefined ? { subagent: loaded.subagent } : {}),
    label: EVENTS_FILE,
    run: {
      workspace: groundCwd(loaded.events),
      childrenMerged: 0,
      childrenSkipped: 0,
      childrenUnrecorded: 0,
    },
  };
}
