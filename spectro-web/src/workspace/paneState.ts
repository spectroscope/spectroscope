// What the Files pane may honestly show. The pane used to have two states,
// "tree" and "server unreachable", and it reached the first one before any run
// by asking a sessionless /api/files, which answered with the server's own
// working directory. Three things were being conflated: a real tree, a folder
// that does not exist yet, and a dead server.
//
// Pure module: the announcement and the fetch outcome go in, one discriminated
// state comes out. WorkspaceTab is wiring.

import type { Lang } from "../i18n/i18n";

/** The mode a run started right now would use, mirrors the server's frame. */
export type WorkspaceMode = "random" | "default" | "set";

/**
 * The workspace_info frame. Sent on connect as PROSPECTIVE (resolved false:
 * what would happen if you ran now, nothing created yet) and again for real
 * once a run resolves the folder.
 */
export interface WorkspaceAnnouncement {
  resolved: boolean;
  mode: WorkspaceMode;
  configured: boolean;
  /** Present only once a session exists. */
  sessionId?: string;
  /** Absent for "random": the folder is keyed by a session id not yet minted. */
  path?: string;
  /** Whether the named folder is on disk already. */
  exists?: boolean;
}

/** What came back from GET /api/files, kept separate from why. */
export type FetchOutcome = { kind: "ok" } | { kind: "status"; status: number } | { kind: "offline" };

export type PaneState =
  | { kind: "tree" }
  /** Resolved, asked, no answer back yet. The folder exists; nothing is claimed about it. */
  | { kind: "loading"; message: string }
  | { kind: "pending"; message: string; path: string | null }
  | { kind: "unreachable"; message: string };

/** 409: the request carries no resolved workspace. 404: the folder is not there yet. */
const NO_WORKSPACE = 409;
const NO_FOLDER = 404;

/**
 * The one place that decides what the pane may claim.
 *
 * @param announcement the latest workspace_info frame, or null before any
 * @param outcome the last /api/files result, or null when none was attempted
 * @param lang the UI-chrome language
 */
export function paneState(
  announcement: WorkspaceAnnouncement | null,
  outcome: FetchOutcome | null,
  lang: Lang,
): PaneState {
  const de = lang === "de";

  // A dead server is a dead server whatever the announcement said.
  if (outcome !== null && outcome.kind === "offline") {
    return { kind: "unreachable", message: de ? "server nicht erreichbar" : "server unreachable" };
  }

  // Nothing resolved yet: say what will happen, and never draw a tree. Without
  // a session id there is nothing to ask about, so there is nothing to show.
  if (announcement === null || !announcement.resolved) {
    return pending(announcement, lang);
  }

  // Resolved and still waiting for /api/files. The run has already made this
  // folder, so the prospective wording below would be a false claim, and this
  // is the normal path: WorkspaceTab remounts on every return to the tab and
  // starts again from no outcome.
  if (outcome === null) {
    return { kind: "loading", message: de ? "lädt …" : "loading …" };
  }
  if (outcome.kind === "status") {
    if (outcome.status === NO_FOLDER) {
      // The server has the record and the folder is not a directory: deleted,
      // renamed, or on a volume that went away. Nothing here is about a run
      // that has not happened yet.
      return {
        kind: "pending",
        path: announcement.path ?? null,
        message: de ? "diesen ordner gibt es nicht mehr" : "this folder is gone",
      };
    }
    if (outcome.status === NO_WORKSPACE) {
      // A different fact: the folder may well be fine, the server just no
      // longer knows which one belongs to this chat. Its record is in memory
      // and a restart drops it.
      return {
        kind: "pending",
        path: announcement.path ?? null,
        message: de
          ? "der server kennt den ordner dieses chats nicht mehr"
          : "the server no longer knows this chat's folder",
      };
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      return {
        kind: "unreachable",
        message: de ? `server antwortete ${outcome.status}` : `server answered ${outcome.status}`,
      };
    }
  }
  return { kind: "tree" };
}

/** The waiting state, worded for the mode actually in effect. */
function pending(announcement: WorkspaceAnnouncement | null, lang: Lang): PaneState {
  const de = lang === "de";
  const path = announcement?.path ?? null;

  if (announcement === null) {
    return {
      kind: "pending",
      path: null,
      message: de
        ? "noch kein arbeitsordner, der erste lauf legt ihn an"
        : "no workspace yet, the first run creates it",
    };
  }
  // Exists first. This branch used to sit below the mode test, which made it
  // unreachable for the default install: its mode is "random", so a folder that
  // was already on disk was still described as one the first run would create.
  if (announcement.exists === true) {
    return {
      kind: "pending",
      path,
      message: de ? "in diesem ordner arbeitet der erste lauf" : "the first run works in this folder",
    };
  }
  if (announcement.mode === "random") {
    return {
      kind: "pending",
      path,
      message: de
        ? "ein frischer ordner für diesen chat, angelegt beim ersten lauf"
        : "a fresh folder for this chat, created when the first run starts",
    };
  }
  return {
    kind: "pending",
    path,
    message: de ? "diesen ordner legt der erste lauf an" : "this folder is created when the first run starts",
  };
}
