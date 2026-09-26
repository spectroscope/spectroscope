// The fold of a stored session into a ready-to-show archive state, one-shot and
// in slices (card 431).
//
// The owner's big recorded session has 91,956 events. Folded in one go, that
// was a single task of 2,171 ms in Chrome (median of five opens, 2026-09-25),
// and the window drew no frame for the whole of it. The sliced fold does the
// same work in slices of about SLICE_BUDGET_MS and yields to the browser
// between them, so frames are drawn and a click is taken while it runs. It
// does not make the open faster; slicing adds a little time (see the budget).
//
// Card 435 adds the fold an archive is opened with: it builds no trace rows.
// On the owner's big session the trace append took 887 ms of self time in a
// 1,757 ms fold (kanban/evidence/perf-load-2026-09-25/baseline/README.md), and
// the chat does not read the trace. The deferred fold keeps what a row takes
// from the fold (the run's model, and the clock for a frame without a ts), and
// the rows are built from that when the trace is first needed, in the same
// slices, one per event and without copying the list per row.

import type { RunEvent } from "../events";
import {
  initialState,
  normalizeReplay,
  reduce,
  reduceAll,
  reduceUntraced,
  rowModelOf,
  traceRowOf,
  type TraceEntry,
  type UiState,
} from "./reducer";

/** Fold a stored session's events into a ready-to-show archive state, in one
 *  task, trace rows included. No open calls it since card 435: the tests hold
 *  the deferred folds against it, the resume folds the same way in slices
 *  ({@link foldArchiveSliced}), and an archive opens with
 *  {@link foldArchiveDeferred} or {@link foldArchiveDeferredSliced}. */
export const foldArchive = (events: RunEvent[]): UiState => normalizeReplay(reduceAll(initialState, events));

/** What an archive's trace rows take from the fold, kept so the rows can be
 *  built later: per event, the model its row wears, and for a frame without a
 *  numeric ts the clock the eager fold would have stamped it with. */
export interface TraceRecipe {
  readonly events: readonly RunEvent[];
  readonly models: ReadonlyArray<string | undefined>;
  readonly clocks: ReadonlyMap<number, number>;
}

/** An archive folded without its trace: the chat's state, with no rows, and the recipe for the rows. */
export interface DeferredFold {
  state: UiState;
  recipe: TraceRecipe;
}

/** The fold of one event into a deferred fold under way. */
function deferredStep(
  events: readonly RunEvent[],
  models: Array<string | undefined>,
  clocks: Map<number, number>,
): (state: UiState, index: number) => UiState {
  return (state, index) => {
    const event = events[index];
    models.push(rowModelOf(state, event));
    if (typeof (event as { ts?: unknown }).ts !== "number") clocks.set(index, Date.now());
    return reduceUntraced(state, event);
  };
}

/** Fold a stored session's events into a ready-to-show archive state without
 *  trace rows, in one task. The state equals {@link foldArchive}'s in every
 *  field but `trace` and `traceDropped`. */
export function foldArchiveDeferred(events: RunEvent[]): DeferredFold {
  const models: Array<string | undefined> = [];
  const clocks = new Map<number, number>();
  const step = deferredStep(events, models, clocks);
  let state = initialState;
  for (let i = 0; i < events.length; i++) state = step(state, i);
  return { state: normalizeReplay(state), recipe: { events, models, clocks } };
}

/** How long one slice folds before it yields, in milliseconds. A slice ends
 *  after the first event that reaches the budget, so it can run over by one
 *  event. Every yield costs a little, so fewer slices cost less: on the
 *  owner's big session (2026-09-25) a 12 ms budget made the open 12 to 28 %
 *  slower than the one-shot fold, 24 ms between 0.4 % faster and 5.7 %
 *  slower, with gaps between frames of 26 to 34 ms. */
export const SLICE_BUDGET_MS = 24;

export interface SlicedFoldOptions {
  /** Whether this fold is still wanted. Read before every slice: a later
   *  navigation makes it false, and the fold stops without another slice. */
  isCurrent: () => boolean;
  /** Told the events folded so far and the total: once before the first slice
   *  and once after each. */
  onProgress?: (folded: number, total: number) => void;
  budgetMs?: number;
  now?: () => number;
  yieldToBrowser?: () => Promise<void>;
}

/**
 * Yield to the browser: resolve in a new task, so it can draw a frame and take
 * input before the next slice.
 *
 * A MessageChannel message rather than a timer: a timer nested five deep is
 * clamped to at least 4 ms, and a page in the background has its timers
 * throttled, while a posted message runs as soon as the browser gets to it.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * The fold of {@link foldArchive}, in slices that yield to the browser before
 * each one, the first included, so the task that parsed the events and the
 * first slice are two tasks. A slice ends after the first event that reaches
 * `budgetMs`, so one slow event can carry it past the budget.
 *
 * The events go through the same `reduce` in the same order, so the state is
 * the one `foldArchive` returns for the same list.
 *
 * @return the archive state, or null when `isCurrent` said no before a slice
 */
export async function foldArchiveSliced(
  events: RunEvent[],
  options: SlicedFoldOptions,
): Promise<UiState | null> {
  let state = initialState;
  const whole = await runInSlices(events.length, options, (index) => {
    state = reduce(state, events[index]);
  });
  return whole ? normalizeReplay(state) : null;
}

/**
 * {@link foldArchiveDeferred} in the slices of {@link foldArchiveSliced}: the
 * fold an archive is opened with (card 435).
 *
 * @return the state and the recipe of its rows, or null when `isCurrent` said no before a slice
 */
export async function foldArchiveDeferredSliced(
  events: RunEvent[],
  options: SlicedFoldOptions,
): Promise<DeferredFold | null> {
  const models: Array<string | undefined> = [];
  const clocks = new Map<number, number>();
  const step = deferredStep(events, models, clocks);
  let state = initialState;
  const whole = await runInSlices(events.length, options, (index) => {
    state = step(state, index);
  });
  return whole ? { state: normalizeReplay(state), recipe: { events, models, clocks } } : null;
}

/**
 * Build an archive's trace rows from its recipe, in the same slices: one row
 * per event, in order, each the row {@link reduce} appended in the eager fold,
 * with seq counted from 1. The llm-wire merge is the caller's (state/archiveTrace.ts).
 *
 * @return the rows, or null when `isCurrent` said no before a slice
 */
export async function buildTraceSliced(
  recipe: TraceRecipe,
  options: SlicedFoldOptions,
): Promise<TraceEntry[] | null> {
  const rows: TraceEntry[] = [];
  let at = 0;
  const clock = (): number => recipe.clocks.get(at) ?? 0;
  const whole = await runInSlices(recipe.events.length, options, (index) => {
    at = index;
    rows.push({ seq: index + 1, ...traceRowOf(recipe.events[index], recipe.models[index], clock) });
  });
  return whole ? rows : null;
}

/**
 * Run `step` over the indices 0 to `total - 1` in slices that yield to the
 * browser before each one, the first included. A slice ends after the first
 * step that reaches `budgetMs`. `onProgress` hears the count once before the
 * first slice and once after each.
 *
 * @return true when every step ran, false when `isCurrent` said no before a slice
 */
export async function runInSlices(
  total: number,
  options: SlicedFoldOptions,
  step: (index: number) => void,
): Promise<boolean> {
  const budget = options.budgetMs ?? SLICE_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const pause = options.yieldToBrowser ?? yieldToBrowser;
  let done = 0;
  options.onProgress?.(0, total);
  do {
    await pause();
    if (!options.isCurrent()) return false;
    const until = now() + budget;
    while (done < total) {
      step(done);
      done += 1;
      if (now() >= until) break;
    }
    options.onProgress?.(done, total);
  } while (done < total);
  return true;
}
