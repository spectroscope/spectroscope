// The trace of an archive, built when it is first needed (card 435).
//
// "S1 als eigene Karte" (owner, 2026-09-25). An archive opens with a fold that
// builds no trace rows (state/archiveFold.ts); this store builds them when the
// trace tab opens or when the warm-up asks, in the slices of card 431's fold,
// and merges the stored session's llm-wire index into them. App reads the
// rows of the record on screen through `useRecordedTrace`, the one accessor:
// the live fold's own rows, or an archive's once built. The reads that stay
// outside it (the reducer's own append and live window, the resume's merge)
// are named in components/archiveTraceWiring.drift.test.ts. The count on the
// trace tab comes from `useArchiveRowCount`, which knows it before the rows
// are built: from the start without an index to ask, once the index is in
// with one.

import { useSyncExternalStore } from "react";
import { exchangeXidOf, mergeLlmExchanges, rowsMergedFrom, type LlmExchangeMeta } from "../wire/llmWire";
import { buildTraceSliced, type SlicedFoldOptions, type TraceRecipe } from "./archiveFold";
import { createOpenProgress, type OpenProgress } from "./openProgress";
import type { TraceEntry, UiState } from "./reducer";

/** The trace of one archive on screen. */
export interface ArchiveTrace {
  /** Its number: the ticket its build reports its count under. */
  readonly id: number;
  /** The stored session whose llm-wire index the rows merge, or null when
   *  there is none to ask (an import, a scenario). */
  readonly indexSession: string | null;
  /** The rows the trace has before an index adds any: one per event. */
  readonly leastRows: number;
  /** The rows once built and merged, or null. The same array from then on. */
  read(): TraceEntry[] | null;
  /** Told once, when the rows land. */
  subscribe(listener: () => void): () => void;
  /** How many rows the trace has, known before they are built: from the start
   *  without an `indexSession`, and from the first {@link supplyIndex} with
   *  one. Null before that. */
  rowCount(): number | null;
  /** Told once, when {@link rowCount} becomes known after the index. */
  subscribeCount(listener: () => void): () => void;
  /** Start the build. Only the first call starts one; after {@link stop}, none does. */
  request(): void;
  /** Hand in the llm-wire index. Only the first call counts. Rows of a trace
   *  with an `indexSession` land after it. */
  supplyIndex(exchanges: readonly LlmExchangeMeta[]): void;
  /** The archive left the screen: the build runs no further slice. */
  stop(): void;
}

/** The store the builds report their count into, read by the sign over the trace tab. */
export const traceProgress: OpenProgress = createOpenProgress();

export interface ArchiveTraceOptions {
  /** The budget, clock and yield of the build's slices; card 431's by default. */
  slicing?: Pick<SlicedFoldOptions, "budgetMs" | "now" | "yieldToBrowser">;
  /** Where the build reports its count; {@link traceProgress} by default. */
  progress?: OpenProgress;
}

let lastId = 0;

/**
 * The lazy trace of an archive folded with a deferred fold.
 *
 * @param recipe what the fold kept for the rows
 * @param indexSession the stored session whose llm-wire index the rows wait
 *   for and merge, or null to build them without one
 */
export function createArchiveTrace(
  recipe: TraceRecipe,
  indexSession: string | null,
  options: ArchiveTraceOptions = {},
): ArchiveTrace {
  const id = ++lastId;
  const progress = options.progress ?? traceProgress;
  const listeners = new Set<() => void>();
  const countListeners = new Set<() => void>();
  let rows: TraceEntry[] | null = null;
  // With no index to ask, nothing is merged: one row per event.
  let count: number | null = indexSession === null ? recipe.events.length : null;
  let started = false;
  let stopped = false;
  let handIn: (exchanges: readonly LlmExchangeMeta[]) => void = () => {};
  const index: Promise<readonly LlmExchangeMeta[]> =
    indexSession === null
      ? Promise.resolve([])
      : new Promise((resolve) => {
          handIn = resolve;
        });

  const build = async (): Promise<void> => {
    const built = await buildTraceSliced(recipe, {
      ...options.slicing,
      isCurrent: () => !stopped,
      onProgress: (done, total) => progress.report(id, done, total),
    });
    if (built === null) return;
    const exchanges = await index;
    if (stopped) return;
    // The merge renumbers every row; nobody holds a seq yet, because the
    // rows have not been shown (the rule mergeLlmExchanges states).
    rows = exchanges.length === 0 ? built : mergeLlmExchanges(built, exchanges);
    for (const listener of listeners) listener();
  };

  return {
    id,
    indexSession,
    leastRows: recipe.events.length,
    read: () => rows,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rowCount: () => (rows !== null ? rows.length : count),
    subscribeCount(listener) {
      countListeners.add(listener);
      return () => {
        countListeners.delete(listener);
      };
    },
    request() {
      if (started || stopped) return;
      started = true;
      void build();
    },
    supplyIndex(exchanges) {
      const take = handIn;
      handIn = () => {};
      if (count === null) {
        count = builtTraceLength(recipe, exchanges);
        for (const listener of countListeners) listener();
      }
      take(exchanges);
    },
    stop() {
      stopped = true;
    },
  };
}

/**
 * How many rows the build gives for `recipe` once `exchanges` are merged,
 * without building them. A row carries its frame's type and the frame itself
 * as its payload (`traceRowOf` in state/reducer.ts), so the xids the merge
 * finds in the rows are those of the recorded `llm_exchange` frames.
 */
function builtTraceLength(recipe: TraceRecipe, exchanges: readonly LlmExchangeMeta[]): number {
  if (exchanges.length === 0) return recipe.events.length;
  const held = new Set<string>();
  for (const event of recipe.events) {
    const xid = exchangeXidOf((event as { type: string }).type, event);
    if (xid !== null) held.add(xid);
  }
  return recipe.events.length + rowsMergedFrom(held, exchanges);
}

const NO_SUBSCRIPTION = (): (() => void) => () => {};
const NO_ROWS_YET = (): null => null;

/**
 * The trace rows of the record on screen: the one place App reads them.
 *
 * @param live the live fold
 * @param archive the lazy trace of the archive on screen, or null for the live view
 * @return the live fold's rows; for an archive, its rows once built and null before
 */
export function useRecordedTrace(live: UiState, archive: ArchiveTrace | null): TraceEntry[] | null {
  const read = archive?.read ?? NO_ROWS_YET;
  const built = useSyncExternalStore(archive?.subscribe ?? NO_SUBSCRIPTION, read, read);
  return archive === null ? live.trace : built;
}

const NO_COUNT_YET = (): null => null;

/**
 * The row count of an archive's trace for its tab, before the rows are built.
 *
 * @param archive the lazy trace of the archive on screen, or null for the live view
 * @return the archive's count once known, else null; null for the live view
 */
export function useArchiveRowCount(archive: ArchiveTrace | null): number | null {
  const read = archive?.rowCount ?? NO_COUNT_YET;
  return useSyncExternalStore(archive?.subscribeCount ?? NO_SUBSCRIPTION, read, read);
}
