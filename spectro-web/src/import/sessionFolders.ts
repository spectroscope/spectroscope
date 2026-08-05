// The folders a recorded session left on disk, and whether to offer them.
//
// The owner, looking at an imported session: "mache auch ein button für das
// workspace folder öffnen (also den unter ~/.claude/projects...) und den
// scratchpad folder öffnen ... und auch da wo die workflow dateien liegen.
// gerne beim chat oder beim trace oder (wie der langfuse button)".
//
// The app reads these files constantly and can reach none of them: the store is
// under a dot-folder Finder hides, and the scratchpad is under a temp path
// nobody would guess. Three buttons close that.
//
// The server decides WHICH exist, because only it can stat them, and it derives
// every path from the transcript rather than accepting one — an endpoint that
// opened a path off the wire would be a way to run the machine's file manager
// on any file on the disk. This module is the client half: what to ask, what to
// show, and in which order.

/** One folder that is really there. */
export interface SessionFolder {
  /** `transcript` | `workflows` | `scratchpad` — the server's own word. */
  kind: string;
  /** Where it is, absolute. Shown in the button's tooltip, never sent back. */
  path: string;
}

/** The i18n key for a kind's label, or null for a kind we do not draw. */
export function folderLabelKey(kind: string): string | null {
  switch (kind) {
    case "transcript":
      return "folder.transcript";
    case "workflows":
      return "folder.workflows";
    case "scratchpad":
      return "folder.scratchpad";
    default:
      return null;
  }
}

/**
 * The buttons to draw, in the order a reader wants them.
 *
 * Transcript first because it is the one that always exists; scratchpad last
 * because it is the one most often swept away. A kind this build does not know
 * is dropped rather than rendered as a raw word — a newer server may name
 * something this UI has no sentence for.
 *
 * @param folders what the server said exists
 * @returns the ones to draw, ordered
 */
export function shownFolders(folders: readonly SessionFolder[]): SessionFolder[] {
  const order = ["transcript", "workflows", "scratchpad"];
  return folders
    .filter((f) => folderLabelKey(f.kind) !== null)
    .slice()
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * Asks which of a session's folders exist.
 *
 * @param storePath the transcript, store-relative; a paste or a picked file has
 *                  no address and therefore no folders to offer
 * @returns what exists, or nothing — a server that cannot answer offers no
 *          buttons, which is the same thing a session with no folders shows
 */
export async function loadSessionFolders(storePath: string): Promise<SessionFolder[]> {
  try {
    const res = await fetch(`/api/claude/transcripts/folders?path=${encodeURIComponent(storePath)}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { folders?: SessionFolder[] };
    const rows = body?.folders ?? [];
    return rows.filter((f) => typeof f?.kind === "string" && typeof f?.path === "string");
  } catch {
    return [];
  }
}

/** What a press did, for the one case worth saying out loud. */
export type OpenResult = "opened" | "missing" | "unsupported";

/**
 * Shows one of them in the machine's file manager.
 *
 * The KIND travels, never the path: the server holds the only path that is
 * allowed to be opened, and it derives it from a transcript it has already
 * fenced.
 *
 * @param storePath the transcript, store-relative
 * @param kind which folder
 * @returns what happened
 */
export async function openSessionFolder(storePath: string, kind: string): Promise<OpenResult> {
  try {
    const res = await fetch("/api/claude/transcripts/folders/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: storePath, what: kind }),
    });
    if (!res.ok) return "unsupported";
    const body = (await res.json()) as { result?: string };
    return body?.result === "opened" ? "opened" : body?.result === "missing" ? "missing" : "unsupported";
  } catch {
    return "unsupported";
  }
}
