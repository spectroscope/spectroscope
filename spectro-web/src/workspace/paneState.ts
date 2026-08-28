// What the Files pane may honestly show. The pane used to have two states,
// "tree" and "server unreachable", and it reached the first one before any run
// by asking a sessionless /api/files, which answered with the server's own
// working directory. Three things were being conflated: a real tree, a folder
// that does not exist yet, and a dead server.
//
// Pure module: the announcement and the fetch outcome go in, one discriminated
// state comes out. WorkspaceTab is wiring.

import { t, type Lang } from "../i18n/i18n";

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

/**
 * Whose folder a tree belongs to. "session" is the workspace a run resolved;
 * "prospective" is the folder a run started now WOULD use, listed before any
 * session exists. They are drawn the same and must not read the same: the pane
 * may not claim a session that has not started.
 */
export type TreeScope = "session" | "prospective";

export type PaneState =
  | { kind: "tree"; scope: TreeScope }
  /** Resolved, asked, no answer back yet. The folder exists; nothing is claimed about it. */
  | { kind: "loading"; message: string }
  | { kind: "pending"; message: string; path: string | null }
  | { kind: "unreachable"; message: string };

/**
 * Whether the announcement names a folder that is already on disk, before any
 * run has resolved one.
 *
 * <p>The pane used to refuse a tree for every unresolved announcement, which is
 * right for "random" — that folder is keyed by a session id nobody has minted,
 * so there is nothing to ask about. It was wrong for the modes that name a
 * concrete path the announcement itself reports as existing: the app knew the
 * folder, printed the folder, and showed nothing in it until the operator
 * toggled the chooser to random and back, which minted a session and resolved a
 * workspace. That toggle was never the fix, it was the workaround.</p>
 *
 * @param announcement the latest workspace_info frame, or null before any
 * @return true when a tree of the first run's folder can honestly be drawn
 */
export function listableBeforeTheFirstRun(announcement: WorkspaceAnnouncement | null): boolean {
  if (announcement === null || announcement.resolved) {
    return false;
  }
  return (
    announcement.mode !== "random" &&
    typeof announcement.path === "string" &&
    announcement.path.length > 0 &&
    announcement.exists === true
  );
}

/**
 * The workspace an IMPORTED run recorded, as a display-only pane (card 291).
 *
 * An import replays somebody else's session: no workspace_info frame ever
 * arrives, and the ordinary pending state said "no workspace yet, the first
 * run creates it" — a sentence about THIS machine's future, shown over a run
 * that already happened somewhere else. The recorded cwd is what the file
 * itself says, labelled as recorded; nothing on disk is resolved or created
 * from it (that neighbourhood is card 288's). The moment a real announcement
 * exists, the live answer wins and this says nothing.
 *
 * @param recordedCwd the cwd the imported records carried, or nothing
 * @param announcement the latest workspace_info frame, or null before any
 * @param lang the UI-chrome language
 * @return the pane to show instead of paneState's, or null to defer to it
 */
export function recordedWorkspace(
  recordedCwd: string | null | undefined,
  announcement: WorkspaceAnnouncement | null,
  lang: Lang,
): PaneState | null {
  if (recordedCwd == null || recordedCwd === "" || announcement !== null) return null;
  return { kind: "pending", path: recordedCwd, message: t(lang, "ws.recorded") };
}

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

  // Nothing announced at all: nothing to say beyond what will happen.
  if (announcement === null) {
    return pending(null, lang);
  }

  // Nothing resolved yet. Where no folder is named, or the named one is not on
  // disk, say what will happen and draw nothing.
  if (!announcement.resolved) {
    if (!listableBeforeTheFirstRun(announcement)) {
      return pending(announcement, lang);
    }
    // A named folder that exists: the tree is the first run's folder, and the
    // header says so. The 404 and 409 answers below are the server declining to
    // list it, and the pane falls back to naming it rather than to a tree of
    // nothing or a blamed server.
    if (outcome === null) {
      return { kind: "loading", message: de ? "lädt …" : "loading …" };
    }
    if (outcome.kind === "status") {
      if (outcome.status === NO_FOLDER) {
        return {
          kind: "pending",
          path: announcement.path ?? null,
          message: de ? "diesen ordner gibt es nicht mehr" : "this folder is gone",
        };
      }
      if (outcome.status < 200 || outcome.status >= 300) {
        return pending(announcement, lang);
      }
    }
    return { kind: "tree", scope: "prospective" };
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
  return { kind: "tree", scope: "session" };
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
