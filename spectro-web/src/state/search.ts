// In-view search, shared by every surface that shows text: chat, text feed,
// trace. One store holds the query and which hit is current; each view finds
// its OWN matches, because a turn, a feed line and a trace row are different
// things and only the view knows how to walk itself.
//
// The store never holds the matches themselves — a view reports how many it
// found, and reads back which one is active. That keeps the store free of any
// view's shape and makes the whole thing a pure fold over two numbers.
//
// Not persisted. A search is about the thing you are reading right now; a
// query that outlives the session it was typed in is noise on the next one.

import { useSyncExternalStore } from "react";

export interface SearchState {
  /** Whether the box is showing. Escape closes; the query survives so
   *  reopening resumes where you were. */
  open: boolean;
  query: string;
  /** How many hits the active view reported for this query. */
  count: number;
  /** Which hit is current, 0-based. Always < count, or 0 when count is 0. */
  index: number;
}

const EMPTY: SearchState = { open: false, query: "", count: 0, index: 0 };

let state: SearchState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: SearchState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSearch(): SearchState {
  return state;
}

/** Read the search state in a component. */
export function useSearch(): SearchState {
  return useSyncExternalStore(subscribe, getSearch, getSearch);
}

export function openSearch(): void {
  if (state.open) return;
  emit({ ...state, open: true });
}

/** Closing keeps the query but drops the hit bookkeeping: the next view to
 *  report is not necessarily the one that reported last. */
export function closeSearch(): void {
  if (!state.open) return;
  emit({ ...state, open: false, count: 0, index: 0 });
}

/** A new query invalidates the position — the hits are different hits. */
export function setQuery(query: string): void {
  if (query === state.query) return;
  emit({ ...state, query, count: 0, index: 0 });
}

/**
 * A view reports how many matches it found for the current query.
 *
 * @param count the number of hits, never negative
 */
export function reportCount(count: number): void {
  const safe = Math.max(0, Math.floor(count));
  if (safe === state.count) return;
  // Keep the reader near where they were when the count shrinks under them
  // (a stream is still arriving, a filter changed) rather than jumping to the
  // top: clamp instead of reset.
  const index = safe === 0 ? 0 : Math.min(state.index, safe - 1);
  emit({ ...state, count: safe, index });
}

/** Step through the hits, wrapping in both directions — the last hit's "next"
 *  is the first, which is what every editor does and what fingers expect. */
export function step(delta: number): void {
  if (state.count === 0) return;
  const next = (state.index + delta + state.count * Math.abs(delta || 1)) % state.count;
  if (next === state.index) return;
  emit({ ...state, index: next });
}

/** Test seam: drop every listener and forget the query. */
export function resetSearch(): void {
  state = EMPTY;
  for (const l of listeners) l();
}

/**
 * Case-insensitive occurrences of `query` in `text`, as [start, end) offsets.
 * Empty and whitespace-only queries match nothing: a search that highlights
 * the whole document has told the reader nothing.
 *
 * @param text  the haystack
 * @param query the needle, matched literally rather than as a pattern
 * @return the ranges, in document order
 */
export function findRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hay = text.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return out;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }
}
