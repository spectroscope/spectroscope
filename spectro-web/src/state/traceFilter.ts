// What the trace is filtered to, and — the point of this module — the fact that
// it SURVIVES leaving the tab (card 184, owner: "ein filter auf solche messages
// wäre cool").
//
// The filter already existed: an `llm` chip in the category row and an
// ↑ LLM / ↓ LLM / · intern segment beside it. What did not exist was memory.
// Both lived in `useState` inside TraceView, and both of App's mount sites
// unmount that component on every tab change, so isolating the LLM traffic,
// walking to chat and coming back put every chip straight back on. A control a
// reader has to re-set on every visit reads as a control that is not there.
//
// The trace already had two tiers of memory and the filters were in neither:
// the three lenses ride designPrefs, the optional columns ride
// `spectroscope:trace.columns`. This is that same idiom, one key further.
//
// DELIBERATELY NOT PERSISTED: the free-text query. A SELECTION is a reading
// stance and belongs to the reader; a SEARCH is about one file and following a
// reader into the next one would be the trap the Reading choice already avoids
// (see traceDetail.ts). Same rule, stated once more where it applies.

import { useSyncExternalStore } from "react";

/** Which way a row flows relative to the model, as the segment offers it. */
export type LlmDirChoice = "all" | "to" | "from" | "internal";

export interface TraceFilter {
  llmDir: LlmDirChoice;
  /** The categories that are ON. Null means "every category", which is what a
   *  reader who never touched a chip has, and what a session with a category
   *  this build has not heard of must keep getting. */
  categories: readonly string[] | null;
}

const KEY = "spectroscope:trace.filter";

export const DEFAULT_TRACE_FILTER: TraceFilter = { llmDir: "all", categories: null };

const DIRS: ReadonlySet<string> = new Set(["all", "to", "from", "internal"]);

/**
 * The stored record, read defensively: a foreign or half-written value leaves
 * that half at its default rather than guessing the reader meant "show nothing",
 * which is the one wrong answer here — an empty trace looks broken.
 *
 * @param raw the stored string, or null for a reader who has never chosen
 * @return the filter to open with
 */
export function parseTraceFilter(raw: string | null): TraceFilter {
  if (raw === null) return { ...DEFAULT_TRACE_FILTER };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRACE_FILTER };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_TRACE_FILTER };
  }
  const rec = parsed as Record<string, unknown>;
  const llmDir =
    typeof rec.llmDir === "string" && DIRS.has(rec.llmDir) ? (rec.llmDir as LlmDirChoice) : "all";
  const cats = rec.categories;
  const categories = Array.isArray(cats) ? cats.filter((c): c is string => typeof c === "string") : null;
  return { llmDir, categories };
}

function readSaved(): TraceFilter {
  try {
    return parseTraceFilter(localStorage.getItem(KEY));
  } catch {
    /* no localStorage (tests) — default */
  }
  return { ...DEFAULT_TRACE_FILTER };
}

let filter: TraceFilter = readSaved();
const listeners = new Set<() => void>();

function commit(next: TraceFilter): void {
  // A fresh object per change, the same one between changes — the snapshot
  // identity is what useSyncExternalStore compares.
  filter = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function setTraceLlmDir(llmDir: LlmDirChoice): void {
  if (filter.llmDir === llmDir) return;
  commit({ ...filter, llmDir });
}

/**
 * Turn one category on or off, against the list this session actually has.
 *
 * The stored form is the ON list, and "never chosen" is null rather than the
 * full list: a reader who has touched nothing must keep seeing a category a
 * later build adds, and a stored full list would silently hide it forever.
 *
 * @param category the chip that was clicked
 * @param all      every category this build offers, for expanding the null
 */
export function toggleTraceCategory(category: string, all: readonly string[]): void {
  const on = new Set(filter.categories ?? all);
  if (on.has(category)) on.delete(category);
  else on.add(category);
  // Back to "everything" is stored as everything, not as null: the reader chose
  // it, and null means "has not chosen", which is a different fact.
  commit({ ...filter, categories: all.filter((c) => on.has(c)) });
}

/** Every chip at once, the row's own `all` / `none` buttons. */
export function setTraceCategories(categories: readonly string[]): void {
  commit({ ...filter, categories: [...categories] });
}

/** Visible for tests. */
export function currentTraceFilter(): TraceFilter {
  return filter;
}

/** Visible for tests: back to the opening state, stored record and all. */
export function resetTraceFilter(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  filter = { ...DEFAULT_TRACE_FILTER };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): TraceFilter {
  return filter;
}

export function useTraceFilter(): TraceFilter {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The categories that are ON, resolved against what this build offers.
 *
 * @param stored what the reader chose, or null for "has not chosen"
 * @param all    every category this build knows
 * @return the set the rows are filtered by
 */
export function activeCategories(stored: readonly string[] | null, all: readonly string[]): Set<string> {
  return new Set(stored ?? all);
}
