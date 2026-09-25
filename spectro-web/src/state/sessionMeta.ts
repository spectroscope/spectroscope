// Card 445: a stored session's title and pin, as the rail uses them.
//
// The server keeps both in a small store beside the sessions
// (~/.spectro/session-meta.json), never in a session's JSONL, and the session
// list carries them as `title`, `titleSource` and `pinned`. This module holds
// the pure folds the rail runs over the list it already fetched, and the three
// calls that change a row: rename and pin (PATCH), a suggestion for an old
// session (POST), and the existing delete.

import type { SessionMeta } from "../events";

/** The server cuts a title at this length (SessionMetaStore.TITLE_MAX_CHARS);
 *  the rename field stops at the same place. */
export const TITLE_MAX_CHARS = 80;

/** How long after a session starts the rail keeps looking for its suggested
 *  title. Longer than the server's limit on one suggestion
 *  (SessionTitles.TIME_LIMIT, 30 s), so a slow answer still lands. */
export const TITLE_WAIT_MS = 45_000;

/** How often the rail looks again while it waits. */
export const TITLE_POLL_MS = 3_000;

/** The title fields of one row, as the server answers them. */
export interface SessionTitleFields {
  title?: string;
  titleSource?: "suggested" | "manual";
  pinned?: boolean;
}

/** The list split for drawing: the pinned group, then everything else. */
export interface SessionGroupsOf {
  pinned: SessionMeta[];
  rest: SessionMeta[];
}

let doFetch: typeof fetch = (...args) => fetch(...args);

/**
 * Pinned sessions first, as their own group; each group newest first. An
 * unpinned session is back in its place by date.
 *
 * @param list the stored sessions, in any order
 * @return the two groups, new arrays
 */
export function orderSessions(list: readonly SessionMeta[]): SessionGroupsOf {
  const byDate = [...list].sort((a, b) => b.startedAt - a.startedAt);
  return {
    pinned: byDate.filter((s) => s.pinned === true),
    rest: byDate.filter((s) => s.pinned !== true),
  };
}

/**
 * Reads the title fields off a server answer, dropping anything that is not
 * one of them.
 *
 * @param body the parsed JSON of a PATCH or suggest answer
 * @return the fields, or null when the body is not an object
 */
export function titleFieldsOf(body: unknown): SessionTitleFields | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as { title?: unknown; titleSource?: unknown; pinned?: unknown };
  const out: SessionTitleFields = {};
  if (typeof b.title === "string" && b.title.trim() !== "") {
    out.title = b.title;
    if (b.titleSource === "manual" || b.titleSource === "suggested") out.titleSource = b.titleSource;
  }
  out.pinned = b.pinned === true;
  return out;
}

/**
 * One row with new title fields. A field the answer does not carry is dropped
 * from the row, which is how a cleared title falls back to the first prompt.
 *
 * @param list   the rows
 * @param id     the row to change
 * @param fields what the row says now
 * @return a new list; untouched rows are the same objects
 */
export function withTitleFields(
  list: readonly SessionMeta[],
  id: string,
  fields: SessionTitleFields,
): SessionMeta[] {
  return list.map((s) => {
    if (s.id !== id) return s;
    const next: SessionMeta = { ...s };
    delete next.title;
    delete next.titleSource;
    delete next.pinned;
    if (fields.title !== undefined) next.title = fields.title;
    if (fields.titleSource !== undefined) next.titleSource = fields.titleSource;
    if (fields.pinned === true) next.pinned = true;
    return next;
  });
}

/**
 * @param list the rows
 * @param id   the deleted session
 * @return the rows without it
 */
export function withoutSession(list: readonly SessionMeta[], id: string): SessionMeta[] {
  return list.filter((s) => s.id !== id);
}

/**
 * Whether a finished delete takes the view off the session on screen. The
 * archive bar deletes the session it shows; the row menu can delete any stored
 * one, and only the one on screen moves the view.
 *
 * @param replay    the stored session on screen, or null for the live view
 * @param deletedId the deleted session
 */
export function deletionLeavesView(replay: { id: string } | null, deletedId: string): boolean {
  return replay !== null && replay.id === deletedId;
}

/**
 * Whether the rail should look again for a suggested title: some session with
 * a first prompt and no title started less than {@link TITLE_WAIT_MS} ago.
 *
 * @param list the rows
 * @param now  the clock
 */
export function titlePending(list: readonly SessionMeta[], now: number): boolean {
  return list.some(
    (s) =>
      (s.title ?? "").trim() === "" &&
      s.firstPrompt.trim() !== "" &&
      now - s.startedAt >= 0 &&
      now - s.startedAt < TITLE_WAIT_MS,
  );
}

function sessionUrl(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}`;
}

async function patch(
  id: string,
  body: { title?: string; pinned?: boolean },
): Promise<SessionTitleFields | null> {
  try {
    const res = await doFetch(sessionUrl(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return titleFieldsOf(await res.json());
  } catch {
    return null;
  }
}

/**
 * Sets the operator's title. An empty one drops it: the row falls back to the
 * suggestion, or to the first prompt.
 *
 * @return the row's title fields after the change, or null when it did not go through
 */
export function renameSession(id: string, title: string): Promise<SessionTitleFields | null> {
  return patch(id, { title });
}

/** @return the row's title fields after the change, or null when it did not go through */
export function pinSession(id: string, pinned: boolean): Promise<SessionTitleFields | null> {
  return patch(id, { pinned });
}

/**
 * Asks the session's own model for a title, once (the menu's "Suggest a
 * title"). The server answers within its time limit either way.
 *
 * @return the row's fields and whether a new suggestion landed, or null when
 *         the call did not go through
 */
export async function suggestSessionTitle(
  id: string,
): Promise<{ fields: SessionTitleFields; suggested: boolean } | null> {
  try {
    const res = await doFetch(`${sessionUrl(id)}/title/suggest`, { method: "POST" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const fields = titleFieldsOf(body);
    if (fields === null) return null;
    return { fields, suggested: (body as { suggested?: unknown }).suggested === true };
  } catch {
    return null;
  }
}

/**
 * Deletes a stored session through the existing endpoint, which removes the
 * file, its sidecars and its title and pin. A 404 counts as deleted: the
 * session is gone either way.
 */
export async function deleteStoredSession(id: string): Promise<"deleted" | "failed"> {
  try {
    const res = await doFetch(sessionUrl(id), { method: "DELETE" });
    return res.ok || res.status === 404 ? "deleted" : "failed";
  } catch {
    return "failed";
  }
}

/** Swap the fetch seam for a test double; an empty object restores the real one. */
export function __setTestHooks(hooks: { fetch?: typeof fetch }): void {
  doFetch = hooks.fetch ?? ((...args) => fetch(...args));
}
