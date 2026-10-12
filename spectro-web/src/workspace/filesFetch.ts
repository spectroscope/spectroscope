// The Files pane's answers, one query at a time (card 520).
//
// Pure fold, WorkspaceTab is wiring. The pane asks GET /api/files for one
// query; a click to another stored session changes the query, and the pane
// starts again from no answer, so the last session's tree is never drawn
// under the new one's name. The dedupe that keeps the 5 s poll calm (card 89)
// is per query: an answer identical to one seen for an earlier visit of the
// same query still draws the tree, which was cleared on the way out.

import type { FetchOutcome } from "./paneState";

export interface FilesFetch<T> {
  /** The query the pane asks now, or null when it asks nothing. */
  readonly query: string | null;
  /** The last answer's text for this query, the dedupe key. */
  readonly lastJson: string;
  readonly tree: T | null;
  readonly outcome: FetchOutcome | null;
}

/** Nothing asked, nothing answered. */
export function emptyFetch<T>(): FilesFetch<T> {
  return { query: null, lastJson: "", tree: null, outcome: null };
}

/**
 * The pane asks for `query` now. The same query keeps everything; another
 * one starts from no answer.
 */
export function askFor<T>(state: FilesFetch<T>, query: string | null): FilesFetch<T> {
  if (state.query === query) return state;
  return { query, lastJson: "", tree: null, outcome: null };
}

/**
 * An answer for `query`. Dropped when the pane has moved on; kept as it is
 * when it says what the last one said.
 */
export function answered<T>(state: FilesFetch<T>, query: string, json: string, tree: T): FilesFetch<T> {
  if (state.query !== query) return state;
  const ok: FetchOutcome = { kind: "ok" };
  if (json === state.lastJson) {
    return state.outcome?.kind === "ok" ? state : { ...state, outcome: ok };
  }
  return { ...state, lastJson: json, tree, outcome: ok };
}

/** A status or a network failure for `query`; dropped when the pane has moved on. */
export function failed<T>(state: FilesFetch<T>, query: string, outcome: FetchOutcome): FilesFetch<T> {
  if (state.query !== query) return state;
  return { ...state, outcome };
}
